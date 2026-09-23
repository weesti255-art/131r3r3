import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  Account,
  Attempt,
  Campaign,
  CampaignSummary,
  CreateDraft,
  CreateGroup,
  Event,
  Group,
  Overview,
  Page,
  Settings,
  Task,
  UpdateDraft,
  UpdateSettings,
  AppMode,
  WorkerInfo,
} from "../shared/contracts.js";
import { clock } from "./clock.js";
import { transaction } from "./database.js";
import { ApiFailure } from "./errors.js";
import { recordEvent } from "./events.js";
import {
  searchPattern,
  type ListInput,
  type EventListInput,
  type TaskListInput,
} from "./validation.js";

type Db = Pool | PoolClient;

export const groupFields = `g.id, g.name, g.color, g.limit_count AS "limitCount",
  g.period_hours AS "periodHours", g.created_at AS "createdAt",
  (SELECT count(*)::int FROM accounts a WHERE a.group_id = g.id) AS "accountCount"`;

/** Derived status mirrors the operator statuses listed in the plan. */
export const accountStatusSql = `CASE
  WHEN a.manual_disabled THEN 'disabled'
  WHEN a.connection_status IN ('auth_error', 'needs_check', 'blocked') THEN a.connection_status
  WHEN a.cooldown_until IS NOT NULL AND a.cooldown_until > $NOW THEN 'temporary_error'
  WHEN quota_used(a.id, a.period_hours, $NOW) >= a.limit_count THEN 'quota_exhausted'
  WHEN a.connection_status = 'unverified' THEN 'unverified'
  ELSE 'active' END`;

export function accountFields(nowParam: string) {
  const status = accountStatusSql.replaceAll("$NOW", nowParam);
  return `a.id, a.email, a.group_id AS "groupId", g.name AS "groupName", g.color AS "groupColor",
    ${status} AS status,
    a.connection_status AS "connectionStatus", a.connection_error AS "connectionError",
    a.connection_checked_at AS "connectionCheckedAt", a.manual_disabled AS "manualDisabled",
    a.disabled_reason AS "disabledReason", a.limit_count AS "limitCount", a.period_hours AS "periodHours",
    quota_used(a.id, a.period_hours, ${nowParam}) AS "quotaUsed",
    greatest(a.limit_count - quota_used(a.id, a.period_hours, ${nowParam}), 0) AS "quotaRemaining",
    quota_next_free(a.id, a.limit_count, a.period_hours, ${nowParam}) AS "nextFreeAt",
    (a.password_ciphertext IS NOT NULL) AS "hasPassword", a.is_demo AS demo, a.created_at AS "createdAt"`;
}

const countsSql = `(SELECT json_build_object(
    'total', count(*), 'pending', count(*) FILTER (WHERE t.status = 'pending'),
    'reserved', count(*) FILTER (WHERE t.status = 'reserved'),
    'sending', count(*) FILTER (WHERE t.status = 'sending'),
    'accepted', count(*) FILTER (WHERE t.status = 'accepted'),
    'failed', count(*) FILTER (WHERE t.status = 'failed'),
    'unclear', count(*) FILTER (WHERE t.status = 'unclear'),
    'cancelled', count(*) FILTER (WHERE t.status = 'cancelled'),
    'excluded', count(*) FILTER (WHERE t.status = 'excluded'),
    'closedUnconfirmed', count(*) FILTER (WHERE t.status = 'closed_unconfirmed'))
  FROM tasks t WHERE t.campaign_id = c.id) AS counts`;

export const campaignFields = `c.id, c.name, c.group_id AS "groupId", g.name AS "groupName",
  g.color AS "groupColor", c.subject, left(c.body, 160) AS "bodyPreview",
  c.sender_name AS "senderName", c.status, c.is_test AS "isTest", c.revision, ${countsSql},
  c.pause_reason AS "pauseReason", c.wait_reason AS "waitReason", c.wait_until AS "waitUntil",
  c.started_at AS "startedAt", c.finished_at AS "finishedAt",
  c.created_at AS "createdAt", c.updated_at AS "updatedAt"`;

