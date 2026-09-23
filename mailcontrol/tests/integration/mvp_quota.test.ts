import { strict as assert } from "node:assert";
import { after, afterEach, describe, it } from "node:test";
import { setClock } from "../../server/clock.js";
import {
  cleanupTestDatabases,
  jsonRequest,
  responseJson,
  uuid,
  withTestApp,
} from "./helpers.js";
import {
  ScriptedSender,
  accountByEmail,
  createCampaign,
  createGroup,
  drain,
  getCampaign,
  importAccounts,
  listTasks,
  makeWorker,
  startCampaign,
} from "./mvp_helpers.js";

after(cleanupTestDatabases);
afterEach(() => setClock(null));

describe("A01 import", () => {
  it("handles new rows, duplicates, errors and repeated requests identically for lines and CSV", async () => {
    await withTestApp("local", async ({ app, pool }) => {
      const groupA = await createGroup(app, "Группа A", 15, 24);
      const groupB = await createGroup(app, "Группа B", 20, 24);
      const secret = "very-secret-app-password";
      const linesKey = uuid();
      const payload = {
        text: `one@mail.ru | ${secret}\ntwo@inbox.ru | ${secret}\nbad@gmail.com | ${secret}\nthree@bk.ru\nONE@mail.ru | other`,
        format: "lines" as const,
        groupId: groupA,
        limitCount: 15,
        periodHours: 24,
        duplicateAction: "keep" as const,
        requestKey: linesKey,
      };
      const first = responseJson<{
        added: number;
        errorCount: number;
        errors: Array<{ email: string | null; reason: string }>;
        repeated: boolean;
      }>(await jsonRequest(app, "POST", "/api/accounts/import", payload));
      assert.equal(first.added, 2);
      assert.equal(first.errorCount, 3);
      assert.ok(
        first.errors.every((row) => !JSON.stringify(row).includes(secret))
      );
      const again = responseJson<{ added: number; repeated: boolean }>(
        await jsonRequest(app, "POST", "/api/accounts/import", payload)
      );
      assert.equal(again.repeated, true);
      assert.equal(again.added, 2);
      const count = await pool.query(
        "SELECT count(*)::int AS count FROM accounts"
      );
      assert.equal(count.rows[0].count, 2);

      const csv = responseJson<{
        added: number;
        duplicatesMoved: number;
        duplicatesKept: number;
        errorCount: number;
      }>(
        await jsonRequest(app, "POST", "/api/accounts/import", {
          text: `email,app_password\r\n"one@mail.ru","${secret}"\r\nfour@list.ru,${secret}\r\n`,
          format: "csv",
          groupId: groupB,
          limitCount: 20,
          periodHours: 24,
          duplicateAction: "move",
          requestKey: uuid(),
        })
      );
      assert.deepEqual(
        [csv.added, csv.duplicatesMoved, csv.duplicatesKept, csv.errorCount],
        [1, 1, 0, 0]
      );
      const moved = await accountByEmail(app, "one@mail.ru");
      assert.equal(moved.groupId, groupB);

      const raw = await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM accounts WHERE password_ciphertext LIKE $1 OR email LIKE $1",
        [`%${secret}%`]
      );
      assert.equal(
        raw.rows[0].count,
        0,
        "plaintext password must not be stored"
      );
      const listed = await jsonRequest(app, "GET", "/api/accounts?pageSize=50");
      assert.equal(listed.body.includes(secret), false);
      assert.equal(listed.body.includes("password_ciphertext"), false);
    });
  });
});

