import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { clock } from "./clock.js";
import type { Config } from "./config.js";
import type { KeyStore } from "./crypto.js";
import { loadCredentials } from "./accounts.js";
import { recordEvent } from "./events.js";
import { beginAttempt, finishAttempt, readyCampaigns, recoverStale, reserveNext, type StartedAttempt } from "./queue.js";
import { loadSettingsRow } from "./repository.js";
import { createMailSender } from "./sender/mail.js";
import { createTestSender } from "./sender/test.js";
import type { Sender } from "./sender/types.js";

export interface WorkerOptions {
  pool: Pool;
  config: Config;
  keys: KeyStore;
  /** Test hook: overrides the sender chosen from settings. */
  sender?: Sender;
  concurrency?: number;
  workerId?: string;
  log?: (message: string) => void;
}

const RETRYABLE = new Set(["40P01", "40001"]);

async function withRetry<T>(action: () => Promise<T>, attempts = 3): Promise<T> {
  for (let index = 1; ; index++) {
    try {
      return await action();
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (!RETRYABLE.has(code ?? "") || index >= attempts) throw error;
    }
  }
}

/**
 * One sending process. Several may run against the same database: they
 * coordinate only through rows, never through process memory.
 */
export class Worker {
  readonly id: string;
  private readonly pool: Pool;
  private readonly keys: KeyStore;
  private readonly config: Config;
  private readonly log: (message: string) => void;
  private readonly concurrency: number;
  private readonly senderOverride?: Sender;
  private senderKind: "test" | "mail" | null = null;
  private sender: Sender | null = null;
  private inFlight = new Set<Promise<void>>();
  private stopped = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private delayMs = 300;

  constructor(options: WorkerOptions) {
    this.id = options.workerId ?? randomUUID();
    this.pool = options.pool;
    this.keys = options.keys;
    this.config = options.config;
    this.log = options.log ?? ((message) => console.log(`[worker ${this.id.slice(0, 8)}] ${message}`));
    this.concurrency = options.concurrency ?? options.config.workerConcurrency;
    this.senderOverride = options.sender;
  }

  async register() {
    const settings = await loadSettingsRow(this.pool);
    await this.pool.query(
      `INSERT INTO workers(id, hostname, pid, sender_kind, started_at, last_heartbeat_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (id) DO UPDATE SET last_heartbeat_at = EXCLUDED.last_heartbeat_at, stopped_at = NULL`,
      [this.id, hostname(), process.pid, this.senderOverride?.kind ?? settings.sender_kind, clock.now()]
    );
    await recordEvent(this.pool, {
      kind: "worker_started",
      title: "Процесс отправки запущен",
      detail: `${hostname()} pid ${process.pid}, параллельных отправок: ${this.concurrency}.`,
    });
  }

  async heartbeat() {
    await this.pool.query("UPDATE workers SET last_heartbeat_at = $2 WHERE id = $1", [this.id, clock.now()]);
  }

  private async aliveWorkerIds() {
    const settings = await loadSettingsRow(this.pool);
    const result = await this.pool.query<{ id: string }>(
      "SELECT id FROM workers WHERE stopped_at IS NULL AND last_heartbeat_at > $1::timestamptz - make_interval(secs => $2)",
      [clock.now(), settings.heartbeat_stale_seconds]
    );
    const ids = new Set(result.rows.map((row) => row.id));
    ids.add(this.id);
    return [...ids];
  }

  /** Startup and periodic recovery of reservations and interrupted sends. */
  async recover() {
    return recoverStale(this.pool, await this.aliveWorkerIds());
  }

  private async currentSender(): Promise<Sender> {
    if (this.senderOverride) return this.senderOverride;
    const settings = await loadSettingsRow(this.pool);
    this.delayMs = settings.test_sender_delay_ms;
    const kind = this.config.mode === "demo" || this.config.preview ? "test" : settings.sender_kind;
    if (this.sender && this.senderKind === kind) return this.sender;
    this.senderKind = kind;
    this.sender =
      kind === "mail"
        ? createMailSender(this.config.smtpOverride)
        : createTestSender({ delayMs: () => this.delayMs });
    await this.pool.query("UPDATE workers SET sender_kind = $2 WHERE id = $1", [this.id, kind]);
    return this.sender;
  }

  /** One fair pass over ready campaigns; returns how many sends were started. */
  async pass(): Promise<number> {
    let started = 0;
    const free = this.concurrency - this.inFlight.size;
    if (free <= 0) return 0;
    const campaigns = await readyCampaigns(this.pool);
    for (const campaignId of campaigns) {
      if (started >= free) break;
      const reservation = await withRetry(() => reserveNext(this.pool, campaignId, this.id));
      if (!reservation) continue;
      const begun = await withRetry(() => beginAttempt(this.pool, reservation, this.id));
      if (begun.kind !== "started") {
        if (begun.kind === "waiting") this.log(`campaign ${campaignId.slice(0, 8)} waiting: ${begun.reason}`);
        continue;
      }
      started++;
      const job = this.deliver(begun.attempt).finally(() => this.inFlight.delete(job));
      this.inFlight.add(job);
    }
    return started;
  }

  private async deliver(attempt: StartedAttempt) {
    const sender = await this.currentSender();
    let outcome;
    try {
      const credentials = await loadCredentials(this.pool, this.keys, attempt.accountId);
      if (credentials.demo && sender.kind === "mail") {
        outcome = {
          kind: "rejected" as const,
          category: "auth" as const,
          code: null,
          message: "У демонстрационного аккаунта нет пароля приложения",
        };
      } else {
        outcome = await sender.send(credentials, {
          from: { email: credentials.email, name: attempt.senderName },
          to: attempt.email,
          subject: attempt.subject,
          text: attempt.body,
        });
      }
    } catch (error) {
      // Adapter failure before the message was handed over is not a lost letter.
      outcome = {
        kind: "rejected" as const,
        category: "connection" as const,
        code: null,
        message: `Внутренняя ошибка отправителя: ${(error as Error).message}`.slice(0, 500),
      };
    }
    try {
      const result = await withRetry(() => finishAttempt(this.pool, { attempt, outcome }), 5);
      this.log(`task ${attempt.taskId} → ${result}`);
    } catch (error) {
      this.log(`failed to record outcome for task ${attempt.taskId}: ${(error as Error).message}`);
    }
  }

  async drain() {
    await Promise.allSettled([...this.inFlight]);
  }

  async run(signal?: AbortSignal) {
    await this.register();
    await this.recover().catch((error) => this.log(`recovery failed: ${(error as Error).message}`));
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat().catch(() => this.log("heartbeat failed: database unavailable"));
    }, 15000);
    let lastRecovery = Date.now();
    signal?.addEventListener("abort", () => {
      this.stopped = true;
    });
    while (!this.stopped) {
      let started = 0;
      try {
        started = await this.pass();
        if (Date.now() - lastRecovery > 30000) {
          lastRecovery = Date.now();
          await this.recover();
        }
      } catch (error) {
        // Without the database no new external send may start; wait and retry.
        this.log(`pass failed: ${(error as Error).message}`);
        await sleep(3000);
      }
      if (started === 0) await sleep(1000);
    }
    await this.shutdown();
  }

  async shutdown() {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.drain();
    await this.pool
      .query("UPDATE workers SET stopped_at = $2 WHERE id = $1", [this.id, clock.now()])
      .catch(() => undefined);
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