export const eventFields = `e.id::text, e.kind, e.level, e.title, e.detail, e.entity_type AS "entityType",
  e.entity_id AS "entityId", e.campaign_id AS "campaignId", e.account_id AS "accountId",
  e.task_id::text AS "taskId", e.attempt_id::text AS "attemptId", e.created_at AS "createdAt"`;

export const taskFields = `t.id::text, t.campaign_id AS "campaignId", t.email, t.position, t.status,
  t.attempt_count AS "attemptCount", t.next_attempt_at AS "nextAttemptAt", t.account_id AS "accountId",
  a.email AS "accountEmail", t.last_error_code AS "lastErrorCode", t.last_error AS "lastError",
  t.finished_at AS "finishedAt", t.resolved_by_operator AS "resolvedByOperator", t.updated_at AS "updatedAt"`;

export const attemptFields = `p.id::text, p.task_id::text AS "taskId", p.campaign_id AS "campaignId",
  p.account_id AS "accountId", a.email AS "accountEmail", p.number, p.worker_id AS "workerId",
  p.started_at AS "startedAt", p.finished_at AS "finishedAt", p.outcome, p.error_category AS "errorCategory",
  p.error_code AS "errorCode", p.error_message AS "errorMessage", p.operator_decision AS "operatorDecision",
  p.late_outcome AS "lateOutcome", p.late_message AS "lateMessage", p.late_at AS "lateAt"`;

