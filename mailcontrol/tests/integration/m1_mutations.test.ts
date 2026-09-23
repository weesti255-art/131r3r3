import { strict as assert } from "node:assert";
import { after, describe, it } from "node:test";
import {
  cleanupTestDatabases,
  jsonRequest,
  responseJson,
  uuid,
  withTestApp,
} from "./helpers.js";

after(cleanupTestDatabases);

describe("M1 idempotent mutations and optimistic drafts", () => {
  it("creates a group once for repeated and parallel requests", async () => {
    await withTestApp("local", async ({ app, pool }) => {
      const input = {
        name: "Одна группа",
        color: "violet",
        limitCount: 37,
        periodHours: 48,
        requestKey: uuid(),
      };
      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          jsonRequest(app, "POST", "/api/groups", input)
        )
      );
      assert.equal(
        responses.filter((response) => response.statusCode === 201).length,
        1
      );
      assert.equal(
        responses.filter((response) => response.statusCode === 200).length,
        7
      );
      const ids = new Set(
        responses.map((response) => responseJson<{ id: string }>(response).id)
      );
      assert.equal(ids.size, 1);

      const rows = await pool.query<{ groups: number; events: number }>(`
        SELECT
          (SELECT count(*)::int FROM account_groups) AS groups,
          (SELECT count(*)::int FROM events WHERE kind = 'group_created') AS events
      `);
      assert.deepEqual(rows.rows[0], { groups: 1, events: 1 });

      const duplicateName = await jsonRequest(app, "POST", "/api/groups", {
        ...input,
        requestKey: uuid(),
        limitCount: 99,
      });
      assert.equal(duplicateName.statusCode, 409);
      assert.equal(
        responseJson<{ error: { code: string } }>(duplicateName).error.code,
        "ALREADY_EXISTS"
      );
      const afterDuplicate = await pool.query<{
        groups: number;
        events: number;
      }>(`
        SELECT
          (SELECT count(*)::int FROM account_groups) AS groups,
          (SELECT count(*)::int FROM events WHERE kind = 'group_created') AS events
      `);
      assert.deepEqual(afterDuplicate.rows[0], { groups: 1, events: 1 });
    });
  });

  it("keeps positive group limits and does not rewrite demo account limits", async () => {
    await withTestApp("demo", async ({ app, pool }) => {
      const before = await pool.query<{
        email: string;
        limit_count: number;
        period_hours: number;
      }>(
        "SELECT email, limit_count, period_hours FROM accounts ORDER BY email"
      );
      const response = await jsonRequest(app, "POST", "/api/groups", {
        name: "Новая пачка",
        color: "amber",
        limitCount: 99,
        periodHours: 72,
        requestKey: uuid(),
      });
      assert.equal(response.statusCode, 201);
      const group = responseJson<{
        limitCount: number;
        periodHours: number;
        accountCount: number;
      }>(response);
      assert.equal(group.limitCount, 99);
      assert.equal(group.periodHours, 72);
      assert.equal(group.accountCount, 0);

      const after = await pool.query<{
        email: string;
        limit_count: number;
        period_hours: number;
      }>(
        "SELECT email, limit_count, period_hours FROM accounts ORDER BY email"
      );
      assert.deepEqual(after.rows, before.rows);
      assert.ok(
        after.rows.every((row) => row.limit_count > 0 && row.period_hours > 0)
      );
    });
  });

  it("deduplicates draft creation and protects revisions after a lost response", async () => {
    await withTestApp("local", async ({ app, pool }) => {
      const groupResponse = await jsonRequest(app, "POST", "/api/groups", {
        name: "Группа черновиков",
        color: "blue",
        limitCount: 10,
        periodHours: 24,
        requestKey: uuid(),
      });
      assert.equal(groupResponse.statusCode, 201);
      const groupId = responseJson<{ id: string }>(groupResponse).id;
      const input = {
        name: "Многострочное письмо",
        groupId,
        subject: "Тема",
        body: "Начало\n\nПродолжение",
        senderName: "",
        requestKey: uuid(),
      };
      const responses = await Promise.all(
        Array.from({ length: 6 }, () =>
          jsonRequest(app, "POST", "/api/campaigns", input)
        )
      );
      assert.equal(
        responses.filter((response) => response.statusCode === 201).length,
        1
      );
      assert.equal(
        responses.filter((response) => response.statusCode === 200).length,
        5
      );
      const draftIds = new Set(
        responses.map((response) => responseJson<{ id: string }>(response).id)
      );
      assert.equal(draftIds.size, 1);
      const draftId = [...draftIds][0];

      const countsAfterCreate = await pool.query<{
        drafts: number;
        events: number;
      }>(`
        SELECT
          (SELECT count(*)::int FROM campaigns) AS drafts,
          (SELECT count(*)::int FROM events WHERE kind = 'draft_created') AS events
      `);
      assert.deepEqual(countsAfterCreate.rows[0], { drafts: 1, events: 1 });

      const requestConflict = await jsonRequest(app, "POST", "/api/campaigns", {
        ...input,
        subject: "Другие данные",
      });
      assert.equal(requestConflict.statusCode, 409);
      assert.equal(
        responseJson<{ error: { code: string } }>(requestConflict).error.code,
        "REQUEST_CONFLICT"
      );

      const update = {
        name: input.name,
        groupId,
        subject: input.subject,
        body: "Обновлённый текст\nВторая строка",
        senderName: "Имя отправителя",
        revision: 1,
      };
      const updateResponse = await jsonRequest(
        app,
        "PATCH",
        `/api/campaigns/${draftId}`,
        update
      );
      assert.equal(updateResponse.statusCode, 200);
      const updated = responseJson<{ revision: number; body: string }>(
        updateResponse
      );
      assert.equal(updated.revision, 2);
      assert.equal(updated.body, update.body);

      // Retrying exactly the request whose response was lost is safe and has no second event.
      const retry = await jsonRequest(
        app,
        "PATCH",
        `/api/campaigns/${draftId}`,
        update
      );
      assert.equal(retry.statusCode, 200);
      assert.deepEqual(
        responseJson<{ id: string; revision: number; body: string }>(retry),
        {
          ...responseJson<{ id: string; revision: number; body: string }>(
            updateResponse
          ),
        }
      );

      const staleDifferentUpdate = await jsonRequest(
        app,
        "PATCH",
        `/api/campaigns/${draftId}`,
        {
          ...update,
          body: "Конфликтующая правка",
        }
      );
      assert.equal(staleDifferentUpdate.statusCode, 409);
      assert.equal(
        responseJson<{ error: { code: string } }>(staleDifferentUpdate).error
          .code,
        "REVISION_CONFLICT"
      );

      const noOp = await jsonRequest(
        app,
        "PATCH",
        `/api/campaigns/${draftId}`,
        {
          ...update,
          revision: 2,
        }
      );
      assert.equal(noOp.statusCode, 200);
      const updateEvents = await pool.query<{ events: number }>(
        "SELECT count(*)::int AS events FROM events WHERE kind = 'draft_updated'"
      );
      assert.equal(updateEvents.rows[0].events, 1);
    });
  });
});
