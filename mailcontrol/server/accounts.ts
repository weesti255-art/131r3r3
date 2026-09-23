import type { Pool, PoolClient } from "pg";
import type {
  Account,
  AccountCheckResult,
  AccountImportPreview,
  AccountImportResult,
  BulkAccountResult,
  ImportErrorRow,
  ImportFormat,
  ImportPreviewRow,
} from "../shared/contracts.js";
import { parseAccounts } from "../shared/parsing.js";
import { clock } from "./clock.js";
import type { KeyStore } from "./crypto.js";
import { transaction } from "./database.js";
import { ApiFailure } from "./errors.js";
import { recordEvent } from "./events.js";
import {
  accountFilter,
  getAccount,
  selectGroup,
} from "./repository.js";
import type { Sender } from "./sender/types.js";
import type { BulkAccountInput } from "./validation.js";

const PREVIEW_ROWS = 500;
const MAX_ROWS = 20000;

export function accountTemplate(format: ImportFormat) {
  return format === "csv"
    ? "email,app_password\r\nuser1@mail.ru,пароль-приложения-1\r\n\"user2@inbox.ru\",\"пароль-приложения-2\"\r\n"
    : "user1@mail.ru | пароль-приложения-1\r\nuser2@inbox.ru | пароль-приложения-2\r\n";
}

export async function previewAccountImport(
  pool: Pool,
  text: string,
  format: ImportFormat
): Promise<AccountImportPreview> {
  const parsed = parseAccounts(text, format);
  if (parsed.length > MAX_ROWS)
    throw new ApiFailure(
      400,
      "TOO_MANY_ROWS",
      `За один импорт принимается не более ${MAX_ROWS} строк. Разделите файл.`
    );
  const emails = [...new Set(parsed.filter((row) => row.ok).map((row) => row.email))];
  const existing = await pool.query<{ email: string; group_id: string; name: string }>(
    `SELECT a.email, a.group_id, g.name FROM accounts a JOIN account_groups g ON g.id = a.group_id
     WHERE a.email = ANY($1::text[])`,
    [emails]
  );
  const known = new Map(existing.rows.map((row) => [row.email, row]));
  const seen = new Set<string>();
  const rows: ImportPreviewRow[] = [];
  let newCount = 0;
  let duplicateCount = 0;
  let errorCount = 0;
  for (const row of parsed) {
    let preview: ImportPreviewRow;
    if (!row.ok) {
      errorCount++;
      preview = { line: row.line, email: row.email, kind: "error", reason: row.reason, existingGroupName: null, existingGroupId: null };
    } else if (seen.has(row.email)) {
      errorCount++;
      preview = { line: row.line, email: row.email, kind: "error", reason: "Адрес повторяется в этом же импорте", existingGroupName: null, existingGroupId: null };
    } else {
      seen.add(row.email);
      const current = known.get(row.email);
      if (current) {
        duplicateCount++;
        preview = { line: row.line, email: row.email, kind: "duplicate", reason: null, existingGroupName: current.name, existingGroupId: current.group_id };
      } else {
        newCount++;
        preview = { line: row.line, email: row.email, kind: "new", reason: null, existingGroupName: null, existingGroupId: null };
      }
    }
    if (rows.length < PREVIEW_ROWS) rows.push(preview);
  }
  return { rows, newCount, duplicateCount, errorCount, truncated: parsed.length > PREVIEW_ROWS };
}

export interface AccountImportInput {
  text: string;
  format: ImportFormat;
  groupId: string;
  limitCount: number;
  periodHours: number;
  duplicateAction: "keep" | "move";
  requestKey: string;
}

