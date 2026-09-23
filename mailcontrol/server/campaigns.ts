import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  Campaign,
  ImportErrorRow,
  ImportFormat,
  RecipientsPreview,
  RecipientsResult,
  Task,
} from "../shared/contracts.js";
import { isValidEmail, normalizeEmail, parseRecipients } from "../shared/parsing.js";
import { clock } from "./clock.js";
import { transaction } from "./database.js";
import { ApiFailure } from "./errors.js";
import { recordEvent } from "./events.js";
import { finishCampaignIfDone } from "./queue.js";
import { getCampaign, getTask } from "./repository.js";

const MAX_RECIPIENTS = 200000;

export function previewRecipients(text: string, format: ImportFormat): RecipientsPreview {
  const rows = parseRecipients(text, format);
  if (rows.length > MAX_RECIPIENTS)
    throw new ApiFailure(400, "TOO_MANY_ROWS", `Не более ${MAX_RECIPIENTS} получателей в одной рассылке.`);
  const seen = new Set<string>();
  const invalid: ImportErrorRow[] = [];
  let duplicateCount = 0;
  const sample: string[] = [];
  for (const row of rows) {
    if (!row.ok) {
      invalid.push({ line: row.line, email: row.email, reason: row.reason });
      continue;
    }
    if (seen.has(row.email)) {
      duplicateCount++;
      continue;
    }
    seen.add(row.email);
    if (sample.length < 5) sample.push(row.email);
  }
  return {
    validCount: seen.size,
    duplicateCount,
    invalid: invalid.slice(0, 500),
    invalidCount: invalid.length,
    sample,
  };
}

async function lockCampaign(client: PoolClient, id: string) {
  const result = await client.query<{ status: string; name: string; group_id: string; subject: string; body: string; is_test: boolean }>(
    "SELECT status, name, group_id, subject, body, is_test FROM campaigns WHERE id = $1 FOR UPDATE",
    [id]
  );
  if (!result.rows[0]) throw new ApiFailure(404, "CAMPAIGN_NOT_FOUND", "Рассылка не найдена.");
  return result.rows[0];
}

async function seenRequest<T>(client: PoolClient, key: string) {
  const result = await client.query<{ result: T }>("SELECT result FROM import_requests WHERE request_key = $1", [key]);
  return result.rows[0]?.result;
}

async function rememberRequest(client: PoolClient, key: string, kind: string, result: unknown) {
  await client.query("INSERT INTO import_requests(request_key, kind, result) VALUES ($1, $2, $3)", [key, kind, JSON.stringify(result)]);
}

/** Replaces the recipient list of a draft. Duplicates inside one campaign collapse into one task. */
export function setRecipients(
  pool: Pool,
  campaignId: string,
  input: { text: string; format: ImportFormat; requestKey: string }
): Promise<RecipientsResult> {
  return transaction(pool, async (client) => {
    const repeated = await seenRequest<Omit<RecipientsResult, "campaign">>(client, input.requestKey);
    if (repeated) return { ...repeated, campaign: await getCampaign(client, campaignId) };
    const campaign = await lockCampaign(client, campaignId);
    if (campaign.status !== "draft")
      throw new ApiFailure(409, "INVALID_STATE", "Список получателей зафиксирован при запуске. Создайте новую рассылку.");
    const preview = previewRecipients(input.text, input.format);
    const emails: string[] = [];
    const seen = new Set<string>();
    for (const row of parseRecipients(input.text, input.format)) {
      if (row.ok && !seen.has(row.email)) {
        seen.add(row.email);
        emails.push(row.email);
      }
    }
    await client.query("DELETE FROM tasks WHERE campaign_id = $1 AND status = 'pending'", [campaignId]);
    for (let offset = 0; offset < emails.length; offset += 2000) {
      const chunk = emails.slice(offset, offset + 2000);
      await client.query(
        `INSERT INTO tasks(campaign_id, email, position)
         SELECT $1, e.email, $2 + e.ordinality FROM unnest($3::text[]) WITH ORDINALITY AS e(email, ordinality)`,
        [campaignId, offset, chunk]
      );
    }
    await client.query("UPDATE campaigns SET updated_at = now() WHERE id = $1", [campaignId]);
    const result = {
      validCount: preview.validCount,
      duplicateCount: preview.duplicateCount,
      invalid: preview.invalid,
      invalidCount: preview.invalidCount,
    };
    await rememberRequest(client, input.requestKey, "recipients", result);
    await recordEvent(client, {
      kind: "recipients_loaded",
      title: "Загружен список получателей",
      detail: `«${campaign.name}»: ${preview.validCount} адресов, повторов ${preview.duplicateCount}, некорректных ${preview.invalidCount}.`,
      campaignId,
    });
    return { ...result, campaign: await getCampaign(client, campaignId) };
  });
}

