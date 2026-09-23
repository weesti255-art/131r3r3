import { strict as assert } from "node:assert";
import { after, describe, it } from "node:test";
import path from "node:path";
import { initializeDatabase } from "../../server/database.js";
import {
  cleanupTestDatabases,
  closeTestApp,
  createTestDatabase,
  jsonRequest,
  openExistingTestApp,
  responseJson,
  uuid,
  withTestApp,
} from "./helpers.js";

after(cleanupTestDatabases);

describe("M1 persistence and database modes", () => {
  it("seeds demo data explicitly and exactly once", async () => {
    await withTestApp("demo", async ({ app, pool }) => {
      const initial = await pool.query<{
        groups: number;
        accounts: number;
        drafts: number;
        seeded: number;
      }>(`
        SELECT
          (SELECT count(*)::int FROM account_groups) AS groups,
          (SELECT count(*)::int FROM accounts) AS accounts,
          (SELECT count(*)::int FROM campaigns) AS drafts,
          (SELECT count(*)::int FROM events WHERE kind = 'demo_seeded') AS seeded
      `);
      assert.deepEqual(initial.rows[0], {
        groups: 3,
        accounts: 12,
        drafts: 3,
        seeded: 1,
      });

      await initializeDatabase(pool, path.resolve("db"), "demo");
      const afterRepeat = await pool.query<{
        groups: number;
        accounts: number;
        drafts: number;
        seeded: number;
      }>(`
        SELECT
          (SELECT count(*)::int FROM account_groups) AS groups,
          (SELECT count(*)::int FROM accounts) AS accounts,
          (SELECT count(*)::int FROM campaigns) AS drafts,
          (SELECT count(*)::int FROM events WHERE kind = 'demo_seeded') AS seeded
      `);
      assert.deepEqual(afterRepeat.rows[0], initial.rows[0]);

      const health = await jsonRequest(app, "GET", "/api/health");
      assert.equal(health.statusCode, 200);
      assert.equal(responseJson<{ mode: string }>(health).mode, "demo");
      const overview = await jsonRequest(app, "GET", "/api/overview");
      assert.equal(overview.statusCode, 200);
      const overviewValue = responseJson<{
        mode: string;
        sendingEnabled: boolean;
        accountCount: number;
        groupCount: number;
        campaignCount: number;
        problemAccountCount: number;
        acceptedSince: number;
        queuedTasks: number;
        recentCampaigns: unknown[];
        recentEvents: unknown[];
      }>(overview);
      assert.equal(overviewValue.mode, "demo");
      assert.equal(overviewValue.sendingEnabled, false);
      assert.equal(overviewValue.accountCount, 12);
      assert.equal(overviewValue.groupCount, 3);
      assert.equal(overviewValue.campaignCount, 3);
      assert.equal(overviewValue.problemAccountCount, 2);
      assert.equal(overviewValue.acceptedSince, 0);
      assert.equal(overviewValue.queuedTasks, 0);
      assert.equal(overviewValue.recentCampaigns.length, 3);
      assert.equal(overviewValue.recentEvents.length, 4);
    });
  });

  it("keeps a local database empty when demo seeding is not selected", async () => {
    await withTestApp("local", async ({ app, pool }) => {
      const overviewResponse = await jsonRequest(app, "GET", "/api/overview");
      assert.equal(overviewResponse.statusCode, 200);
      const overview = responseJson<{
        mode: string;
        accountCount: number;
        groupCount: number;
        campaignCount: number;
        problemAccountCount: number;
        recentCampaigns: unknown[];
        recentEvents: unknown[];
      }>(overviewResponse);
      assert.equal(overview.mode, "local");
      assert.equal(overview.accountCount, 0);
      assert.equal(overview.groupCount, 0);
      assert.equal(overview.campaignCount, 0);
      assert.equal(overview.problemAccountCount, 0);
      assert.deepEqual(overview.recentCampaigns, []);
      assert.deepEqual(overview.recentEvents, []);

      const [groups, accounts, campaigns, events] = await Promise.all([
        jsonRequest(app, "GET", "/api/groups"),
        jsonRequest(app, "GET", "/api/accounts"),
        jsonRequest(app, "GET", "/api/campaigns"),
        jsonRequest(app, "GET", "/api/events"),
      ]);
      for (const response of [groups, accounts, campaigns, events])
        assert.equal(response.statusCode, 200);
      assert.equal(responseJson<{ total: number }>(groups).total, 0);
      assert.equal(responseJson<{ total: number }>(accounts).total, 0);
      assert.equal(responseJson<{ total: number }>(campaigns).total, 0);
      assert.equal(responseJson<{ total: number }>(events).total, 0);
    });
  });

  it("rejects mode mismatch without mixing demo rows into local data", async () => {
    const database = await createTestDatabase();
    const local = await openExistingTestApp(database, "local");
    await closeTestApp(local);

    const mismatch = await openExistingTestApp(database, "local");
    try {
      await assert.rejects(
        () => initializeDatabase(mismatch.pool, path.resolve("db"), "demo"),
        /Database mode mismatch/
      );
      const counts = await mismatch.pool.query<{
        accounts: number;
        drafts: number;
        seeded: number;
      }>(`
        SELECT
          (SELECT count(*)::int FROM accounts) AS accounts,
          (SELECT count(*)::int FROM campaigns) AS drafts,
          (SELECT count(*)::int FROM events WHERE kind = 'demo_seeded') AS seeded
      `);
      assert.deepEqual(counts.rows[0], { accounts: 0, drafts: 0, seeded: 0 });
    } finally {
      await closeTestApp(mismatch);
    }
  });

  it("persists a group and multiline Russian draft across an API restart", async () => {
    const database = await createTestDatabase();
    const first = await openExistingTestApp(database, "local");
    const groupRequestKey = uuid();
    const draftRequestKey = uuid();
    let groupId: string;
    let draftId: string;
    try {
      const groupResponse = await jsonRequest(
        first.app,
        "POST",
        "/api/groups",
        {
          name: "Русская группа",
          color: "teal",
          limitCount: 15,
          periodHours: 24,
          requestKey: groupRequestKey,
        }
      );
      assert.equal(groupResponse.statusCode, 201);
      const group = responseJson<{
        id: string;
        limitCount: number;
        periodHours: number;
      }>(groupResponse);
      groupId = group.id;
      assert.equal(group.limitCount, 15);
      assert.equal(group.periodHours, 24);

      const body = "Первая строка\n\nВторая строка\nТретья строка";
      const draftResponse = await jsonRequest(
        first.app,
        "POST",
        "/api/campaigns",
        {
          name: "Русский черновик",
          groupId,
          subject: "Тема письма",
          body,
          senderName: "",
          requestKey: draftRequestKey,
        }
      );
      assert.equal(draftResponse.statusCode, 201);
      const draft = responseJson<{ id: string; revision: number }>(
        draftResponse
      );
      draftId = draft.id;
      assert.equal(draft.revision, 1);
    } finally {
      await closeTestApp(first);
    }

    const second = await openExistingTestApp(database, "local");
    try {
      const groups = await jsonRequest(
        second.app,
        "GET",
        "/api/groups?q=%D0%A0%D1%83%D1%81%D1%81%D0%BA%D0%B0%D1%8F"
      );
      assert.equal(groups.statusCode, 200);
      const groupPage = responseJson<{
        total: number;
        items: Array<{
          id: string;
          name: string;
          limitCount: number;
          periodHours: number;
        }>;
      }>(groups);
      assert.equal(groupPage.total, 1);
      assert.equal(groupPage.items[0].id, groupId!);
      assert.equal(groupPage.items[0].name, "Русская группа");
      assert.equal(groupPage.items[0].limitCount, 15);
      assert.equal(groupPage.items[0].periodHours, 24);

      const draftResponse = await jsonRequest(
        second.app,
        "GET",
        `/api/campaigns/${draftId!}`
      );
      assert.equal(draftResponse.statusCode, 200);
      const draft = responseJson<{
        body: string;
        senderName: string;
        revision: number;
      }>(draftResponse);
      assert.equal(draft.body, "Первая строка\n\nВторая строка\nТретья строка");
      assert.equal(draft.senderName, "");
      assert.equal(draft.revision, 1);
    } finally {
      await closeTestApp(second);
    }
  });
});