export function importAccounts(
  pool: Pool,
  keys: KeyStore,
  input: AccountImportInput
): Promise<AccountImportResult> {
  return transaction(pool, async (client) => {
    const repeated = await client.query<{ result: AccountImportResult }>(
      "SELECT result FROM import_requests WHERE request_key = $1",
      [input.requestKey]
    );
    if (repeated.rows[0]) return { ...repeated.rows[0].result, repeated: true };
    const group = await selectGroup(client, input.groupId);
    const parsed = parseAccounts(input.text, input.format);
    if (parsed.length > MAX_ROWS)
      throw new ApiFailure(400, "TOO_MANY_ROWS", `За один импорт принимается не более ${MAX_ROWS} строк.`);
    const errors: ImportErrorRow[] = [];
    const seen = new Set<string>();
    let added = 0;
    let duplicatesKept = 0;
    let duplicatesMoved = 0;
    const movedIds: string[] = [];
    for (const row of parsed) {
      if (!row.ok) {
        errors.push({ line: row.line, email: row.email, reason: row.reason });
        continue;
      }
      if (seen.has(row.email)) {
        errors.push({ line: row.line, email: row.email, reason: "Адрес повторяется в этом же импорте" });
        continue;
      }
      seen.add(row.email);
      const existing = await client.query<{ id: string }>(
        "SELECT id FROM accounts WHERE email = $1 FOR UPDATE",
        [row.email]
      );
      if (existing.rows[0]) {
        // The stored password is never replaced silently by an import.
        if (input.duplicateAction === "move") {
          await client.query(
            `UPDATE accounts SET group_id = $2, limit_count = $3, period_hours = $4, updated_at = now() WHERE id = $1`,
            [existing.rows[0].id, input.groupId, input.limitCount, input.periodHours]
          );
          movedIds.push(existing.rows[0].id);
          duplicatesMoved++;
        } else duplicatesKept++;
        continue;
      }
      const encrypted = await keys.encrypt(row.password);
      await client.query(
        `INSERT INTO accounts(id, email, group_id, limit_count, period_hours, is_demo,
                              password_ciphertext, password_key_id, connection_status)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, false, $5, $6, 'unverified')`,
        [row.email, input.groupId, input.limitCount, input.periodHours, encrypted.ciphertext, encrypted.keyId]
      );
      added++;
    }
    const result: AccountImportResult = {
      added,
      duplicatesKept,
      duplicatesMoved,
      errors: errors.slice(0, 5000),
      errorCount: errors.length,
      repeated: false,
    };
    await client.query(
      "INSERT INTO import_requests(request_key, kind, result) VALUES ($1, 'accounts', $2)",
      [input.requestKey, JSON.stringify(result)]
    );
    await recordEvent(client, {
      kind: "accounts_imported",
      title: "Импорт аккаунтов",
      detail: `Группа «${group.name}», лимит ${input.limitCount}/${input.periodHours} ч: добавлено ${added}, дублей оставлено ${duplicatesKept}, перенесено ${duplicatesMoved}, ошибок ${errors.length}.`,
      entityType: "group",
      entityId: group.id,
    });
    for (const id of movedIds)
      await recordEvent(client, {
        kind: "account_moved",
        title: "Аккаунт перенесён при импорте",
        detail: `В группу «${group.name}», лимит ${input.limitCount}/${input.periodHours} ч. История и расход лимита сохранены.`,
        accountId: id,
      });
    return result;
  });
}

async function selectTargets(
  client: Pool | PoolClient,
  input: BulkAccountInput,
  lock: boolean
) {
  const forUpdate = lock ? "FOR UPDATE" : "";
  if (input.ids && input.ids.length) {
    const result = await client.query<{ id: string; email: string }>(
      `SELECT id, email FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY email ${forUpdate}`,
      [input.ids]
    );
    return result.rows;
  }
  const params: unknown[] = [clock.now()];
  const where = accountFilter(
    { q: input.filter?.q ?? "", groupId: input.filter?.groupId, status: input.filter?.status ?? "all" },
    params,
    "$1"
  );
  const result = await client.query<{ id: string; email: string }>(
    `SELECT a.id, a.email FROM accounts a JOIN account_groups g ON a.group_id = g.id WHERE ${where}
     ORDER BY a.email ${lock ? "FOR UPDATE OF a" : ""}`,
    params
  );
  return result.rows;
}

export async function bulkAccounts(
  pool: Pool,
  input: BulkAccountInput,
  checker: (ids: string[]) => Promise<{ ok: number; problems: number }>
): Promise<BulkAccountResult> {
  if (input.action === "check") {
    // Checks talk to the sender per account, so they must not hold row locks.
    const repeated = await pool.query<{ result: BulkAccountResult }>(
      "SELECT result FROM import_requests WHERE request_key = $1",
      [input.requestKey]
    );
    if (repeated.rows[0]) return repeated.rows[0].result;
    const ids = (await selectTargets(pool, input, false)).map((row) => row.id);
    const result: BulkAccountResult = { affected: ids.length, checked: await checker(ids) };
    await pool.query(
      "INSERT INTO import_requests(request_key, kind, result) VALUES ($1, 'bulk', $2) ON CONFLICT DO NOTHING",
      [input.requestKey, JSON.stringify(result)]
    );
    return result;
  }
  return transaction(pool, async (client) => {
    const repeated = await client.query<{ result: BulkAccountResult }>(
      "SELECT result FROM import_requests WHERE request_key = $1",
      [input.requestKey]
    );
    if (repeated.rows[0]) return repeated.rows[0].result;
    const targets = await selectTargets(client, input, true);
    const ids = targets.map((row) => row.id);
    const result: BulkAccountResult = { affected: ids.length };
    if (ids.length === 0) return result;
    switch (input.action) {
      case "set_limit":
        await client.query(
          "UPDATE accounts SET limit_count = $2, period_hours = $3, updated_at = now() WHERE id = ANY($1::uuid[])",
          [ids, input.limitCount, input.periodHours]
        );
        await recordEvent(client, {
          kind: "accounts_limit_changed",
          title: "Изменён лимит аккаунтов",
          detail: `${ids.length} аккаунтов: ${input.limitCount} писем / ${input.periodHours} ч. История отправок сохранена.`,
        });
        break;
      case "move": {
        const group = await selectGroup(client, input.groupId);
        await client.query(
          "UPDATE accounts SET group_id = $2, updated_at = now() WHERE id = ANY($1::uuid[])",
          [ids, input.groupId]
        );
        await recordEvent(client, {
          kind: "accounts_moved",
          title: "Аккаунты перенесены в другую группу",
          detail: `${ids.length} аккаунтов → «${group.name}». Начатые отправки завершатся, новые пойдут по новой группе.`,
          entityType: "group",
          entityId: group.id,
        });
        break;
      }
      case "disable":
        await client.query(
          `UPDATE accounts SET manual_disabled = true, disabled_at = $2, disabled_reason = 'Отключён вручную', updated_at = now()
           WHERE id = ANY($1::uuid[]) AND NOT manual_disabled`,
          [ids, clock.now()]
        );
        await recordEvent(client, {
          kind: "accounts_disabled",
          level: "warning",
          title: "Аккаунты отключены вручную",
          detail: `${ids.length} аккаунтов. Автоматически они не восстанавливаются.`,
        });
        break;
      case "enable":
        await client.query(
          `UPDATE accounts SET manual_disabled = false, disabled_at = NULL, disabled_reason = NULL,
             connection_status = CASE WHEN connection_status IN ('auth_error', 'needs_check', 'blocked') THEN 'unverified' ELSE connection_status END,
             connection_error = NULL, cooldown_until = NULL, updated_at = now()
           WHERE id = ANY($1::uuid[])`,
          [ids]
        );
        await recordEvent(client, {
          kind: "accounts_enabled",
          title: "Аккаунты включены оператором",
          detail: `${ids.length} аккаунтов. Отметки об ошибках подключения сброшены до следующей проверки.`,
        });
        break;
    }
    await client.query(
      "INSERT INTO import_requests(request_key, kind, result) VALUES ($1, 'bulk', $2)",
      [input.requestKey, JSON.stringify(result)]
    );
    return result;
  });
}

