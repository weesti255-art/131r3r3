import { strict as assert } from "node:assert";
import type { FastifyInstance } from "fastify";
import type { Campaign, Task } from "../../shared/contracts.js";
import type { Sender, SendOutcome } from "../../server/sender/types.js";
import { Worker } from "../../server/worker-core.js";
import {
  jsonRequest,
  responseJson,
  uuid,
  type OpenedTestApp,
} from "./helpers.js";

export async function createGroup(
  app: FastifyInstance,
  name: string,
  limitCount = 15,
  periodHours = 24
) {
  const response = await jsonRequest(app, "POST", "/api/groups", {
    name,
    color: "blue",
    limitCount,
    periodHours,
    requestKey: uuid(),
  });
  assert.equal(response.statusCode, 201, response.body);
  return responseJson<{ id: string }>(response).id;
}

export async function importAccounts(
  app: FastifyInstance,
  groupId: string,
  emails: string[],
  limitCount: number,
  periodHours: number,
  duplicateAction: "keep" | "move" = "keep"
) {
  const response = await jsonRequest(app, "POST", "/api/accounts/import", {
    text: emails.map((email) => `${email} | app-password-${email}`).join("\n"),
    format: "lines",
    groupId,
    limitCount,
    periodHours,
    duplicateAction,
    requestKey: uuid(),
  });
  assert.equal(response.statusCode, 200, response.body);
  return responseJson<{
    added: number;
    duplicatesKept: number;
    duplicatesMoved: number;
    errorCount: number;
  }>(response);
}

export async function createCampaign(
  app: FastifyInstance,
  groupId: string,
  recipients: string[],
  name = "Кампания"
) {
  const created = await jsonRequest(app, "POST", "/api/campaigns", {
    name,
    groupId,
    subject: "Тема",
    body: "Текст письма",
    senderName: "",
    requestKey: uuid(),
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = responseJson<{ id: string }>(created).id;
  const loaded = await jsonRequest(
    app,
    "PUT",
    `/api/campaigns/${id}/recipients`,
    {
      text: recipients.join("\n"),
      format: "lines",
      requestKey: uuid(),
    }
  );
  assert.equal(loaded.statusCode, 200, loaded.body);
  return id;
}

export async function startCampaign(app: FastifyInstance, id: string) {
  const response = await jsonRequest(
    app,
    "POST",
    `/api/campaigns/${id}/start`,
    { requestKey: uuid() }
  );
  assert.equal(response.statusCode, 200, response.body);
  return responseJson<Campaign>(response);
}

export async function getCampaign(app: FastifyInstance, id: string) {
  const response = await jsonRequest(app, "GET", `/api/campaigns/${id}`);
  assert.equal(response.statusCode, 200, response.body);
  return responseJson<Campaign>(response);
}

export async function listTasks(
  app: FastifyInstance,
  id: string,
  status = "all"
) {
  const response = await jsonRequest(
    app,
    "GET",
    `/api/campaigns/${id}/tasks?pageSize=100&status=${status}`
  );
  assert.equal(response.statusCode, 200, response.body);
  return responseJson<{ items: Task[]; total: number }>(response).items;
}

export async function accountByEmail(app: FastifyInstance, email: string) {
  const response = await jsonRequest(
    app,
    "GET",
    `/api/accounts?q=${encodeURIComponent(email)}&pageSize=5`
  );
  assert.equal(response.statusCode, 200, response.body);
  const account = responseJson<{
    items: Array<{
      email: string;
      status: string;
      quotaUsed: number;
      quotaRemaining: number;
      nextFreeAt: string | null;
      id: string;
      groupId: string;
    }>;
  }>(response).items.find((item) => item.email === email);
  assert.ok(account, `account ${email} missing`);
  return account;
}

/** Programmable sender: outcomes by recipient, optional hold to model in-flight sends. */
export class ScriptedSender implements Sender {
  readonly kind = "test" as const;
  outcomes = new Map<string, SendOutcome>();
  defaultOutcome: SendOutcome = { kind: "accepted", response: "250 scripted" };
  calls: Array<{ account: string; to: string }> = [];
  private holds = new Map<string, () => void>();
  holdAll = false;

  async check() {
    return { kind: "ok" as const, response: "scripted" };
  }

  async send(credentials: { email: string }, message: { to: string }) {
    this.calls.push({ account: credentials.email, to: message.to });
    if (this.holdAll) {
      await new Promise<void>((resolve) => this.holds.set(message.to, resolve));
    }
    return this.outcomes.get(message.to) ?? this.defaultOutcome;
  }

  release(to?: string) {
    for (const [key, resolve] of [...this.holds]) {
      if (!to || key === to) {
        this.holds.delete(key);
        resolve();
      }
    }
  }

  get holding() {
    return this.holds.size;
  }
}

export function makeWorker(
  opened: OpenedTestApp,
  sender: Sender,
  concurrency = 1
) {
  return new Worker({
    pool: opened.pool,
    config: opened.config,
    keys: opened.keys,
    sender,
    concurrency,
    log: () => undefined,
  });
}

/**
 * Runs passes until nothing starts. Short "busy" back-offs (a few seconds) are
 * waited out so tests do not depend on the worker's real sleep loop.
 */
export async function drain(worker: Worker, passes = 20, settleMs = 2500) {
  let idle = 0;
  for (let index = 0; index < passes; index++) {
    const started = await worker.pass();
    await worker.drain();
    if (started > 0) {
      idle = 0;
      continue;
    }
    idle += 1;
    if (idle > 1 || settleMs === 0) break;
    await sleep(settleMs);
  }
  await worker.drain();
}

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
