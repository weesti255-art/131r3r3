import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  Account,
  Campaign,
  CampaignSummary,
  CreateDraft,
  CreateGroup,
  Event,
  Group,
  Overview,
  Page,
  UpdateDraft,
  AppMode,
} from "../shared/contracts.js";
import { transaction } from "./database.js";
import { ApiFailure } from "./errors.js";
import { searchPattern, type ListInput } from "./validation.js";

const groupFields = `g.id, g.name, g.color, g.limit_count AS "limitCount",
  g.period_hours AS "periodHours", g.created_at AS "createdAt",
  (SELECT count(*)::int FROM accounts a WHERE a.group_id = g.id) AS "accountCount"`;
const campaignFields = `c.id, c.name, c.group_id AS "groupId", g.name AS "groupName",
  g.color AS "groupColor", c.subject, left(c.body, 160) AS "bodyPreview",
  c.sender_name AS "senderName", c.status, c.revision,
  c.created_at AS "createdAt", c.updated_at AS "updatedAt"`;
const eventFields = `e.id::text, e.kind, e.title, e.detail, e.entity_type AS "entityType",
  e.entity_id AS "entityId", e.created_at AS "createdAt"`;

async function page<T extends object>(
  pool: Pool,
  fields: string,
  from: string,
  order: string,
  params: unknown[],
  input: ListInput
): Promise<Page<T>> {
  const [result, count] = await Promise.all([
    pool.query<T>(
      `SELECT ${fields} ${from} ORDER BY ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, input.pageSize, (input.page - 1) * input.pageSize]
    ),
    pool.query<{ count: number }>(
      `SELECT count(*)::int AS count ${from}`,
      params
    ),
  ]);
  return {
    items: result.rows,
    total: count.rows[0].count,
    page: input.page,
    pageSize: input.pageSize,
  };
}

async function selectGroup(
  client: Pool | PoolClient,
  id: string
): Promise<Group> {
  const result = await client.query<Group>(
    `SELECT ${groupFields} FROM account_groups g WHERE g.id = $1`,
    [id]
  );
  if (!result.rows[0])
    throw new ApiFailure(
      404,
      "GROUP_NOT_FOUND",
      "Группа не найдена. Обновите список."
    );
  return result.rows[0];
}

export async function getCampaign(
  client: Pool | PoolClient,
  id: string
): Promise<Campaign> {
  const result = await client.query<Campaign>(
    `SELECT ${campaignFields}, c.body FROM campaigns c JOIN account_groups g ON g.id = c.group_id WHERE c.id = $1`,
    [id]
  );
  if (!result.rows[0])
    throw new ApiFailure(404, "DRAFT_NOT_FOUND", "Черновик не найден.");
  return result.rows[0];
}

export function listGroups(pool: Pool, input: ListInput) {
  return page<Group>(
    pool,
    groupFields,
    "FROM account_groups g WHERE g.name ILIKE $1",
    "g.created_at DESC, g.id",
    [searchPattern(input.q)],
    input
  );
}

export function listAccounts(pool: Pool, input: ListInput) {
  const params: unknown[] = [searchPattern(input.q)];
  const clauses = ["(a.email ILIKE $1 OR g.name ILIKE $1)"];
  if (input.groupId) {
    params.push(input.groupId);
    clauses.push(`a.group_id = $${params.length}`);
  }
  if (input.status === "problem") {
    clauses.push("a.health_status IN ('auth_error', 'needs_check')");
  } else if (input.status !== "all") {
    params.push(input.status);
    clauses.push(`a.health_status = $${params.length}`);
  }
  return page<Account>(
    pool,
    `a.id, a.email, a.group_id AS "groupId", g.name AS "groupName", g.color AS "groupColor",
     a.health_status AS status, a.limit_count AS "limitCount", a.period_hours AS "periodHours", a.is_demo AS demo`,
    `FROM accounts a JOIN account_groups g ON a.group_id = g.id WHERE ${clauses.join(" AND ")}`,
    "a.email, a.id",
    params,
    input
  );
}

export function listCampaigns(pool: Pool, input: ListInput) {
  const params: unknown[] = [searchPattern(input.q)];
  let from =
    "FROM campaigns c JOIN account_groups g ON c.group_id = g.id WHERE (c.name ILIKE $1 OR c.subject ILIKE $1)";
  if (input.groupId) {
    params.push(input.groupId);
    from += " AND c.group_id = $2";
  }
  return page<CampaignSummary>(
    pool,
    campaignFields,
    from,
    "c.updated_at DESC, c.id",
    params,
    input
  );
}

export function listEvents(pool: Pool, input: ListInput) {
  const params: unknown[] = [searchPattern(input.q)];
  let from = "FROM events e WHERE (e.title ILIKE $1 OR e.detail ILIKE $1)";
  if (input.kind !== "all") {
    params.push(input.kind);
    from += " AND e.kind = $2";
  }
  return page<Event>(
    pool,
    eventFields,
    from,
    "e.created_at DESC, e.id DESC",
    params,
    input
  );
}

export async function getOverview(
  pool: Pool,
  mode: AppMode
): Promise<Overview> {
  const [count, campaigns, events] = await Promise.all([
    pool.query<
      Pick<
        Overview,
        "accountCount" | "groupCount" | "draftCount" | "problemAccountCount"
      >
    >(`
      SELECT (SELECT count(*)::int FROM accounts) AS "accountCount",
             (SELECT count(*)::int FROM account_groups) AS "groupCount",
             (SELECT count(*)::int FROM campaigns) AS "draftCount",
             (SELECT count(*)::int FROM accounts WHERE health_status IN ('auth_error', 'needs_check')) AS "problemAccountCount"
    `),
    pool.query<CampaignSummary>(
      `SELECT ${campaignFields} FROM campaigns c JOIN account_groups g ON c.group_id = g.id ORDER BY c.updated_at DESC, c.id LIMIT 3`
    ),
    pool.query<Event>(
      `SELECT ${eventFields} FROM events e ORDER BY e.created_at DESC, e.id DESC LIMIT 5`
    ),
  ]);
  return {
    ...count.rows[0],
    mode,
    sendingEnabled: false,
    acceptedToday: 0,
    queuedTasks: 0,
    recentCampaigns: campaigns.rows,
    recentEvents: events.rows,
  };
}

export function createGroup(pool: Pool, input: CreateGroup) {
  return transaction(pool, async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO account_groups(id, request_key, name, color, limit_count, period_hours)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (request_key) DO NOTHING RETURNING id`,
      [
        randomUUID(),
        input.requestKey,
        input.name,
        input.color,
        input.limitCount,
        input.periodHours,
      ]
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
    await client.query(
      `INSERT INTO events(kind, title, detail, entity_type, entity_id)
       VALUES ('group_created', 'Создана группа аккаунтов', $1, 'group', $2)`,
      [input.name, id]
    );
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
      [
        randomUUID(),
        input.requestKey,
        input.groupId,
        input.name,
        input.subject,
        input.body,
        input.senderName,
      ]
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
          "Этот запрос уже сохранён с другими данными. Обновите список черновиков."
        );
      }
      return { value: draft, created: false };
    }
    await client.query(
      `INSERT INTO events(kind, title, detail, entity_type, entity_id)
       VALUES ('draft_created', 'Сохранён новый черновик', $1, 'campaign', $2)`,
      [input.name, id]
    );
    return { value: await getCampaign(client, id), created: true };
  });
}