interface CredentialRow {
  id: string;
  email: string;
  password_ciphertext: string | null;
  password_key_id: string | null;
  is_demo: boolean;
}

export async function loadCredentials(client: Pool | PoolClient, keys: KeyStore, accountId: string) {
  const result = await client.query<CredentialRow>(
    "SELECT id, email, password_ciphertext, password_key_id, is_demo FROM accounts WHERE id = $1",
    [accountId]
  );
  const row = result.rows[0];
  if (!row) throw new ApiFailure(404, "ACCOUNT_NOT_FOUND", "Аккаунт не найден.");
  if (!row.password_ciphertext || !row.password_key_id)
    return { email: row.email, password: "", demo: true };
  return {
    email: row.email,
    password: await keys.decrypt(row.password_ciphertext, row.password_key_id),
    demo: false,
  };
}

export function connectionStatusFor(category: string) {
  switch (category) {
    case "auth":
      return "auth_error";
    case "needs_check":
      return "needs_check";
    case "account_blocked":
      return "blocked";
    default:
      return "temporary_error";
  }
}

/** Connection check without a letter; the label says which sender did it. */
export async function checkAccount(
  pool: Pool,
  keys: KeyStore,
  sender: Sender,
  accountId: string,
  cooldownMinutes = 15
): Promise<AccountCheckResult> {
  const credentials = await loadCredentials(pool, keys, accountId);
  if (credentials.demo && sender.kind === "mail")
    throw new ApiFailure(
      409,
      "DEMO_ACCOUNT",
      "У демонстрационного аккаунта нет пароля — подключение к Mail невозможно."
    );
  const outcome = await sender.check(credentials);
  await transaction(pool, async (client) => {
    if (outcome.kind === "ok") {
      await client.query(
        `UPDATE accounts SET connection_status = 'ok', connection_error = NULL, cooldown_until = NULL,
                             connection_checked_at = $2, updated_at = now() WHERE id = $1`,
        [accountId, clock.now()]
      );
    } else {
      const status = connectionStatusFor(outcome.category);
      await client.query(
        `UPDATE accounts SET connection_status = $2, connection_error = $3, connection_checked_at = $4,
                             cooldown_until = CASE WHEN $2 = 'temporary_error' THEN $4::timestamptz + make_interval(mins => $5) ELSE NULL END,
                             updated_at = now() WHERE id = $1`,
        [accountId, status, outcome.message.slice(0, 500), clock.now(), cooldownMinutes]
      );
    }
    await recordEvent(client, {
      kind: "account_checked",
      level: outcome.kind === "ok" ? "info" : "warning",
      title: outcome.kind === "ok" ? "Проверка подключения пройдена" : "Проверка подключения не пройдена",
      detail: `${credentials.email}: ${outcome.kind === "ok" ? outcome.response : outcome.message} (${sender.kind === "mail" ? "Mail SMTP" : "тестовый отправитель, не Mail"})`,
      accountId,
    });
  });
  return {
    account: await getAccount(pool, accountId),
    method: sender.kind === "mail" ? "mail_smtp" : "test_sender",
  };
}

export async function checkMany(
  pool: Pool,
  keys: KeyStore,
  sender: Sender,
  ids: string[]
) {
  let ok = 0;
  let problems = 0;
  for (const id of ids.slice(0, 200)) {
    try {
      const result = await checkAccount(pool, keys, sender, id);
      if (["active", "unverified", "quota_exhausted"].includes(result.account.status)) ok++;
      else problems++;
    } catch {
      problems++;
    }
  }
  return { ok, problems };
}