export function startCampaign(pool: Pool, campaignId: string): Promise<Campaign> {
  return transaction(pool, async (client) => {
    const campaign = await lockCampaign(client, campaignId);
    if (campaign.status === "running") return getCampaign(client, campaignId);
    if (campaign.status !== "draft")
      throw new ApiFailure(409, "INVALID_STATE", "Запустить можно только черновик. Для паузы используйте «Продолжить».");
    const recipients = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM tasks WHERE campaign_id = $1",
      [campaignId]
    );
    const problems: string[] = [];
    if (recipients.rows[0].count === 0) problems.push("нет получателей");
    if (!campaign.subject.trim()) problems.push("пустая тема");
    if (!campaign.body.trim()) problems.push("пустой текст");
    if (problems.length)
      throw new ApiFailure(409, "NOT_READY", `Рассылку нельзя запустить: ${problems.join(", ")}.`);
    const now = clock.now();
    await client.query(
      "UPDATE campaigns SET status = 'running', started_at = $2, revision = revision + 1, updated_at = now() WHERE id = $1",
      [campaignId, now]
    );
    await client.query("UPDATE tasks SET next_attempt_at = $2, updated_at = now() WHERE campaign_id = $1", [campaignId, now]);
    await recordEvent(client, {
      kind: "campaign_started",
      title: campaign.is_test ? "Запущена тестовая отправка" : "Рассылка запущена",
      detail: `«${campaign.name}»: ${recipients.rows[0].count} получателей. Тема, текст и список зафиксированы.`,
      campaignId,
    });
    return getCampaign(client, campaignId);
  });
}

export function pauseCampaign(pool: Pool, campaignId: string): Promise<Campaign> {
  return transaction(pool, async (client) => {
    const campaign = await lockCampaign(client, campaignId);
    if (campaign.status === "paused") return getCampaign(client, campaignId);
    if (campaign.status !== "running")
      throw new ApiFailure(409, "INVALID_STATE", "На паузу можно поставить только выполняющуюся рассылку.");
    await client.query(
      "UPDATE campaigns SET status = 'paused', pause_reason = 'Пауза по команде оператора', wait_reason = NULL, wait_until = NULL, updated_at = now() WHERE id = $1",
      [campaignId]
    );
    // Reserved-but-not-started tasks return to the queue; started ones may finish.
    const released = await client.query(
      "UPDATE tasks SET status = 'pending', owner_worker_id = NULL, owner_token = NULL, reserved_until = NULL, updated_at = now() WHERE campaign_id = $1 AND status = 'reserved'",
      [campaignId]
    );
    await recordEvent(client, {
      kind: "campaign_paused",
      title: "Рассылка поставлена на паузу",
      detail: `«${campaign.name}». Новые отправки не начинаются; начатые могут завершиться. Возвращено в очередь резервов: ${released.rowCount ?? 0}.`,
      campaignId,
    });
    return getCampaign(client, campaignId);
  });
}

export function resumeCampaign(pool: Pool, campaignId: string): Promise<Campaign> {
  return transaction(pool, async (client) => {
    const campaign = await lockCampaign(client, campaignId);
    if (campaign.status === "running") return getCampaign(client, campaignId);
    if (campaign.status !== "paused")
      throw new ApiFailure(409, "INVALID_STATE", "«Продолжить» работает только для рассылки на паузе.");
    await client.query(
      "UPDATE campaigns SET status = 'running', pause_reason = NULL, updated_at = now() WHERE id = $1",
      [campaignId]
    );
    await recordEvent(client, {
      kind: "campaign_resumed",
      title: "Рассылка продолжена",
      detail: `«${campaign.name}».`,
      campaignId,
    });
    if (await finishCampaignIfDone(client, campaignId, clock.now())) return getCampaign(client, campaignId);
    return getCampaign(client, campaignId);
  });
}