async function page<T extends object>(
  pool: Db,
  fields: string,
  from: string,
  order: string,
  params: unknown[],
  input: { page: number; pageSize: number }
): Promise<Page<T>> {
  const [result, count] = await Promise.all([
    pool.query<T>(
      `SELECT ${fields} ${from} ORDER BY ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, input.pageSize, (input.page - 1) * input.pageSize]
    ),
    pool.query<{ count: number }>(`SELECT count(*)::int AS count ${from}`, params),
  ]);
  return {
    items: result.rows,
    total: count.rows[0].count,
    page: input.page,
    pageSize: input.pageSize,
  };
}

export async function selectGroup(client: Db, id: string): Promise<Group> {
  const result = await client.query<Group>(
    `SELECT ${groupFields} FROM account_groups g WHERE g.id = $1`,
    [id]
  );
  if (!result.rows[0])
    throw new ApiFailure(404, "GROUP_NOT_FOUND", "Группа не найдена. Обновите список.");
  return result.rows[0];
}

export async function getCampaign(client: Db, id: string): Promise<Campaign> {
  const result = await client.query<Campaign>(
    `SELECT ${campaignFields}, c.body FROM campaigns c JOIN account_groups g ON g.id = c.group_id WHERE c.id = $1`,
    [id]
  );
  if (!result.rows[0])
    throw new ApiFailure(404, "CAMPAIGN_NOT_FOUND", "Рассылка не найдена.");
  return result.rows[0];
}

export async function getAccount(client: Db, id: string): Promise<Account> {
  const result = await client.query<Account>(
    `SELECT ${accountFields("$2")} FROM accounts a JOIN account_groups g ON a.group_id = g.id WHERE a.id = $1`,
    [id, clock.now()]
  );
  if (!result.rows[0])
    throw new ApiFailure(404, "ACCOUNT_NOT_FOUND", "Аккаунт не найден.");
  return result.rows[0];
}

export async function getTask(client: Db, campaignId: string, taskId: string): Promise<Task> {
  const result = await client.query<Task>(
    `SELECT ${taskFields} FROM tasks t LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.campaign_id = $1 AND t.id = $2`,
    [campaignId, taskId]
  );
  if (!result.rows[0]) throw new ApiFailure(404, "TASK_NOT_FOUND", "Задача не найдена.");
  return result.rows[0];
}

export async function getAttempt(client: Db, id: string): Promise<Attempt> {
  const result = await client.query<Attempt>(
    `SELECT ${attemptFields} FROM attempts p JOIN accounts a ON a.id = p.account_id WHERE p.id = $1`,
    [id]
  );
  if (!result.rows[0]) throw new ApiFailure(404, "ATTEMPT_NOT_FOUND", "Попытка не найдена.");
  return result.rows[0];
}

export function listAttempts(client: Db, campaignId: string, taskId: string) {
  return client
    .query<Attempt>(
      `SELECT ${attemptFields} FROM attempts p JOIN accounts a ON a.id = p.account_id
       WHERE p.campaign_id = $1 AND p.task_id = $2 ORDER BY p.number`,
      [campaignId, taskId]
    )
    .then((result) => result.rows);
}

export function listGroups(pool: Db, input: ListInput) {
  return page<Group>(
    pool,
    groupFields,
    "FROM account_groups g WHERE g.name ILIKE $1",
    "g.created_at DESC, g.id",
    [searchPattern(input.q)],
    input
  );
}

export function accountFilter(
  input: { q: string; groupId?: string; status: string },
  params: unknown[],
  nowParam: string
) {
  params.push(searchPattern(input.q));
  // The clock parameter must be referenced even without a status filter, otherwise
  // PostgreSQL cannot type it in the count query.
  const clauses = [
    `${nowParam}::timestamptz IS NOT NULL`,
    `(a.email ILIKE $${params.length} OR g.name ILIKE $${params.length})`,
  ];
  if (input.groupId) {
    params.push(input.groupId);
    clauses.push(`a.group_id = $${params.length}`);
  }
  const status = accountStatusSql.replaceAll("$NOW", nowParam);
  if (input.status === "problem") {
    clauses.push(`${status} IN ('auth_error', 'needs_check', 'blocked', 'temporary_error')`);
  } else if (input.status !== "all") {
    params.push(input.status);
    clauses.push(`${status} = $${params.length}`);
  }
  return clauses.join(" AND ");
}

export function listAccounts(pool: Db, input: ListInput) {
  const params: unknown[] = [clock.now()];
  const where = accountFilter(input, params, "$1");
  return page<Account>(
    pool,
    accountFields("$1"),
    `FROM accounts a JOIN account_groups g ON a.group_id = g.id WHERE ${where}`,
    "a.email, a.id",
    params,
    input
  );
}

export function listCampaigns(pool: Db, input: ListInput) {
  const params: unknown[] = [searchPattern(input.q)];
  const clauses = ["(c.name ILIKE $1 OR c.subject ILIKE $1)"];
  if (input.groupId) {
    params.push(input.groupId);
    clauses.push(`c.group_id = $${params.length}`);
  }
  if (input.status === "active") clauses.push("c.status IN ('running', 'paused')");
  else if (input.status !== "all") {
    params.push(input.status);
    clauses.push(`c.status = $${params.length}`);
  }
  return page<CampaignSummary>(
    pool,
    campaignFields,
    `FROM campaigns c JOIN account_groups g ON c.group_id = g.id WHERE ${clauses.join(" AND ")}`,
    "c.updated_at DESC, c.id",
    params,
    input
  );
}

export function listTasks(pool: Db, campaignId: string, input: TaskListInput) {
  const params: unknown[] = [campaignId, searchPattern(input.q)];
  const clauses = ["t.campaign_id = $1", "t.email ILIKE $2"];
  if (input.status !== "all") {
    params.push(input.status);
    clauses.push(`t.status = $${params.length}`);
  }
  return page<Task>(
    pool,
    taskFields,
    `FROM tasks t LEFT JOIN accounts a ON a.id = t.account_id WHERE ${clauses.join(" AND ")}`,
    "t.position, t.id",
    params,
    input
  );
}

export function listEvents(pool: Db, input: EventListInput) {
  const params: unknown[] = [searchPattern(input.q)];
  const clauses = ["(e.title ILIKE $1 OR e.detail ILIKE $1)"];
  if (input.kind !== "all") {
    params.push(input.kind);
    clauses.push(`e.kind = $${params.length}`);
  }
  if (input.level !== "all") {
    params.push(input.level);
    clauses.push(`e.level = $${params.length}`);
  }
  if (input.campaignId) {
    params.push(input.campaignId);
    clauses.push(`e.campaign_id = $${params.length}`);
  }
  if (input.accountId) {
    params.push(input.accountId);
    clauses.push(`e.account_id = $${params.length}`);
  }
  return page<Event>(
    pool,
    eventFields,
    `FROM events e WHERE ${clauses.join(" AND ")}`,
    "e.created_at DESC, e.id DESC",
    params,
    input
  );
}

export async function listWorkers(pool: Db): Promise<WorkerInfo[]> {
  const settings = await loadSettingsRow(pool);
  const result = await pool.query<WorkerInfo>(
    `SELECT w.id, w.hostname, w.pid, w.sender_kind AS "senderKind", w.started_at AS "startedAt",
            w.last_heartbeat_at AS "lastHeartbeatAt",
            (w.stopped_at IS NULL AND w.last_heartbeat_at > $1::timestamptz - make_interval(secs => $2)) AS alive
     FROM workers w WHERE w.last_heartbeat_at > $1::timestamptz - interval '7 days'
     ORDER BY w.last_heartbeat_at DESC LIMIT 20`,
    [clock.now(), settings.heartbeat_stale_seconds]
  );
  return result.rows;
}

export interface SettingsRow {
  mode: AppMode;
  retry_max_attempts: number;
  retry_base_minutes: number;
  retry_max_minutes: number;
  sender_kind: "test" | "mail";
  test_sender_delay_ms: number;
  reservation_seconds: number;
  heartbeat_stale_seconds: number;
  updated_at: string;
}

export async function loadSettingsRow(client: Db): Promise<SettingsRow> {
  const result = await client.query<SettingsRow>(
    "SELECT * FROM app_settings WHERE singleton = true"
  );
  return result.rows[0];
}

export async function getSettings(
  client: Db,
  mode: AppMode,
  mailSenderAllowed: boolean
): Promise<Settings> {
  const row = await loadSettingsRow(client);
  return {
    mode,
    senderKind: row.sender_kind,
    mailSenderAllowed,
    retryMaxAttempts: row.retry_max_attempts,
    retryBaseMinutes: row.retry_base_minutes,
    retryMaxMinutes: row.retry_max_minutes,
    testSenderDelayMs: row.test_sender_delay_ms,
    updatedAt: row.updated_at,
  };
}

export function updateSettings(
  pool: Pool,
  mode: AppMode,
  mailSenderAllowed: boolean,
  input: UpdateSettings
) {
  return transaction(pool, async (client) => {
    const before = await loadSettingsRow(client);
    if (input.senderKind === "mail" && !mailSenderAllowed)
      throw new ApiFailure(
        403,
        "MAIL_SENDER_NOT_ALLOWED",
        "Реальная отправка через Mail недоступна в демонстрационном режиме и в удалённом Preview."
      );
    const next = {
      retry_max_attempts: input.retryMaxAttempts ?? before.retry_max_attempts,
      retry_base_minutes: input.retryBaseMinutes ?? before.retry_base_minutes,
      retry_max_minutes: input.retryMaxMinutes ?? before.retry_max_minutes,
      sender_kind: input.senderKind ?? before.sender_kind,
      test_sender_delay_ms: input.testSenderDelayMs ?? before.test_sender_delay_ms,
    };
    if (next.retry_max_minutes < next.retry_base_minutes)
      throw new ApiFailure(
        400,
        "VALIDATION_ERROR",
        "Максимальная пауза не может быть меньше первой паузы."
      );
    await client.query(
      `UPDATE app_settings SET retry_max_attempts = $1, retry_base_minutes = $2, retry_max_minutes = $3,
              sender_kind = $4, test_sender_delay_ms = $5, updated_at = now() WHERE singleton = true`,
      [
        next.retry_max_attempts,
        next.retry_base_minutes,
        next.retry_max_minutes,
        next.sender_kind,
        next.test_sender_delay_ms,
      ]
    );
    if (next.sender_kind !== before.sender_kind) {
      await recordEvent(client, {
        kind: "sender_mode_changed",
        level: "warning",
        title:
          next.sender_kind === "mail"
            ? "Включена реальная отправка через Mail"
            : "Включён тестовый отправитель",
        detail:
          next.sender_kind === "mail"
            ? "Новые отправки пойдут через smtp.mail.ru с сохранёнными паролями приложений."
            : "Письма во внешний мир не отправляются.",
      });
    } else {
      await recordEvent(client, {
        kind: "settings_updated",
        title: "Изменены настройки повторов",
        detail: `Повторов: ${next.retry_max_attempts}, первая пауза ${next.retry_base_minutes} мин, максимум ${next.retry_max_minutes} мин.`,
      });
    }
    return getSettings(client, mode, mailSenderAllowed);
  });
}

export async function getOverview(
  pool: Pool,
  mode: AppMode,
  since: Date,
  senderKind: "test" | "mail"
): Promise<Overview> {
  const now = clock.now();
  const status = accountStatusSql.replaceAll("$NOW", "$1");
  const [counts, active, recent, events, workers] = await Promise.all([
    pool.query<
      Pick<
        Overview,
        | "acceptedSince"
        | "queuedTasks"
        | "sendingTasks"
        | "unclearTasks"
        | "accountCount"
        | "availableAccountCount"
        | "problemAccountCount"
        | "groupCount"
        | "campaignCount"
      >
    >(
      `SELECT
        (SELECT count(*)::int FROM attempts p WHERE p.outcome = 'accepted' AND p.finished_at >= $2) AS "acceptedSince",
        (SELECT count(*)::int FROM tasks t JOIN campaigns c ON c.id = t.campaign_id
          WHERE t.status IN ('pending', 'reserved') AND c.status IN ('running', 'paused')) AS "queuedTasks",
        (SELECT count(*)::int FROM tasks t WHERE t.status = 'sending') AS "sendingTasks",
        (SELECT count(*)::int FROM tasks t WHERE t.status = 'unclear') AS "unclearTasks",
        (SELECT count(*)::int FROM accounts) AS "accountCount",
        (SELECT count(*)::int FROM accounts a WHERE ${status} IN ('active', 'unverified')) AS "availableAccountCount",
        (SELECT count(*)::int FROM accounts a WHERE ${status} IN ('auth_error', 'needs_check', 'blocked', 'temporary_error')) AS "problemAccountCount",
        (SELECT count(*)::int FROM account_groups) AS "groupCount",
        (SELECT count(*)::int FROM campaigns) AS "campaignCount"`,
      [now, since]
    ),
    pool.query<CampaignSummary>(
      `SELECT ${campaignFields} FROM campaigns c JOIN account_groups g ON c.group_id = g.id
       WHERE c.status IN ('running', 'paused') ORDER BY c.started_at DESC NULLS LAST, c.id LIMIT 10`
    ),
    pool.query<CampaignSummary>(
      `SELECT ${campaignFields} FROM campaigns c JOIN account_groups g ON c.group_id = g.id
       ORDER BY c.updated_at DESC, c.id LIMIT 5`
    ),
    pool.query<Event>(`SELECT ${eventFields} FROM events e ORDER BY e.created_at DESC, e.id DESC LIMIT 8`),
    listWorkers(pool),
  ]);
  return {
    ...counts.rows[0],
    mode,
    senderKind,
    sendingEnabled: senderKind === "mail",
    since: since.toISOString(),
    activeCampaigns: active.rows,
    recentCampaigns: recent.rows,
    recentEvents: events.rows,
    workers,
  };
}

export function createGroup(pool: Pool, input: CreateGroup) {
  return transaction(pool, async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO account_groups(id, request_key, name, color, limit_count, period_hours)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (request_key) DO NOTHING RETURNING id`,
      [randomUUID(), input.requestKey, input.name, input.color, input.limitCount, input.periodHours]
    );
    let id = inserted.rows[0]?.id;
    if (!id) {
      const existing = await client.query<{ id: string }>(
        "SELECT id FROM account_groups WHERE request_key = $1",
        [input.requestKey]
      );
      id = existing.rows[0].id;
      const group = await selectGroup(client, id);
      if (
        group.name !== input.name ||
        group.color !== input.color ||
        group.limitCount !== input.limitCount ||
        group.periodHours !== input.periodHours
      ) {
        throw new ApiFailure(
          409,
          "REQUEST_CONFLICT",
          "Этот запрос уже выполнен с другими данными. Повторите сохранение."
        );
      }
      return { value: group, created: false };
    }
    await recordEvent(client, {
      kind: "group_created",
      title: "Создана группа аккаунтов",
      detail: input.name,
      entityType: "group",
      entityId: id,
    });
    return { value: await selectGroup(client, id), created: true };
  });
}

