import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { RejectCategory } from "../shared/contracts.js";
import { clock } from "./clock.js";
import { transaction } from "./database.js";
import { recordEvent } from "./events.js";
import { loadSettingsRow, type SettingsRow } from "./repository.js";
import type { SendOutcome } from "./sender/types.js";

export interface Reservation {
  taskId: string;
  campaignId: string;
  email: string;
  ownerToken: string;
  attemptNumber: number;
}

export interface StartedAttempt extends Reservation {
  attemptId: string;
  accountId: string;
  accountEmail: string;
  quotaUsageId: string;
  subject: string;
  body: string;
  senderName: string;
}

export type BeginResult =
  | { kind: "started"; attempt: StartedAttempt }
  | { kind: "waiting"; reason: string; until: Date | null }
  | { kind: "released"; reason: string };

const ACTIVE = ["pending", "reserved", "sending", "unclear"];

/** Fair pass: one task per ready campaign, oldest campaign first. */
export async function readyCampaigns(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    `SELECT c.id FROM campaigns c WHERE c.status = 'running'
       AND EXISTS (SELECT 1 FROM tasks t WHERE t.campaign_id = c.id AND t.status = 'pending' AND t.next_attempt_at <= $1)
     ORDER BY c.started_at, c.id`,
    [clock.now()]
  );
  return result.rows.map((row) => row.id);
}

