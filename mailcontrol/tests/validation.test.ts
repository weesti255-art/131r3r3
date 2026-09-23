import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { loadConfig } from "../server/config.js";
import {
  createDraftSchema,
  groupSchema,
  idSchema,
  listSchema,
  searchPattern,
  updateDraftSchema,
} from "../server/validation.js";

const uuid = ["00000000", "0000", "4000", "8000", "000000000001"].join("-");
const otherUuid = ["00000000", "0000", "4000", "8000", "000000000002"].join(
  "-"
);

function validGroup(overrides: Record<string, unknown> = {}) {
  return {
    name: "Тестовая группа",
    limitCount: 15,
    periodHours: 24,
    requestKey: uuid,
    ...overrides,
  };
}

function validDraft(overrides: Record<string, unknown> = {}) {
  return {
    name: "Тестовая рассылка",
    groupId: uuid,
    requestKey: otherUuid,
    ...overrides,
  };
}

describe("M1 validation", () => {
  it("escapes SQL LIKE wildcards and backslashes in search terms", () => {
    assert.equal(searchPattern("100%_\\mail"), "%100\\%\\_\\\\mail%");
    assert.equal(searchPattern(""), "%%");
  });

  it("applies safe defaults and permits an empty sender name", () => {
    assert.deepEqual(groupSchema.parse(validGroup()), {
      name: "Тестовая группа",
      color: "blue",
      limitCount: 15,
      periodHours: 24,
      requestKey: uuid,
    });
    assert.deepEqual(createDraftSchema.parse(validDraft()), {
      name: "Тестовая рассылка",
      groupId: uuid,
      subject: "",
      body: "",
      senderName: "",
      requestKey: otherUuid,
    });
  });

  it("rejects malformed integers, UUIDs, and unknown fields", () => {
    for (const value of [0, -1, 1.5, "1", "", Number.NaN]) {
      assert.throws(() => groupSchema.parse(validGroup({ limitCount: value })));
      assert.throws(() =>
        groupSchema.parse(validGroup({ periodHours: value }))
      );
    }
    assert.throws(() =>
      updateDraftSchema.parse({
        name: "Черновик",
        groupId: uuid,
        subject: "",
        body: "",
        senderName: "",
        revision: 0,
      })
    );
    assert.throws(() =>
      groupSchema.parse(validGroup({ requestKey: "not-a-uuid" }))
    );
    assert.throws(() =>
      createDraftSchema.parse(validDraft({ groupId: "not-a-uuid" }))
    );
    assert.throws(() => idSchema.parse("not-a-uuid"));
    assert.throws(() => groupSchema.parse(validGroup({ unexpected: true })));
    assert.throws(() =>
      createDraftSchema.parse(validDraft({ unexpected: true }))
    );
    assert.throws(() => listSchema.parse({ unknown: "field" }));
  });

  it("rejects newline injection in headers while retaining multiline body text", () => {
    assert.throws(() =>
      createDraftSchema.parse(validDraft({ subject: "Тема\nX-Injected: yes" }))
    );
    assert.throws(() =>
      createDraftSchema.parse(
        validDraft({ senderName: "Имя\r\nX-Injected: yes" })
      )
    );
    const parsed = createDraftSchema.parse(
      validDraft({ body: "Первая строка\n\nВторая строка" })
    );
    assert.equal(parsed.body, "Первая строка\n\nВторая строка");
  });

  it("enforces body and list bounds", () => {
    assert.equal(
      createDraftSchema.parse(validDraft({ body: "x".repeat(50_000) })).body
        .length,
      50_000
    );
    assert.throws(() =>
      createDraftSchema.parse(validDraft({ body: "x".repeat(50_001) }))
    );
    assert.deepEqual(
      listSchema.parse({ page: "2", pageSize: "25", q: " поиск " }),
      {
        page: 2,
        pageSize: 25,
        q: "поиск",
        status: "all",
        kind: "all",
      }
    );
    assert.throws(() => listSchema.parse({ page: "0" }));
    assert.throws(() => listSchema.parse({ pageSize: "101" }));
    assert.throws(() => listSchema.parse({ page: "not-an-int" }));
  });
});

describe("M1 config", () => {
  const baseEnv = {
    PGHOST: "127.0.0.1",
    PGPORT: "55432",
    PGUSER: "mailcontrol",
    PGPASSWORD: "not-a-real-password",
  };

  it("uses local mode and exact localhost origins by default", () => {
    const config = loadConfig(baseEnv);
    assert.equal(config.mode, "local");
    assert.equal(config.port, 3000);
    assert.equal(config.database.host, "127.0.0.1");
    assert.equal(config.database.database, "mailcontrol_local");
    assert.deepEqual(config.allowedOrigins.slice(0, 3), [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://[::1]:3000",
    ]);
    assert.equal(config.preview, false);
  });

  it("accepts an explicitly configured demo preview", () => {
    const config = loadConfig({
      ...baseEnv,
      APP_MODE: "demo",
      PORT: "5173",
      MAILCONTROL_PREVIEW: "1",
      MAILCONTROL_ALLOWED_ORIGINS:
        "https://preview.example.test, https://preview.example.test",
    });
    assert.equal(config.mode, "demo");
    assert.equal(config.preview, true);
    assert.equal(config.port, 5173);
    assert.deepEqual(config.allowedOrigins, [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://[::1]:5173",
      "https://preview.example.test",
    ]);
  });

  it("rejects invalid mode, port, preview mode, and allowed origins", () => {
    assert.throws(() => loadConfig({ ...baseEnv, APP_MODE: "staging" }));
    assert.throws(() => loadConfig({ ...baseEnv, PORT: "0" }));
    assert.throws(() => loadConfig({ ...baseEnv, PORT: "not-an-int" }));
    assert.throws(() => loadConfig({ ...baseEnv, MAILCONTROL_PREVIEW: "1" }));
    assert.throws(() =>
      loadConfig({
        ...baseEnv,
        MAILCONTROL_ALLOWED_ORIGINS: "javascript:alert(1)",
      })
    );
    assert.throws(() =>
      loadConfig({
        ...baseEnv,
        MAILCONTROL_ALLOWED_ORIGINS: "http://localhost:3000/",
      })
    );
  });
});