function sameDraft(draft: Campaign, input: CreateDraft | UpdateDraft) {
  return (
    draft.name === input.name &&
    draft.groupId === input.groupId &&
    draft.subject === input.subject &&
    draft.body === input.body &&
    draft.senderName === input.senderName
  );
}

export function createCampaign(pool: Pool, input: CreateDraft) {
  return transaction(pool, async (client) => {
    await selectGroup(client, input.groupId);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO campaigns(id, request_key, group_id, name, subject, body, sender_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (request_key) DO NOTHING RETURNING id`,
      [randomUUID(), input.requestKey, input.groupId, input.name, input.subject, input.body, input.senderName]
    );
    let id = inserted.rows[0]?.id;
    if (!id) {
      const existing = await client.query<{ id: string }>(
        "SELECT id FROM campaigns WHERE request_key = $1",
        [input.requestKey]
      );
      id = existing.rows[0].id;
      const draft = await getCampaign(client, id);
      if (!sameDraft(draft, input)) {
        throw new ApiFailure(
          409,
          "REQUEST_CONFLICT",
          "Этот запрос уже сохранён с другими данными. Обновите список рассылок."
        );
      }
      return { value: draft, created: false };
    }
    await recordEvent(client, {
      kind: "draft_created",
      title: "Сохранён новый черновик",
      detail: input.name,
      campaignId: id,
    });
    return { value: await getCampaign(client, id), created: true };
  });
}

export function updateCampaign(pool: Pool, id: string, input: UpdateDraft) {
  return transaction(pool, async (client) => {
    await selectGroup(client, input.groupId);
    const locked = await client.query<{ status: string }>(
      "SELECT status FROM campaigns WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (!locked.rowCount) throw new ApiFailure(404, "CAMPAIGN_NOT_FOUND", "Рассылка не найдена.");
    const existing = await getCampaign(client, id);
    if (existing.revision !== input.revision) {
      // A retry after a lost response must not overwrite another edit.
      if (existing.revision === input.revision + 1 && sameDraft(existing, input)) return existing;
      throw new ApiFailure(
        409,
        "REVISION_CONFLICT",
        "Черновик изменён в другом окне. Скопируйте свой текст и откройте актуальную версию."
      );
    }
    if (sameDraft(existing, input)) return existing;
    if (locked.rows[0].status !== "draft")
      throw new ApiFailure(
        409,
        "INVALID_STATE",
        "Тема, текст и получатели зафиксированы при запуске. Создайте новую рассылку."
      );
    await client.query(
      `UPDATE campaigns SET group_id = $2, name = $3, subject = $4, body = $5, sender_name = $6,
                            revision = revision + 1, updated_at = now() WHERE id = $1`,
      [id, input.groupId, input.name, input.subject, input.body, input.senderName]
    );
    await recordEvent(client, {
      kind: "draft_updated",
      title: "Обновлён черновик",
      detail: input.name,
      campaignId: id,
    });
    return getCampaign(client, id);
  });
}
