import { strict as assert } from "node:assert";
import { after, afterEach, describe, it } from "node:test";
import { setClock } from "../../server/clock.js";
import { recoverStale } from "../../server/queue.js";
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
  sleep,
  startCampaign,
} from "./mvp_helpers.js";

after(cleanupTestDatabases);
afterEach(() => setClock(null));

describe("A05 concurrency and fairness", () => {
  it("lets two workers and two campaigns start at most one send for the last slot", async () => {
    await withTestApp("local", async (opened) => {
      const { app } = opened;
      const group = await createGroup(app, "Гонка", 1, 24);
      await importAccounts(app, group, ["race@mail.ru"], 1, 24);
      const sender = new ScriptedSender();
      sender.holdAll = true;
      const workerA = makeWorker(opened, sender, 4);
      const workerB = makeWorker(opened, sender, 4);
      await workerA.register();
      await workerB.register();
      const first = await createCampaign(
        app,
        group,
        ["x1@example.com", "x2@example.com"],
        "Первая"
      );
      const second = await createCampaign(
        app,
        group,
        ["y1@example.com"],
        "Вторая"
      );
      await startCampaign(app, first);
      await startCampaign(app, second);
      await Promise.all([
        workerA.pass(),
        workerB.pass(),
        workerA.pass(),
        workerB.pass(),
      ]);
      await sleep(50);
      assert.equal(
        sender.holding,
        1,
        "exactly one send may be in flight for one slot"
      );
      const active = await opened.pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM attempts WHERE finished_at IS NULL"
      );
      assert.equal(active.rows[0].count, 1);
      sender.release();
      await workerA.drain();
      await workerB.drain();
      const usage = await opened.pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM quota_usage"
      );
      assert.equal(usage.rows[0].count, 1);
      const [a, b] = await Promise.all([
        getCampaign(app, first),
        getCampaign(app, second),
      ]);
      assert.equal(a.counts.accepted + b.counts.accepted, 1);
      assert.equal(a.counts.pending + b.counts.pending, 2);
      await workerA.shutdown();
      await workerB.shutdown();
    });
  });

  it("gives each ready campaign one task per pass and never overlaps attempts on one account", async () => {
    await withTestApp("local", async (opened) => {
      const { app } = opened;
      const group = await createGroup(app, "Три", 100, 24);
      await importAccounts(
        app,
        group,
        ["f1@mail.ru", "f2@mail.ru", "f3@mail.ru"],
        100,
        24
      );
      const sender = new ScriptedSender();
      sender.holdAll = true;
      const worker = makeWorker(opened, sender, 8);
      const ids = [];
      for (const name of ["big", "medium", "small"]) {
        const id = await createCampaign(
          app,
          group,
          Array.from({ length: 6 }, (_, i) => `${name}${i}@example.com`),
          name
        );
        await startCampaign(app, id);
        ids.push(id);
      }
      const started = await worker.pass();
      await sleep(50);
      assert.equal(started, 3);
      const sending = await opened.pool.query<{
        campaign_id: string;
        account_id: string;
      }>("SELECT campaign_id, account_id FROM tasks WHERE status = 'sending'");
      assert.equal(
        new Set(sending.rows.map((row) => row.campaign_id)).size,
        3,
        "one task per campaign"
      );
      assert.equal(
        new Set(sending.rows.map((row) => row.account_id)).size,
        3,
        "distinct accounts"
      );
      const overlap = await worker.pass();
      assert.equal(overlap, 0, "all accounts busy: nothing more may start");
      sender.holdAll = false;
      sender.release();
      await worker.drain();
      await drain(worker, 40);
      for (const id of ids)
        assert.equal((await getCampaign(app, id)).status, "completed");
      const perAccount = await opened.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM attempts a JOIN attempts b ON a.account_id = b.account_id AND a.id < b.id
         WHERE a.started_at < b.finished_at AND b.started_at < a.finished_at`
      );
      assert.equal(
        perAccount.rows[0].n,
        0,
        "no overlapping attempts per account"
      );
    });
  });

  it("does not let an old owner start a task it no longer holds", async () => {
    await withTestApp("local", async (opened) => {
      const { app } = opened;
      const { reserveNext, beginAttempt } = await import(
        "../../server/queue.js"
      );
      const group = await createGroup(app, "Владелец", 10, 24);
      await importAccounts(app, group, ["own@mail.ru"], 10, 24);
      const campaign = await createCampaign(app, group, ["z@example.com"]);
      await startCampaign(app, campaign);
      const stale = await reserveNext(opened.pool, campaign, uuid());
      assert.ok(stale);
      // Reservation expired: recovery hands the task back to the queue.
      setClock(() => new Date(Date.now() + 10 * 60000));
      await recoverStale(opened.pool, []);
      const fresh = await reserveNext(opened.pool, campaign, uuid());
      assert.ok(fresh);
      const late = await beginAttempt(opened.pool, stale!, stale!.ownerToken);
      assert.equal(late.kind, "released");
      const ok = await beginAttempt(opened.pool, fresh!, fresh!.ownerToken);
      assert.equal(ok.kind, "started");
      const attempts = await opened.pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM attempts"
      );
      assert.equal(attempts.rows[0].count, 1);
    });
  });
});

describe("A06 duplicates", () => {
  it("does not create a second letter on double start, repeated request or repeated address", async () => {
    await withTestApp("local", async (opened) => {
      const { app } = opened;
      const group = await createGroup(app, "Дубли", 10, 24);
      await importAccounts(app, group, ["d@mail.ru"], 10, 24);
      const campaign = await createCampaign(app, group, [
        "same@example.com",
        "SAME@example.com",
        " same@example.com ",
      ]);
      assert.equal((await getCampaign(app, campaign)).counts.total, 1);
      const key = uuid();
      const [first, second] = await Promise.all([
        jsonRequest(app, "POST", `/api/campaigns/${campaign}/start`, {
          requestKey: key,
        }),
        jsonRequest(app, "POST", `/api/campaigns/${campaign}/start`, {
          requestKey: key,
        }),
      ]);
      assert.equal(first.statusCode, 200);
      assert.equal(second.statusCode, 200);
      await jsonRequest(app, "POST", `/api/campaigns/${campaign}/start`, {
        requestKey: uuid(),
      });
      const worker = makeWorker(opened, new ScriptedSender());
      await drain(worker);
      const attempts = await opened.pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM attempts"
      );
      assert.equal(attempts.rows[0].count, 1);
      assert.equal((await getCampaign(app, campaign)).counts.accepted, 1);
    });
  });
});

describe("A07–A08 errors", () => {
  it("excludes a broken account with the right reason and hands the task to another account", async () => {
    await withTestApp("local", async (opened) => {
      const { app } = opened;
      const group = await createGroup(app, "Замена", 10, 24);
      await importAccounts(
        app,
        group,
        [
          "auth-error@mail.ru",
          "needs-check@mail.ru",
          "blocked@mail.ru",
          "good@mail.ru",
        ],
        10,
        24
      );
      const { createTestSender } = await import("../../server/sender/test.js");
      const worker = makeWorker(
        opened,
        createTestSender({ delayMs: () => 0 }),
        1
      );
      const campaign = await createCampaign(app, group, [
        "r1@example.com",
        "r2@example.com",
        "r3@example.com",
      ]);
      await startCampaign(app, campaign);
      await drain(worker, 40);
      const state = await getCampaign(app, campaign);
      assert.equal(state.status, "completed");
      assert.equal(state.counts.accepted, 3);
      assert.equal(
        (await accountByEmail(app, "auth-error@mail.ru")).status,
        "auth_error"
      );
      assert.equal(
        (await accountByEmail(app, "needs-check@mail.ru")).status,
        "needs_check"
      );
      assert.equal(
        (await accountByEmail(app, "blocked@mail.ru")).status,
        "blocked"
      );
      assert.equal(
        (await accountByEmail(app, "good@mail.ru")).status,
        "active"
      );
      const tasks = await listTasks(app, campaign);
      assert.ok(tasks.every((task) => task.accountEmail === "good@mail.ru"));
      const events = responseJson<{
        items: Array<{ kind: string; title: string }>;
      }>(
        await jsonRequest(
          app,
          "GET",
          "/api/events?kind=account_excluded&pageSize=10"
        )
      );
      assert.equal(events.items.length, 3);
    });
  });

  it("fails only the recipient on address errors and retries temporary errors within a finite budget", async () => {
    await withTestApp("local", async (opened) => {
      const { app } = opened;
      const group = await createGroup(app, "Ошибки", 50, 24);
      await importAccounts(app, group, ["e1@mail.ru"], 50, 24);
      await jsonRequest(app, "PATCH", "/api/settings", {
        retryMaxAttempts: 2,
        retryBaseMinutes: 30,
        retryMaxMinutes: 120,
      });
      const base = new Date("2026-03-01T09:00:00Z");
      setClock(() => base);
      const sender = new ScriptedSender();
      sender.outcomes.set("bad@example.com", {
        kind: "rejected",
        category: "recipient",
        code: "550",
        message: "no such user",
      });
      sender.outcomes.set("temp@example.com", {
        kind: "rejected",
        category: "temporary",
        code: "451",
        message: "try later",
        scope: "message",
      });
      const worker = makeWorker(opened, sender);
      const campaign = await createCampaign(app, group, [
        "bad@example.com",
        "temp@example.com",
        "ok@example.com",
      ]);
      await startCampaign(app, campaign);
      await drain(worker);
      let tasks = Object.fromEntries(
        (await listTasks(app, campaign)).map((task) => [task.email, task])
      );
      assert.equal(tasks["bad@example.com"].status, "failed");
      assert.equal(tasks["ok@example.com"].status, "accepted");
      assert.equal(tasks["temp@example.com"].status, "pending");
      assert.equal(
        new Date(tasks["temp@example.com"].nextAttemptAt!).getTime(),
        base.getTime() + 30 * 60000
      );
      assert.equal(
        (await accountByEmail(app, "e1@mail.ru")).status,
        "active",
        "recipient-stage temporary error does not cool the account"
      );
      setClock(() => new Date(base.getTime() + 31 * 60000));
      await drain(worker);
      tasks = Object.fromEntries(
        (await listTasks(app, campaign)).map((task) => [task.email, task])
      );
      assert.equal(tasks["temp@example.com"].attemptCount, 2);
      assert.equal(
        new Date(tasks["temp@example.com"].nextAttemptAt!).getTime(),
        base.getTime() + 31 * 60000 + 60 * 60000
      );
      setClock(() => new Date(base.getTime() + 200 * 60000));
      await drain(worker);
      tasks = Object.fromEntries(
        (await listTasks(app, campaign)).map((task) => [task.email, task])
      );
      assert.equal(tasks["temp@example.com"].status, "failed");
      assert.equal(tasks["temp@example.com"].attemptCount, 3);
      assert.match(
        tasks["temp@example.com"].lastError ?? "",
        /Исчерпан предел попыток/
      );
      const state = await getCampaign(app, campaign);
      assert.equal(state.status, "completed_with_errors");
      assert.equal(state.counts.total, 3);
      assert.equal(state.counts.accepted + state.counts.failed, 3);
      const attempts = await opened.pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM attempts"
      );
      assert.equal(attempts.rows[0].count, 5);
      const quota = await accountByEmail(app, "e1@mail.ru");
      assert.equal(
        quota.quotaUsed,
        1,
        "rejected attempts release their reserve"
      );
    });
  });

  it("pauses the campaign with a reason on content rejection instead of rotating accounts", async () => {
    await withTestApp("local", async (opened) => {
      const { app } = opened;
      const group = await createGroup(app, "Спам", 50, 24);
      await importAccounts(app, group, ["s1@mail.ru", "s2@mail.ru"], 50, 24);
      const sender = new ScriptedSender();
      sender.outcomes.set("spam@example.com", {
        kind: "rejected",
        category: "content_or_policy",
        code: "550",
        message: "spam message rejected",
      });
      const worker = makeWorker(opened, sender);
      const campaign = await createCampaign(app, group, [
        "spam@example.com",
        "next@example.com",
      ]);
      await startCampaign(app, campaign);
      await drain(worker);
      const state = await getCampaign(app, campaign);
      assert.equal(state.status, "paused");
      assert.match(state.pauseReason ?? "", /Отказ сервиса/);
      assert.equal(state.counts.pending, 2);
      assert.equal(sender.calls.length, 1);
    });
  });
});