export function stopCampaign(pool: Pool, campaignId: string): Promise<Campaign> {
  return transaction(pool, async (client) => {
    const campaign = await lockCampaign(client, campaignId);
    if (campaign.status === "stopped") return getCampaign(client, campaignId);
    if (!["running", "paused"].includes(campaign.status))
      throw new ApiFailure(409, "INVALID_STATE", "Остановить можно только выполняющуюся рассылку или рассылку на паузе.");
    const now = clock.now();
    const cancelled = await client.query(
      `UPDATE tasks SET status = 'cancelled', finished_at = $2, owner_worker_id = NULL, owner_token = NULL, reserved_until = NULL, updated_at = now()
       WHERE campaign_id = $1 AND status IN ('pending', 'reserved')`,
      [campaignId, now]
    );
    const inFlight = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM tasks WHERE campaign_id = $1 AND status IN ('sending', 'unclear')",
      [campaignId]
    );
    await client.query(
      `UPDATE campaigns SET status = 'stopped', finished_at = CASE WHEN $3 = 0 THEN $2::timestamptz ELSE NULL END,
              pause_reason = NULL, wait_reason = NULL, wait_until = NULL, updated_at = now() WHERE id = $1`,
      [campaignId, now, inFlight.rows[0].count]
    );
    await recordEvent(client, {
      kind: "campaign_stopped",
      level: "warning",
      title: "Рассылка остановлена окончательно",
      detail: `«${campaign.name}»: отменено ${cancelled.rowCount ?? 0} задач. Начатых отправок: ${inFlight.rows[0].count}; неясные исходы ждут решения оператора.`,
      campaignId,
    });
    return getCampaign(client, campaignId);
  });
}

export function excludeTask(pool: Pool, campaignId: string, taskId: string): Promise<Task> {
  return transaction(pool, async (client) => {
    await lockCampaign(client, campaignId);
    const task = await client.query<{ status: string; email: string }>(
      "SELECT status, email FROM tasks WHERE id = $1 AND campaign_id = $2 FOR UPDATE",
      [taskId, campaignId]
    );
    if (!task.rows[0]) throw new ApiFailure(404, "TASK_NOT_FOUND", "Задача не найдена.");
    if (task.rows[0].status === "excluded") return getTask(client, campaignId, taskId);
    if (!["pending", "reserved"].includes(task.rows[0].status))
      throw new ApiFailure(409, "INVALID_STATE", "Исключить можно только ещё не начатую отправку.");
    await client.query(
      "UPDATE tasks SET status = 'excluded', finished_at = $2, owner_worker_id = NULL, owner_token = NULL, reserved_until = NULL, resolved_by_operator = true, updated_at = now() WHERE id = $1",
      [taskId, clock.now()]
    );
    await recordEvent(client, {
      kind: "task_excluded",
      title: "Получатель исключён оператором",
      detail: task.rows[0].email,
      campaignId,
      taskId,
    });
    await finishCampaignIfDone(client, campaignId, clock.now());
    return getTask(client, campaignId, taskId);
  });
}

/**
 * Three decisions for an unclear task. Every path is atomic and idempotent:
 * a repeated command or a late worker answer cannot double-count the quota.
 */
export function resolveTask(
  pool: Pool,
  campaignId: string,
  taskId: string,
  decision: "accepted" | "failed" | "closed",
  requestKey: string
): Promise<Task> {
  return transaction(pool, async (client) => {
    const repeated = await seenRequest<{ taskId: string }>(client, requestKey);
    if (repeated) return getTask(client, campaignId, taskId);
    await lockCampaign(client, campaignId);
    const task = await client.query<{ status: string; email: string; account_id: string }>(
      "SELECT status, email, account_id FROM tasks WHERE id = $1 AND campaign_id = $2 FOR UPDATE",
      [taskId, campaignId]
    );
    if (!task.rows[0]) throw new ApiFailure(404, "TASK_NOT_FOUND", "Задача не найдена.");
    if (task.rows[0].status !== "unclear")
      throw new ApiFailure(409, "INVALID_STATE", "Решение принимается только по задаче с неясным исходом.");
    const attempt = await client.query<{ id: string; quota_id: string | null; account_period: number }>(
      `SELECT p.id::text, q.id::text AS quota_id, a.period_hours AS account_period FROM attempts p
       LEFT JOIN quota_usage q ON q.attempt_id = p.id JOIN accounts a ON a.id = p.account_id
       WHERE p.task_id = $1 ORDER BY p.number DESC LIMIT 1 FOR UPDATE OF p`,
      [taskId]
    );
    const last = attempt.rows[0];
    const now = clock.now();
    const status = decision === "accepted" ? "accepted" : decision === "failed" ? "failed" : "closed_unconfirmed";
    await client.query(
      "UPDATE attempts SET operator_decision = $2 WHERE id = $1",
      [last.id, decision]
    );
    if (last.quota_id) {
      // Closing without proof counts as a possible send from the moment of closing.
      const state = decision === "accepted" ? "accepted" : decision === "failed" ? "released" : "possible";
      await client.query(
        `UPDATE quota_usage SET state = $2, occupied_at = CASE WHEN $2 = 'possible' THEN $3::timestamptz ELSE occupied_at END WHERE id = $1`,
        [last.quota_id, state, now]
      );
    }
    await client.query(
      `UPDATE tasks SET status = $2, finished_at = $3, resolved_by_operator = true,
              last_error = CASE WHEN $2 = 'accepted' THEN NULL ELSE last_error END, updated_at = now() WHERE id = $1`,
      [taskId, status, now]
    );
    await rememberRequest(client, requestKey, "resolve", { taskId });
    await recordEvent(client, {
      kind: "task_resolved",
      title:
        decision === "accepted"
          ? "Оператор подтвердил принятие письма"
          : decision === "failed"
            ? "Оператор подтвердил отказ"
            : "Задача закрыта без подтверждения",
      detail:
        decision === "closed"
          ? `${task.rows[0].email}: повтора не будет; квота аккаунта занята ещё ${last.account_period} ч как возможная отправка.`
          : task.rows[0].email,
      campaignId,
      accountId: task.rows[0].account_id,
      taskId,
      attemptId: last.id,
    });
    await finishCampaignIfDone(client, campaignId, now);
    return getTask(client, campaignId, taskId);
  });
}

