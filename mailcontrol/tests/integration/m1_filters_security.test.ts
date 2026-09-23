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

describe("M1 bounded listings and filters", () => {
  it("supports bounded pagination, escaped search, problem accounts, and event filters", async () => {
    await withTestApp("demo", async ({ app }) => {
      const firstGroups = await jsonRequest(
        app,
        "GET",
        "/api/groups?page=1&pageSize=2"
      );
      assert.equal(firstGroups.statusCode, 200);
      const firstGroupPage = responseJson<{
        total: number;
        page: number;
        pageSize: number;
        items: unknown[];
      }>(firstGroups);
      assert.equal(firstGroupPage.total, 3);
      assert.equal(firstGroupPage.page, 1);
      assert.equal(firstGroupPage.pageSize, 2);
      assert.equal(firstGroupPage.items.length, 2);

      const secondGroups = await jsonRequest(
        app,
        "GET",
        "/api/groups?page=2&pageSize=2"
      );
      assert.equal(secondGroups.statusCode, 200);
      assert.equal(
        responseJson<{ items: unknown[] }>(secondGroups).items.length,
        1
      );

      const searchedGroups = await jsonRequest(
        app,
        "GET",
        "/api/groups?q=%D0%9E%D1%81%D0%BD%D0%BE%D0%B2%D0%BD%D0%B0%D1%8F"
      );
      assert.equal(searchedGroups.statusCode, 200);
      assert.equal(responseJson<{ total: number }>(searchedGroups).total, 1);

      const escapedWildcard = await jsonRequest(
        app,
        "GET",
        "/api/groups?q=%25"
      );
      assert.equal(escapedWildcard.statusCode, 200);
      assert.equal(responseJson<{ total: number }>(escapedWildcard).total, 0);

      const problems = await jsonRequest(
        app,
        "GET",
        "/api/accounts?status=problem&pageSize=100"
      );
      assert.equal(problems.statusCode, 200);
      const problemPage = responseJson<{
        total: number;
        items: Array<{ status: string }>;
      }>(problems);
      assert.equal(problemPage.total, 2);
      assert.deepEqual(
        new Set(problemPage.items.map((item) => item.status)),
        new Set(["auth_error", "needs_check"])
      );

      const searchedAccount = await jsonRequest(
        app,
        "GET",
        "/api/accounts?q=demo.sender04"
      );
      assert.equal(searchedAccount.statusCode, 200);
      assert.equal(responseJson<{ total: number }>(searchedAccount).total, 1);

      const demoEvents = await jsonRequest(
        app,
        "GET",
        "/api/events?kind=demo_seeded&pageSize=100"
      );
      assert.equal(demoEvents.statusCode, 200);
      assert.equal(
        responseJson<{ total: number; items: Array<{ kind: string }> }>(
          demoEvents
        ).total,
        1
      );
      assert.equal(
        responseJson<{ items: Array<{ kind: string }> }>(demoEvents).items[0]
          .kind,
        "demo_seeded"
      );

      const draftEvents = await jsonRequest(
        app,
        "GET",
        "/api/events?kind=draft_created&pageSize=100"
      );
      assert.equal(draftEvents.statusCode, 200);
      assert.equal(responseJson<{ total: number }>(draftEvents).total, 3);

      const invalidPageSize = await jsonRequest(
        app,
        "GET",
        "/api/groups?pageSize=101"
      );
      assert.equal(invalidPageSize.statusCode, 400);
      assert.equal(
        responseJson<{ error: { code: string } }>(invalidPageSize).error.code,
        "VALIDATION_ERROR"
      );

      const unknownQuery = await jsonRequest(
        app,
        "GET",
        "/api/groups?notAFilter=true"
      );
      assert.equal(unknownQuery.statusCode, 400);
      assert.equal(
        responseJson<{ error: { code: string } }>(unknownQuery).error.code,
        "VALIDATION_ERROR"
      );
    });
  });
});