export async function reserveNext(
  pool: Pool,
  campaignId: string,
  workerId: string
): Promise<Reservation | null> {
  const settings = await loadSettingsRow(pool);
  return transaction(pool, async (client) => {
    const now = clock.now();
    const task = await client.query<{ id: string; email: string; attempt_count: number }>(
      `SELECT t.id::text, t.email, t.attempt_count FROM tasks t
       WHERE t.campaign_id = $1 AND t.status = 'pending' AND t.next_attempt_at <= $2
       ORDER BY t.position, t.id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [campaignId, now]
    );
    if (!task.rows[0]) return null;
    const token = randomUUID();
    await client.query(
      `UPDATE tasks SET status = 'reserved', owner_worker_id = $2, owner_token = $3,
              reserved_until = $4::timestamptz + make_interval(secs => $5), updated_at = now() WHERE id = $1`,
      [task.rows[0].id, workerId, token, now, settings.reservation_seconds]
    );
    return {
      taskId: task.rows[0].id,
      campaignId,
      email: task.rows[0].email,
      ownerToken: token,
      attemptNumber: task.rows[0].attempt_count + 1,
    };
  });
}

interface CandidateRow {
  id: string;
  email: string;
}

/**
 * Reservation → sending in one transaction: ownership, campaign status, current
 * group membership, manual disabling and quota are all re-checked under locks.
 */
export async function beginAttempt(
  pool: Pool,
  reservation: Reservation,
  workerId: string
): Promise<BeginResult> {
  return transaction(pool, async (client) => {
    const now = clock.now();
    // Lock order everywhere: campaign → task → attempt, so pause/stop cannot deadlock with sends.
    const campaign = await client.query<{
      status: string;
      group_id: string;
      subject: string;
      body: string;
      sender_name: string;
    }>("SELECT status, group_id, subject, body, sender_name FROM campaigns WHERE id = $1 FOR UPDATE", [reservation.campaignId]);
    const state = campaign.rows[0];
    const task = await client.query<{ status: string; owner_token: string | null }>(
      "SELECT status, owner_token FROM tasks WHERE id = $1 FOR UPDATE",
      [reservation.taskId]
    );
    if (!task.rows[0] || task.rows[0].status !== "reserved" || task.rows[0].owner_token !== reservation.ownerToken)
      return { kind: "released", reason: "Резерв задачи больше не принадлежит этому процессу" };
    if (!state || state.status !== "running") {
      await releaseReservation(client, reservation, state?.status === "stopped" ? "cancelled" : "pending");
      return { kind: "released", reason: `Рассылка в состоянии «${state?.status ?? "удалена"}»` };
    }
    const candidate = await client.query<CandidateRow>(
      `SELECT a.id, a.email FROM accounts a
       WHERE a.group_id = $1 AND NOT a.manual_disabled
         AND a.connection_status IN ('unverified', 'ok', 'temporary_error')
         AND (a.cooldown_until IS NULL OR a.cooldown_until <= $2)
         AND NOT EXISTS (SELECT 1 FROM attempts p WHERE p.account_id = a.id AND p.finished_at IS NULL)
         AND quota_used(a.id, a.period_hours, $2) < a.limit_count
       ORDER BY a.last_used_at NULLS FIRST, a.email LIMIT 1 FOR UPDATE OF a SKIP LOCKED`,
      [state.group_id, now]
    );
    if (!candidate.rows[0]) {
      const wait = await describeWait(client, state.group_id, now);
      await client.query(
        `UPDATE tasks SET status = 'pending', owner_worker_id = NULL, owner_token = NULL, reserved_until = NULL,
                next_attempt_at = $2, updated_at = now() WHERE id = $1`,
        [reservation.taskId, wait.until ?? new Date(now.getTime() + 15000)]
      );
      await client.query(
        "UPDATE campaigns SET wait_reason = $2, wait_until = $3 WHERE id = $1",
        [reservation.campaignId, wait.reason, wait.until]
      );
      return { kind: "waiting", reason: wait.reason, until: wait.until };
    }
    const account = candidate.rows[0];
    const attempt = await client.query<{ id: string }>(
      `INSERT INTO attempts(task_id, campaign_id, account_id, number, worker_id, owner_token, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text`,
      [reservation.taskId, reservation.campaignId, account.id, reservation.attemptNumber, workerId, reservation.ownerToken, now]
    );
    const usage = await client.query<{ id: string }>(
      `INSERT INTO quota_usage(account_id, task_id, attempt_id, state, occupied_at)
       VALUES ($1, $2, $3, 'reserved', $4) RETURNING id::text`,
      [account.id, reservation.taskId, attempt.rows[0].id, now]
    );
    await client.query(
      `UPDATE tasks SET status = 'sending', account_id = $2, attempt_count = $3, updated_at = now(),
              reserved_until = NULL WHERE id = $1`,
      [reservation.taskId, account.id, reservation.attemptNumber]
    );
    await client.query("UPDATE accounts SET last_used_at = $2 WHERE id = $1", [account.id, now]);
    await client.query("UPDATE campaigns SET wait_reason = NULL, wait_until = NULL WHERE id = $1 AND wait_reason IS NOT NULL", [reservation.campaignId]);
    return {
      kind: "started",
      attempt: {
        ...reservation,
        attemptId: attempt.rows[0].id,
        accountId: account.id,
        accountEmail: account.email,
        quotaUsageId: usage.rows[0].id,
        subject: state.subject,
        body: state.body,
        senderName: state.sender_name,
      },
    };
  });
}

async function releaseReservation(client: PoolClient, reservation: Reservation, status: "pending" | "cancelled") {
  await client.query(
    `UPDATE tasks SET status = $2, owner_worker_id = NULL, owner_token = NULL, reserved_until = NULL,
            finished_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE finished_at END, updated_at = now()
     WHERE id = $1 AND status = 'reserved' AND owner_token = $3`,
    [reservation.taskId, status, reservation.ownerToken]
  );
}

async function describeWait(client: PoolClient, groupId: string, now: Date) {
  const summary = await client.query<{
    total: number;
    disabled: number;
    broken: number;
    busy: number;
    exhausted: number;
    cooling: number;
    next_free: string | null;
  }>(
    `SELECT count(*)::int AS total,
       count(*) FILTER (WHERE a.manual_disabled)::int AS disabled,
       count(*) FILTER (WHERE NOT a.manual_disabled AND a.connection_status IN ('auth_error', 'needs_check', 'blocked'))::int AS broken,
       count(*) FILTER (WHERE NOT a.manual_disabled AND a.connection_status NOT IN ('auth_error', 'needs_check', 'blocked')
                        AND a.cooldown_until IS NOT NULL AND a.cooldown_until > $2)::int AS cooling,
       count(*) FILTER (WHERE NOT a.manual_disabled AND a.connection_status NOT IN ('auth_error', 'needs_check', 'blocked')
                        AND EXISTS (SELECT 1 FROM attempts p WHERE p.account_id = a.id AND p.finished_at IS NULL))::int AS busy,
       count(*) FILTER (WHERE NOT a.manual_disabled AND a.connection_status NOT IN ('auth_error', 'needs_check', 'blocked')
                        AND quota_used(a.id, a.period_hours, $2) >= a.limit_count)::int AS exhausted,
       min(least(quota_next_free(a.id, a.limit_count, a.period_hours, $2), a.cooldown_until))
         FILTER (WHERE NOT a.manual_disabled AND a.connection_status NOT IN ('auth_error', 'needs_check', 'blocked')) AS next_free
     FROM accounts a WHERE a.group_id = $1`,
    [groupId, now]
  );
  const row = summary.rows[0];
  if (row.total === 0) return { reason: "В группе нет аккаунтов — добавьте отправителей", until: null };
  const usable = row.total - row.disabled - row.broken;
  if (usable <= 0)
    return {
      reason: `Все аккаунты группы требуют действия оператора: отключено ${row.disabled}, с ошибками входа/проверки/блокировки ${row.broken}`,
      until: null,
    };
  if (row.busy > 0 && row.exhausted + row.cooling < usable)
    return { reason: "Все доступные аккаунты сейчас заняты отправкой", until: new Date(now.getTime() + 2000) };
  const until = row.next_free ? new Date(row.next_free) : null;
  return {
    reason: `Лимиты исчерпаны у ${row.exhausted} из ${usable} доступных аккаунтов${row.cooling ? `, временная ошибка у ${row.cooling}` : ""}; продолжение не раньше ${until ? until.toISOString() : "освобождения квоты"}`,
    until,
  };
}

export function retryDelayMs(settings: SettingsRow, attemptNumber: number) {
  const minutes = Math.min(
    settings.retry_base_minutes * 2 ** Math.max(attemptNumber - 1, 0),
    settings.retry_max_minutes
  );
  return minutes * 60000;
}

export interface FinishInput {
  attempt: StartedAttempt;
  outcome: SendOutcome;
}

/**
 * Records the adapter result. If the operator already decided the outcome of an
 * unclear task, the late answer is stored on the same attempt and changes nothing.
 */
export async function finishAttempt(pool: Pool, input: FinishInput): Promise<string> {
  const { attempt, outcome } = input;
  return transaction(pool, async (client) => {
    const now = clock.now();
    const settings = await loadSettingsRow(client);
    await client.query("SELECT 1 FROM campaigns WHERE id = $1 FOR UPDATE", [attempt.campaignId]);
    await client.query("SELECT 1 FROM tasks WHERE id = $1 FOR UPDATE", [attempt.taskId]);
    const current = await client.query<{
      decided: boolean;
      task_status: string;
      attempt_count: number;
      campaign_status: string;
    }>(
      `SELECT (p.outcome IS NOT NULL OR p.operator_decision IS NOT NULL) AS decided,
              t.status AS task_status, t.attempt_count, c.status AS campaign_status
       FROM attempts p JOIN tasks t ON t.id = p.task_id JOIN campaigns c ON c.id = t.campaign_id
       WHERE p.id = $1 FOR UPDATE OF p`,
      [attempt.attemptId]
    );
    const row = current.rows[0];
    if (!row) return "missing";
    if (row.decided) {
      await client.query(
        "UPDATE attempts SET late_outcome = $2, late_message = $3, late_at = $4 WHERE id = $1",
        [attempt.attemptId, outcome.kind, "message" in outcome ? outcome.message : outcome.response, now]
      );
      await recordEvent(client, {
        kind: "late_response",
        level: "warning",
        title: "Поздний ответ по уже закрытой попытке",
        detail: `${attempt.email}: ответ «${outcome.kind}» пришёл после решения оператора и не меняет итог.`,
        campaignId: attempt.campaignId,
        accountId: attempt.accountId,
        taskId: attempt.taskId,
        attemptId: attempt.attemptId,
      });
      return "late";
    }
    const setAttempt = async (
      result: "accepted" | "rejected" | "unknown",
      category: RejectCategory | null,
      code: string | null,
      message: string | null
    ) =>
      client.query(
        `UPDATE attempts SET finished_at = $2, outcome = $3, error_category = $4, error_code = $5, error_message = $6 WHERE id = $1`,
        [attempt.attemptId, now, result, category, code, message]
      );
    const setUsage = (state: "accepted" | "released" | "reserved") =>
      client.query("UPDATE quota_usage SET state = $2 WHERE id = $1", [attempt.quotaUsageId, state]);

    if (outcome.kind === "accepted") {
      await setAttempt("accepted", null, null, null);
      await setUsage("accepted");
      await client.query(
        `UPDATE tasks SET status = 'accepted', finished_at = $2, last_error = NULL, last_error_code = NULL,
                owner_worker_id = NULL, owner_token = NULL, updated_at = now() WHERE id = $1`,
        [attempt.taskId, now]
      );
      await client.query(
        "UPDATE accounts SET connection_status = 'ok', connection_error = NULL, cooldown_until = NULL, updated_at = now() WHERE id = $1 AND connection_status IN ('unverified', 'temporary_error', 'ok')",
        [attempt.accountId]
      );
      await finishCampaignIfDone(client, attempt.campaignId, now);
      return "accepted";
    }
    if (outcome.kind === "unknown") {
      await setAttempt("unknown", null, null, outcome.message);
      // The reserve stays occupied until the operator resolves the task.
      await client.query(
        `UPDATE tasks SET status = 'unclear', last_error = $2, last_error_code = 'unknown',
                owner_worker_id = NULL, owner_token = NULL, updated_at = now() WHERE id = $1`,
        [attempt.taskId, outcome.message.slice(0, 500)]
      );
      await recordEvent(client, {
        kind: "task_unclear",
        level: "warning",
        title: "Неясный исход отправки",
        detail: `${attempt.email} через ${attempt.accountEmail}: ${outcome.message}. Автоматического повтора нет — решение за оператором.`,
        campaignId: attempt.campaignId,
        accountId: attempt.accountId,
        taskId: attempt.taskId,
        attemptId: attempt.attemptId,
      });
      return "unclear";
    }
    await setAttempt("rejected", outcome.category, outcome.code, outcome.message);
    await setUsage("released");
    const budgetLeft = row.attempt_count < 1 + settings.retry_max_attempts;
    const failTask = async (detail: string) => {
      await client.query(
        `UPDATE tasks SET status = 'failed', finished_at = $2, last_error = $3, last_error_code = $4,
                owner_worker_id = NULL, owner_token = NULL, updated_at = now() WHERE id = $1`,
        [attempt.taskId, now, detail.slice(0, 500), outcome.category]
      );
      await recordEvent(client, {
        kind: "task_failed",
        level: "error",
        title: "Задача завершена с ошибкой",
        detail: `${attempt.email}: ${detail}`,
        campaignId: attempt.campaignId,
        accountId: attempt.accountId,
        taskId: attempt.taskId,
        attemptId: attempt.attemptId,
      });
    };
    const requeue = async (at: Date, detail: string) => {
      await client.query(
        `UPDATE tasks SET status = 'pending', next_attempt_at = $2, last_error = $3, last_error_code = $4,
                owner_worker_id = NULL, owner_token = NULL, updated_at = now() WHERE id = $1`,
        [attempt.taskId, at, detail.slice(0, 500), outcome.category]
      );
    };
    switch (outcome.category) {
      case "recipient":
        await failTask(`Адрес получателя отклонён: ${outcome.message}`);
        break;
      case "auth":
      case "needs_check":
      case "account_blocked": {
        const status = outcome.category === "auth" ? "auth_error" : outcome.category === "needs_check" ? "needs_check" : "blocked";
        await client.query(
          `UPDATE accounts SET connection_status = $2, connection_error = $3, connection_checked_at = $4, updated_at = now() WHERE id = $1`,
          [attempt.accountId, status, outcome.message.slice(0, 500), now]
        );
        await recordEvent(client, {
          kind: "account_excluded",
          level: "error",
          title:
            status === "auth_error"
              ? "Аккаунт исключён: ошибка авторизации"
              : status === "needs_check"
                ? "Аккаунт исключён: требует проверки владельцем"
                : "Аккаунт исключён: заблокирован сервисом",
          detail: `${attempt.accountEmail}: ${outcome.message}`,
          campaignId: attempt.campaignId,
          accountId: attempt.accountId,
          taskId: attempt.taskId,
          attemptId: attempt.attemptId,
        });
        if (budgetLeft) await requeue(now, `Аккаунт ${attempt.accountEmail} исключён (${outcome.message}); задача переходит другому аккаунту`);
        else await failTask(`Исчерпан бюджет попыток; последняя ошибка аккаунта ${attempt.accountEmail}: ${outcome.message}`);
        break;
      }
      case "content_or_policy":
        await requeue(now, `Сервис отклонил письмо: ${outcome.message}`);
        if (row.campaign_status === "running") {
          await client.query(
            `UPDATE campaigns SET status = 'paused', pause_reason = $2, wait_reason = NULL, wait_until = NULL, updated_at = now() WHERE id = $1`,
            [attempt.campaignId, `Отказ сервиса по содержанию или запрет рассылки (${attempt.accountEmail}): ${outcome.message.slice(0, 300)}`]
          );
          await recordEvent(client, {
            kind: "campaign_auto_paused",
            level: "error",
            title: "Рассылка поставлена на паузу сервисом",
            detail: `Отказ по содержанию или запрет рассылки — перебор аккаунтов не выполняется. ${outcome.message}`,
            campaignId: attempt.campaignId,
            accountId: attempt.accountId,
            taskId: attempt.taskId,
            attemptId: attempt.attemptId,
          });
        }
        break;
      default: {
        // temporary / connection
        const delay = retryDelayMs(settings, row.attempt_count);
        if (outcome.scope !== "message") {
          await client.query(
            `UPDATE accounts SET connection_status = 'temporary_error', connection_error = $2, cooldown_until = $3, updated_at = now() WHERE id = $1`,
            [attempt.accountId, outcome.message.slice(0, 500), new Date(Math.min(now.getTime() + delay, now.getTime() + 15 * 60000))]
          );
        }
        if (budgetLeft) {
          await requeue(new Date(now.getTime() + delay), `Временная ошибка, повтор запланирован: ${outcome.message}`);
          await recordEvent(client, {
            kind: "attempt_failed",
            level: "warning",
            title: "Временная ошибка отправки",
            detail: `${attempt.email} через ${attempt.accountEmail}: ${outcome.message}. Повтор через ${Math.round(delay / 60000)} мин (попытка ${row.attempt_count} из ${1 + settings.retry_max_attempts}).`,
            campaignId: attempt.campaignId,
            accountId: attempt.accountId,
            taskId: attempt.taskId,
            attemptId: attempt.attemptId,
          });
        } else await failTask(`Исчерпан предел попыток (${row.attempt_count}); последняя ошибка: ${outcome.message}`);
      }
    }
    await finishCampaignIfDone(client, attempt.campaignId, now);
    return outcome.category;
  });
}

export async function finishCampaignIfDone(client: PoolClient, campaignId: string, now: Date) {
  const remaining = await client.query<{ active: number; failed: number; status: string }>(
    `SELECT (SELECT count(*)::int FROM tasks t WHERE t.campaign_id = c.id AND t.status = ANY($2::text[])) AS active,
            (SELECT count(*)::int FROM tasks t WHERE t.campaign_id = c.id AND t.status IN ('failed', 'closed_unconfirmed')) AS failed,
            c.status
     FROM campaigns c WHERE c.id = $1 FOR UPDATE`,
    [campaignId, ACTIVE]
  );
  const row = remaining.rows[0];
  if (!row || row.active > 0) return false;
  if (row.status === "running" || row.status === "paused") {
    const status = row.failed > 0 ? "completed_with_errors" : "completed";
    await client.query(
      "UPDATE campaigns SET status = $2, finished_at = $3, wait_reason = NULL, wait_until = NULL, pause_reason = NULL, updated_at = now() WHERE id = $1",
      [campaignId, status, now]
    );
    await recordEvent(client, {
      kind: "campaign_completed",
      level: row.failed > 0 ? "warning" : "info",
      title: row.failed > 0 ? "Рассылка завершена с ошибками" : "Рассылка завершена",
      detail: row.failed > 0 ? `Задач с ошибкой или закрытых без подтверждения: ${row.failed}.` : "Все задачи получили итог.",
      campaignId,
    });
    return true;
  }
  return false;
}

/**
 * Crash recovery. Reservations that never reached "sending" simply return to the
 * queue. A "sending" task whose worker stopped confirming may already have left
 * the server, so it becomes unclear and keeps its quota reserve.
 */
export async function recoverStale(pool: Pool, aliveWorkerIds: string[]) {
  const settings = await loadSettingsRow(pool);
  return transaction(pool, async (client) => {
    const now = clock.now();
    const released = await client.query<{ id: string }>(
      `UPDATE tasks SET status = 'pending', owner_worker_id = NULL, owner_token = NULL, reserved_until = NULL, updated_at = now()
       WHERE status = 'reserved' AND (reserved_until < $1 OR NOT (owner_worker_id = ANY($2::uuid[])))
       RETURNING id::text`,
      [now, aliveWorkerIds]
    );
    const stale = await client.query<{ id: string; task_id: string; campaign_id: string; account_id: string; email: string; account_email: string }>(
      `SELECT p.id::text, p.task_id::text, p.campaign_id, p.account_id, t.email, a.email AS account_email
       FROM attempts p JOIN tasks t ON t.id = p.task_id JOIN accounts a ON a.id = p.account_id
       LEFT JOIN workers w ON w.id = p.worker_id
       WHERE p.finished_at IS NULL AND t.status = 'sending'
         AND (w.id IS NULL OR w.stopped_at IS NOT NULL OR w.last_heartbeat_at < $1::timestamptz - make_interval(secs => $2))
         AND NOT (p.worker_id = ANY($3::uuid[]))
       FOR UPDATE OF p, t`,
      [now, settings.heartbeat_stale_seconds, aliveWorkerIds]
    );
    for (const row of stale.rows) {
      const message = "Процесс отправки прервался после начала передачи письма; результат неизвестен";
      await client.query(
        "UPDATE attempts SET finished_at = $2, outcome = 'unknown', error_message = $3 WHERE id = $1",
        [row.id, now, message]
      );
      await client.query(
        `UPDATE tasks SET status = 'unclear', last_error = $2, last_error_code = 'unknown', owner_worker_id = NULL, owner_token = NULL, updated_at = now() WHERE id = $1`,
        [row.task_id, message]
      );
      await recordEvent(client, {
        kind: "task_unclear",
        level: "warning",
        title: "Неясный исход после сбоя процесса",
        detail: `${row.email} через ${row.account_email}: ${message}.`,
        campaignId: row.campaign_id,
        accountId: row.account_id,
        taskId: row.task_id,
        attemptId: row.id,
      });
    }
    if (released.rowCount || stale.rowCount) {
      await recordEvent(client, {
        kind: "worker_recovered_tasks",
        level: "warning",
        title: "Восстановление очереди после сбоя",
        detail: `Возвращено в очередь ${released.rowCount} резервов; помечено неясными ${stale.rowCount} начатых отправок.`,
      });
    }
    return { released: released.rowCount ?? 0, unclear: stale.rowCount ?? 0 };
  });
}
