import { strict as assert } from "node:assert";
import { after, afterEach, describe, it } from "node:test";
import { setClock } from "../../server/clock.js";
import {
  beginAttempt,
  finishAttempt,
  reserveNext,
} from "../../server/queue.js";
import {
  cleanupTestDatabases,
  jsonRequest,
  openExistingTestApp,
  responseJson,
  uuid,
  withTestApp,
  closeTestApp,
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

const post = (
  app: Parameters<typeof jsonRequest>[0],
  url: string,
  body: unknown = { requestKey: uuid() }
) => jsonRequest(app, "POST", url, body);

describe("A10 control", () => {
  it("pauses, resumes and stops by the rules, and a reserved-but-not-started task obeys pause/stop/disable/move", async () => {
    await withTestApp("local", async (opened) => {
      const { app, pool } = opened;
      const group = await createGroup(app, "Управление", 50, 24);
      const other = await createGroup(app, "Другая группа", 50, 24);
      await importAccounts(app, group, ["c1@mail.ru"], 50, 24);
      const account = await accountByEmail(app, "c1@mail.ru");
      const campaign = await createCampaign(app, group, [
        "p1@example.com",
        "p2@example.com",
        "p3@example.com",
        "p4@example.com",
      ]);
      assert.equal(
        (await post(app, `/api/campaigns/${campaign}/pause`)).statusCode,
        409,
        "pause needs a running campaign"
      );
      await startCampaign(app, campaign);
      const workerId = uuid();

      // Pause races a reservation: the reserved task returns to the queue, nothing starts.
      let reservation = await reserveNext(pool, campaign, workerId);
      assert.ok(reservation);
      assert.equal(
        (await post(app, `/api/campaigns/${campaign}/pause`)).statusCode,
        200
      );
      let begun = await beginAttempt(pool, reservation!, workerId);
      assert.equal(begun.kind, "released");
      assert.equal((await getCampaign(app, campaign)).counts.pending, 4);
      assert.equal(
        (await post(app, `/api/campaigns/${campaign}/pause`)).statusCode,
        200,
        "repeated pause is idempotent"
      );
      assert.equal(
        (await post(app, `/api/campaigns/${campaign}/resume`)).statusCode,
        200
      );

      // Disable races a reservation: no usable account → waiting, task stays pending.
      reservation = await reserveNext(pool, campaign, workerId);
      await post(app, "/api/accounts/bulk", {
        action: "disable",
        ids: [account.id],
        requestKey: uuid(),
      });
      begun = await beginAttempt(pool, reservation!, workerId);
      assert.equal(begun.kind, "waiting");
      assert.match(
        (begun as { reason: string }).reason,
        /требуют действия оператора/
      );
      await post(app, "/api/accounts/bulk", {
        action: "enable",
        ids: [account.id],
        requestKey: uuid(),
      });

      // Move races a reservation: the account no longer belongs to the campaign group.
      setClock(() => new Date(Date.now() + 60000));
      reservation = await reserveNext(pool, campaign, workerId);
      await post(app, "/api/accounts/bulk", {
        action: "move",
        ids: [account.id],
        groupId: other,
        requestKey: uuid(),
      });
      begun = await beginAttempt(pool, reservation!, workerId);
      assert.equal(begun.kind, "waiting");
      assert.match((begun as { reason: string }).reason, /нет аккаунтов/);
      await post(app, "/api/accounts/bulk", {
        action: "move",
        ids: [account.id],
        groupId: group,
        requestKey: uuid(),
      });

      // A started send finishes even though the campaign is stopped meanwhile; pending tasks are cancelled.
      setClock(() => new Date(Date.now() + 120000));
      reservation = await reserveNext(pool, campaign, workerId);
      begun = await beginAttempt(pool, reservation!, workerId);
      assert.equal(begun.kind, "started");
      assert.equal(
        (await post(app, `/api/campaigns/${campaign}/stop`)).statusCode,
        200
      );
      let state = await getCampaign(app, campaign);
      assert.equal(state.status, "stopped");
      assert.equal(state.counts.cancelled, 3);
      assert.equal(state.counts.sending, 1);
      assert.equal(
        (await post(app, `/api/campaigns/${campaign}/resume`)).statusCode,
        409,
        "resume works only after pause"
      );
      if (begun.kind === "started")
        await finishAttempt(pool, {
          attempt: begun.attempt,
          outcome: { kind: "accepted", response: "250" },
        });
      state = await getCampaign(app, campaign);
      assert.equal(state.counts.accepted, 1);
      assert.equal(state.status, "stopped");
      assert.equal(
        state.counts.accepted + state.counts.cancelled,
        state.counts.total
      );
    });
  });

  it("uses the current group membership for every new send", async () => {
    await withTestApp("local", async (opened) => {
      const { app } = opened;
      const group = await createGroup(app, "Состав", 50, 24);
      await importAccounts(app, group, ["m1@mail.ru"], 50, 24);
      const sender = new ScriptedSender();
      const worker = makeWorker(opened, sender);
      const campaign = await createCampaign(app, group, [
        "a@example.com",
        "b@example.com",
      ]);
      await startCampaign(app, campaign);
      await worker.pass();
      await worker.drain();
      await importAccounts(app, group, ["m2@mail.ru"], 50, 24);
      const first = await accountByEmail(app, "m1@mail.ru");
      await post(app, "/api/accounts/bulk", {
        action: "disable",
        ids: [first.id],
        requestKey: uuid(),
      });
      await drain(worker);
      const tasks = await listTasks(app, campaign);
      assert.deepEqual(tasks.map((task) => task.accountEmail).sort(), [
        "m1@mail.ru",
        "m2@mail.ru",
      ]);
      assert.equal((await getCampaign(app, campaign)).status, "completed");
    });
  });
});

describe("A11 restart and A12 unclear outcomes", () => {
  it("recovers reservations, turns interrupted sends into unclear tasks and keeps pauses after restart", async () => {
    await withTestApp("local", async (opened) => {
      const { app, pool } = opened;
      const group = await createGroup(app, "Перезапуск", 50, 24);
      await importAccounts(app, group, ["k1@mail.ru", "k2@mail.ru"], 50, 24);
      const campaign = await createCampaign(app, group, [
        "s1@example.com",
        "s2@example.com",
        "s3@example.com",
      ]);
      await startCampaign(app, campaign);
      const crashed = makeWorker(opened, new ScriptedSender());
      await crashed.register();
      const r1 = await reserveNext(pool, campaign, crashed.id);
      const begun = await beginAttempt(pool, r1!, crashed.id);
      assert.equal(begun.kind, "started");
      const r2 = await reserveNext(pool, campaign, crashed.id);
      assert.ok(r2);
      // The process dies here: no heartbeat, no outcome. Time passes beyond the stale threshold.
      setClock(() => new Date(Date.now() + 10 * 60000));
      const other = makeWorker(opened, new ScriptedSender());
      await other.register();
      const recovered = await other.recover();
      assert.deepEqual(recovered, { released: 1, unclear: 1 });
      let tasks = Object.fromEntries(
        (await listTasks(app, campaign)).map((task) => [
          task.email,
          task.status,
        ])
      );
      assert.equal(tasks["s1@example.com"], "unclear");
      assert.equal(tasks["s2@example.com"], "pending");
      // The old process wakes up late: its answer is recorded but changes nothing that is already decided.
      const key = uuid();
      const resolve = await post(
        app,
        `/api/campaigns/${campaign}/tasks/${begun.kind === "started" ? begun.attempt.taskId : ""}/resolve`,
        { decision: "failed", requestKey: key }
      );
      assert.equal(resolve.statusCode, 200, resolve.body);
      if (begun.kind === "started") {
        const late = await finishAttempt(pool, {
          attempt: begun.attempt,
          outcome: { kind: "accepted", response: "250 late" },
        });
        assert.equal(late, "late");
      }
      const attempt = await pool.query<{
        operator_decision: string;
        late_outcome: string;
        outcome: string;
      }>(
        "SELECT operator_decision, late_outcome, outcome FROM attempts ORDER BY id LIMIT 1"
      );
      assert.deepEqual(attempt.rows[0], {
        operator_decision: "failed",
        late_outcome: "accepted",
        outcome: "unknown",
      });
      assert.equal(
        (await accountByEmail(app, "k1@mail.ru")).quotaUsed,
        0,
        "confirmed failure releases the reserve exactly once"
      );

      await drain(other);
      await post(app, `/api/campaigns/${campaign}/pause`).catch(
        () => undefined
      );
      const before = await getCampaign(app, campaign);
      // Restart the API against the same database: state must be identical.
      await closeTestApp(opened);
      const reopened = await openExistingTestApp(opened.database, "local");
      try {
        const after = await getCampaign(reopened.app, campaign);
        assert.deepEqual(after.counts, before.counts);
        assert.equal(after.status, before.status);
        tasks = Object.fromEntries(
          (await listTasks(reopened.app, campaign)).map((task) => [
            task.email,
            task.status,
          ])
        );
        assert.equal(tasks["s1@example.com"], "failed");
        assert.equal(tasks["s2@example.com"], "accepted");
        assert.equal(tasks["s3@example.com"], "accepted");
      } finally {
        await closeTestApp(reopened);
      }
    });
  });

  it("keeps the reserve for an unknown outcome, never retries it, and applies each operator decision exactly once", async () => {
    await withTestApp("local", async (opened) => {
      const { app, pool } = opened;
      const group = await createGroup(app, "Неясно", 3, 24);
      await importAccounts(app, group, ["u1@mail.ru"], 3, 24);
      const base = new Date("2026-04-01T08:00:00Z");
      setClock(() => base);
      const sender = new ScriptedSender();
      for (const to of [
        "lost1@example.com",
        "lost2@example.com",
        "lost3@example.com",
      ])
        sender.outcomes.set(to, {
          kind: "unknown",
          message: "connection dropped after DATA",
        });
      const worker = makeWorker(opened, sender, 1);
      const campaign = await createCampaign(app, group, [
        "lost1@example.com",
        "lost2@example.com",
        "lost3@example.com",
        "ok@example.com",
      ]);
      await startCampaign(app, campaign);
      await drain(worker);
      let state = await getCampaign(app, campaign);
      assert.equal(state.counts.unclear, 3);
      assert.equal(
        state.counts.pending,
        1,
        "no automatic retry and the quota is fully reserved"
      );
      assert.equal((await accountByEmail(app, "u1@mail.ru")).quotaUsed, 3);
      assert.equal(sender.calls.length, 3);

      const tasks = await listTasks(app, campaign, "unclear");
      const [t1, t2, t3] = tasks;
      const key = uuid();
      const first = await post(
        app,
        `/api/campaigns/${campaign}/tasks/${t1.id}/resolve`,
        { decision: "accepted", requestKey: key }
      );
      const repeat = await post(
        app,
        `/api/campaigns/${campaign}/tasks/${t1.id}/resolve`,
        { decision: "accepted", requestKey: key }
      );
      assert.equal(first.statusCode, 200);
      assert.equal(repeat.statusCode, 200);
      const changed = await post(
        app,
        `/api/campaigns/${campaign}/tasks/${t1.id}/resolve`,
        { decision: "failed", requestKey: uuid() }
      );
      assert.equal(
        changed.statusCode,
        409,
        "a decided task cannot be decided again"
      );
      await post(app, `/api/campaigns/${campaign}/tasks/${t2.id}/resolve`, {
        decision: "failed",
        requestKey: uuid(),
      });
      setClock(() => new Date(base.getTime() + 5 * 3600 * 1000));
      await post(app, `/api/campaigns/${campaign}/tasks/${t3.id}/resolve`, {
        decision: "closed",
        requestKey: uuid(),
      });

      const usage = await pool.query<{ state: string; occupied_at: string }>(
        "SELECT state, occupied_at FROM quota_usage ORDER BY id"
      );
      assert.deepEqual(
        usage.rows.map((row) => row.state),
        ["accepted", "released", "possible"]
      );
      assert.equal(
        new Date(usage.rows[2].occupied_at).getTime(),
        base.getTime() + 5 * 3600 * 1000,
        "closing without proof occupies quota from the closing time"
      );
      const account = await accountByEmail(app, "u1@mail.ru");
      assert.equal(account.quotaUsed, 2);

      await drain(worker);
      state = await getCampaign(app, campaign);
      assert.equal(state.status, "completed_with_errors");
      assert.deepEqual(
        [
          state.counts.accepted,
          state.counts.failed,
          state.counts.closedUnconfirmed,
          state.counts.unclear,
        ],
        [2, 1, 1, 0]
      );
      assert.equal(sender.calls.length, 4);
      const csv = await jsonRequest(
        app,
        "GET",
        `/api/campaigns/${campaign}/report.csv`
      );
      assert.equal(csv.statusCode, 200);
      const lines = csv.body.trim().split("\r\n");
      assert.equal(lines.length, 5, "header + one line per recipient");
      assert.equal(
        lines.filter((line) => line.includes("принято сервисом")).length,
        2
      );
      assert.equal(
        lines.filter((line) => line.includes("закрыто без подтверждения"))
          .length,
        1
      );
      assert.equal(csv.body.includes("app-password"), false);
    });
  });
});