export function updateCampaign(pool: Pool, id: string, input: UpdateDraft) {
  return transaction(pool, async (client) => {
    await selectGroup(client, input.groupId);
    const locked = await client.query(
      "SELECT id FROM campaigns WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (!locked.rowCount)
      throw new ApiFailure(404, "DRAFT_NOT_FOUND", "Черновик не найден.");
    const existing = await getCampaign(client, id);
    if (existing.revision !== input.revision) {
      // A retry after a lost response must not overwrite another edit.
      if (
        existing.revision === input.revision + 1 &&
        sameDraft(existing, input)
      )
        return existing;
      throw new ApiFailure(
        409,
        "REVISION_CONFLICT",
        "Черновик изменён в другом окне. Скопируйте свой текст и откройте актуальную версию."
      );
    }
    if (sameDraft(existing, input)) return existing;
    await client.query(
      `UPDATE campaigns SET group_id = $2, name = $3, subject = $4, body = $5, sender_name = $6,
                            revision = revision + 1, updated_at = now() WHERE id = $1`,
      [
        id,
        input.groupId,
        input.name,
        input.subject,
        input.body,
        input.senderName,
      ]
    );
    await client.query(
      `INSERT INTO events(kind, title, detail, entity_type, entity_id)
       VALUES ('draft_updated', 'Обновлён черновик', $1, 'campaign', $2)`,
      [input.name, id]
    );
    return getCampaign(client, id);
  });
}