describe("A02–A04 quotas", () => {
  it("keeps quotas independent per account and per batch", async () => {
    await withTestApp("local", async ({ app }) => {
      const group = await createGroup(app, "Квоты", 15, 24);
      const emails = Array.from(
        { length: 100 },
        (_, index) => `acc${index}@mail.ru`
      );
      await importAccounts(app, group, emails, 15, 24);
      await importAccounts(
        app,
        group,
        ["fresh1@mail.ru", "fresh2@mail.ru"],
        20,
        24
      );
      const old = await accountByEmail(app, "acc7@mail.ru");
      const fresh = await accountByEmail(app, "fresh1@mail.ru");
      assert.equal(old.quotaRemaining, 15);
      assert.equal(fresh.quotaRemaining, 20);
      const distinct = await jsonRequest(
        app,
        "GET",
        "/api/accounts?pageSize=100"
      );
      const items = responseJson<{
        items: Array<{ limitCount: number }>;
        total: number;
      }>(distinct);
      assert.equal(items.total, 102);
      assert.equal(
        items.items.filter((item) => item.limitCount === 15).length,
        100
      );
    });
  });

  it("recomputes remaining quota from history when the limit or period changes (A03) and frees slots only at the window edge (A04)", async () => {
    await withTestApp("local", async (opened) => {
      const { app } = opened;
      const group = await createGroup(app, "История", 15, 24);
      await importAccounts(app, group, ["hist@mail.ru"], 15, 24);
      const account = await accountByEmail(app, "hist@mail.ru");
      const base = new Date("2026-01-10T12:00:00Z");
      setClock(() => base);
      const sender = new ScriptedSender();
      const worker = makeWorker(opened, sender);
      const recipients = Array.from(
        { length: 10 },
        (_, index) => `r${index}@example.com`
      );
      const campaign = await createCampaign(app, group, recipients);
      await startCampaign(app, campaign);
      await drain(worker, 30);
      assert.equal((await getCampaign(app, campaign)).counts.accepted, 10);
      assert.equal((await accountByEmail(app, "hist@mail.ru")).quotaUsed, 10);

      const bulk = async (limitCount: number, periodHours: number) =>
        jsonRequest(app, "POST", "/api/accounts/bulk", {
          action: "set_limit",
          ids: [account.id],
          limitCount,
          periodHours,
          requestKey: uuid(),
        });
      await bulk(20, 24);
      assert.equal(
        (await accountByEmail(app, "hist@mail.ru")).quotaRemaining,
        10
      );
      await bulk(5, 24);
      const exhausted = await accountByEmail(app, "hist@mail.ru");
      assert.equal(exhausted.quotaRemaining, 0);
      assert.equal(exhausted.status, "quota_exhausted");
      assert.ok(exhausted.nextFreeAt);
      // Sends happened at `base`; the 6th oldest frees the first slot: 5/24 → exactly base + 24h.
      assert.equal(
        new Date(exhausted.nextFreeAt!).getTime(),
        base.getTime() + 24 * 3600 * 1000
      );

      // Midnight does not reset anything.
      setClock(() => new Date("2026-01-11T00:00:01Z"));
      assert.equal(
        (await accountByEmail(app, "hist@mail.ru")).quotaRemaining,
        0
      );
      // One second before the edge still nothing; at the edge everything from that instant frees up.
      setClock(() => new Date(base.getTime() + 24 * 3600 * 1000 - 1000));
      assert.equal(
        (await accountByEmail(app, "hist@mail.ru")).quotaRemaining,
        0
      );
      setClock(() => new Date(base.getTime() + 24 * 3600 * 1000 + 1000));
      assert.equal(
        (await accountByEmail(app, "hist@mail.ru")).quotaRemaining,
        5
      );
      // Period change keeps history: 5 per 48h counts the same 10 sends → still 0.
      await bulk(5, 48);
      assert.equal(
        (await accountByEmail(app, "hist@mail.ru")).quotaRemaining,
        0
      );
      await bulk(12, 48);
      assert.equal(
        (await accountByEmail(app, "hist@mail.ru")).quotaRemaining,
        2
      );

      // Moving between groups keeps the same account id and usage.
      const other = await createGroup(app, "Другая", 5, 24);
      await jsonRequest(app, "POST", "/api/accounts/bulk", {
        action: "move",
        ids: [account.id],
        groupId: other,
        requestKey: uuid(),
      });
      const movedAccount = await accountByEmail(app, "hist@mail.ru");
      assert.equal(movedAccount.id, account.id);
      assert.equal(movedAccount.groupId, other);
      assert.equal(movedAccount.quotaUsed, 10);
    });
  });

  it("waits for quota without losing the queue and resumes automatically (A09)", async () => {
    await withTestApp("local", async (opened) => {
      const { app } = opened;
      const group = await createGroup(app, "Ожидание", 2, 1);
      await importAccounts(app, group, ["w1@mail.ru"], 2, 1);
      const base = new Date("2026-02-01T10:00:00Z");
      setClock(() => base);
      const worker = makeWorker(opened, new ScriptedSender());
      const campaign = await createCampaign(app, group, [
        "a@example.com",
        "b@example.com",
        "c@example.com",
      ]);
      await startCampaign(app, campaign);
      await drain(worker, 10);
      let state = await getCampaign(app, campaign);
      assert.equal(state.counts.accepted, 2);
      assert.equal(state.counts.pending, 1);
      assert.equal(state.status, "running");
      assert.match(state.waitReason ?? "", /Лимиты исчерпаны/);
      assert.ok(state.waitUntil);
      setClock(() => new Date(base.getTime() + 3600 * 1000 + 1000));
      await drain(worker, 10);
      state = await getCampaign(app, campaign);
      assert.equal(state.counts.accepted, 3);
      assert.equal(state.status, "completed");
      const tasks = await listTasks(app, campaign);
      assert.equal(tasks.length, 3);
    });
  });
});
