import type { Pool, PoolClient } from "pg";
import type { EventLevel } from "../shared/contracts.js";

export interface EventInput {
  kind: string;
  title: string;
  detail: string;
  level?: EventLevel;
  entityType?: string;
  entityId?: string | null;
  campaignId?: string | null;
  accountId?: string | null;
  taskId?: string | number | null;
  attemptId?: string | number | null;
}

export async function recordEvent(
  client: Pool | PoolClient,
  input: EventInput
) {
  const entityType =
    input.entityType ??
    (input.campaignId ? "campaign" : input.accountId ? "account" : "system");
  await client.query(
    `INSERT INTO events(kind, level, title, detail, entity_type, entity_id, campaign_id, account_id, task_id, attempt_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.kind,
      input.level ?? "info",
      input.title,
      input.detail.slice(0, 2000),
      entityType,
      input.entityId ?? input.campaignId ?? input.accountId ?? null,
      input.campaignId ?? null,
      input.accountId ?? null,
      input.taskId ?? null,
      input.attemptId ?? null,
    ]
  );
}