describe("M1 request boundary and failure handling", () => {
  it("rejects unsafe host/origin/fetch-site requests and does not enable CORS", async () => {
    await withTestApp("local", async ({ app }) => {
      const invalidHost = await jsonRequest(
        app,
        "GET",
        "/api/health",
        undefined,
        { host: "evil.example" }
      );
      assert.equal(invalidHost.statusCode, 403);
      assert.equal(
        responseJson<{ error: { code: string } }>(invalidHost).error.code,
        "HOST_NOT_ALLOWED"
      );

      const invalidOrigin = await jsonRequest(
        app,
        "POST",
        "/api/groups",
        {
          name: "Не должна сохраниться",
          color: "blue",
          limitCount: 1,
          periodHours: 1,
          requestKey: uuid(),
        },
        { origin: "https://evil.example" }
      );
      assert.equal(invalidOrigin.statusCode, 403);
      assert.equal(
        responseJson<{ error: { code: string } }>(invalidOrigin).error.code,
        "ORIGIN_NOT_ALLOWED"
      );
      assert.equal(
        invalidOrigin.headers["access-control-allow-origin"],
        undefined
      );

      const crossSite = await jsonRequest(
        app,
        "POST",
        "/api/groups",
        {
          name: "Не должна сохраниться 2",
          color: "blue",
          limitCount: 1,
          periodHours: 1,
          requestKey: uuid(),
        },
        { "sec-fetch-site": "cross-site" }
      );
      assert.equal(crossSite.statusCode, 403);
      assert.equal(
        responseJson<{ error: { code: string } }>(crossSite).error.code,
        "ORIGIN_NOT_ALLOWED"
      );
      assert.equal(crossSite.headers["access-control-allow-origin"], undefined);

      const textPayload = await jsonRequest(
        app,
        "POST",
        "/api/groups",
        JSON.stringify({
          name: "Не JSON",
          color: "blue",
          limitCount: 1,
          periodHours: 1,
          requestKey: uuid(),
        }),
        { "content-type": "text/plain" }
      );
      assert.equal(textPayload.statusCode, 415);
      assert.equal(
        responseJson<{ error: { code: string } }>(textPayload).error.code,
        "JSON_REQUIRED"
      );
    });
  });

  it("enforces JSON/body limits and keeps validation errors free of secrets and stacks", async () => {
    await withTestApp("local", async ({ app }) => {
      const secret = "super-secret-app-password";
      const unknownField = await jsonRequest(app, "POST", "/api/groups", {
        name: "Неверное поле",
        color: "blue",
        limitCount: 1,
        periodHours: 1,
        requestKey: uuid(),
        password: secret,
      });
      assert.equal(unknownField.statusCode, 400);
      assert.equal(unknownField.body.includes(secret), false);
      assert.equal(unknownField.body.includes(" at "), false);

      const huge = await jsonRequest(app, "POST", "/api/groups", {
        name: "Слишком большой запрос",
        color: "blue",
        limitCount: 1,
        periodHours: 1,
        requestKey: uuid(),
        extra: "x".repeat(310_000),
      });
      assert.equal(huge.statusCode, 413);
      assert.equal(huge.body.includes(secret), false);
      assert.equal(huge.body.includes(" at "), false);

      const invalidId = await jsonRequest(
        app,
        "GET",
        "/api/campaigns/not-a-uuid"
      );
      assert.equal(invalidId.statusCode, 400);
      assert.equal(invalidId.body.includes("Error"), false);
      assert.equal(invalidId.body.includes("stack"), false);
    });
  });

  it("does not expose unimplemented import/send routes or accept password payloads", async () => {
    await withTestApp("local", async ({ app }) => {
      const secret = "password-that-must-not-appear";
      const importResponse = await jsonRequest(
        app,
        "POST",
        "/api/accounts/import",
        {
          email: "owner@mail.ru",
          password: secret,
        }
      );
      assert.equal(importResponse.statusCode, 404);
      assert.equal(importResponse.body.includes(secret), false);

      const sendResponse = await jsonRequest(app, "POST", "/api/send", {
        password: secret,
      });
      assert.equal(sendResponse.statusCode, 404);
      assert.equal(sendResponse.body.includes(secret), false);
    });
  });

  it("returns a sanitized 503 when the API database pool is unavailable", async () => {
    await withTestApp("local", async ({ app, pool }) => {
      await pool.end();
      const response = await jsonRequest(app, "GET", "/api/health");
      assert.equal(response.statusCode, 503);
      assert.equal(
        responseJson<{ error: { code: string; message: string } }>(response)
          .error.code,
        "SERVICE_UNAVAILABLE"
      );
      assert.equal(response.body.includes("password"), false);
      assert.equal(response.body.includes(" at "), false);
    });
  });
});