/** A test letter is a real one-recipient campaign through the same queue and quota. */
export function createTestSend(
  pool: Pool,
  campaignId: string,
  recipient: string,
  requestKey: string
): Promise<Campaign> {
  return transaction(pool, async (client) => {
    const repeated = await seenRequest<{ id: string }>(client, requestKey);
    if (repeated) return getCampaign(client, repeated.id);
    const email = normalizeEmail(recipient);
    if (!isValidEmail(email))
      throw new ApiFailure(400, "VALIDATION_ERROR", "Укажите корректный адрес для тестового письма.");
    const source = await lockCampaign(client, campaignId);
    if (!source.subject.trim() || !source.body.trim())
      throw new ApiFailure(409, "NOT_READY", "Для тестовой отправки нужны тема и текст.");
    const sender = await client.query<{ sender_name: string }>("SELECT sender_name FROM campaigns WHERE id = $1", [campaignId]);
    const id = randomUUID();
    const now = clock.now();
    await client.query(
      `INSERT INTO campaigns(id, request_key, group_id, name, subject, body, sender_name, status, is_test, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', true, $8)`,
      [id, requestKey, source.group_id, `Тест: ${source.name}`.slice(0, 120), source.subject, source.body, sender.rows[0].sender_name, now]
    );
    await client.query("INSERT INTO tasks(campaign_id, email, position, next_attempt_at) VALUES ($1, $2, 1, $3)", [id, email, now]);
    await rememberRequest(client, requestKey, "test_send", { id });
    await recordEvent(client, {
      kind: "test_send",
      title: "Создана тестовая отправка",
      detail: `«${source.name}» → ${email}. Это настоящая отправка с историей и расходом квоты.`,
      campaignId: id,
    });
    return getCampaign(client, id);
  });
}

const TASK_LABELS: Record<string, string> = {
  pending: "в очереди",
  reserved: "зарезервировано",
  sending: "отправляется",
  accepted: "принято сервисом",
  failed: "ошибка",
  unclear: "неясный исход",
  cancelled: "отменено",
  excluded: "исключено",
  closed_unconfirmed: "закрыто без подтверждения",
};

function csvCell(value: string | number | null) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[";\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export async function campaignReportCsv(pool: Pool, campaignId: string) {
  const campaign = await getCampaign(pool, campaignId);
  const header = ["№", "Получатель", "Статус", "Попыток", "Аккаунт", "Последняя ошибка", "Завершено (UTC)"];
  const lines = ["\uFEFF" + header.join(";")];
  let lastId = "0";
  for (;;) {
    const rows = await pool.query<{ id: string; position: number; email: string; status: string; attempt_count: number; account: string | null; last_error: string | null; finished_at: string | null }>(
      `SELECT t.id::text, t.position, t.email, t.status, t.attempt_count, a.email AS account, t.last_error, t.finished_at
       FROM tasks t LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.campaign_id = $1 AND t.id > $2 ORDER BY t.id LIMIT 5000`,
      [campaignId, lastId]
    );
    if (!rows.rowCount) break;
    for (const row of rows.rows) {
      lines.push(
        [row.position, row.email, TASK_LABELS[row.status] ?? row.status, row.attempt_count, row.account, row.last_error, row.finished_at]
          .map(csvCell)
          .join(";")
      );
      lastId = row.id;
    }
  }
  const filename = `mailcontrol-${campaign.name.replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 60) || "campaign"}-${campaign.id.slice(0, 8)}.csv`;
  return { filename, content: lines.join("\r\n") + "\r\n", campaign };
}
