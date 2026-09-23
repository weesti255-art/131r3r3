import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { strict as assert } from "node:assert";
import type { FastifyInstance } from "fastify";
import type { PoolConfig } from "pg";
import type { AppMode } from "../../shared/contracts.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createApp } from "../../server/app.js";
import { loadConfig, type Config } from "../../server/config.js";
import { createKeyStore, type KeyStore } from "../../server/crypto.js";
import { createPool, initializeDatabase } from "../../server/database.js";

const generatedDatabaseNames = new Set<string>();
const createdDatabaseNames = new Set<string>();

function requiredEnv(name: string) {
  const value = process.env[name];
  assert.ok(
    value,
    `Integration tests require ${name}; source .local/preview.env first.`
  );
  return value;
}

function adminPoolConfig(): PoolConfig {
  const port = Number(requiredEnv("PGPORT"));
  assert.ok(
    Number.isInteger(port) && port > 0 && port < 65536,
    "PGPORT must be a valid port"
  );
  return {
    host: requiredEnv("PGHOST"),
    port,
    user: process.env.PGADMINUSER ?? requiredEnv("PGUSER"),
    password: process.env.PGADMINPASSWORD ?? requiredEnv("PGPASSWORD"),
    database: "postgres",
    connectionTimeoutMillis: 5000,
  };
}

function quoteGeneratedIdentifier(name: string) {
  assert.match(name, /^mailcontrol_test_[0-9a-f]{32}$/);
  return `"${name}"`;
}

async function createDatabase(name: string) {
  const admin = createPool(adminPoolConfig());
  try {
    const owner = requiredEnv("PGUSER");
    assert.match(owner, /^[a-z_][a-z0-9_]{0,62}$/);
    await admin.query(
      `CREATE DATABASE ${quoteGeneratedIdentifier(name)} OWNER "${owner}"`
    );
    createdDatabaseNames.add(name);
  } finally {
    await admin.end();
  }
}

export async function createTestDatabase() {
  requiredEnv("PGHOST");
  requiredEnv("PGPORT");
  requiredEnv("PGUSER");
  requiredEnv("PGPASSWORD");
  const name = `mailcontrol_test_${randomBytes(16).toString("hex")}`;
  assert.match(name, /^mailcontrol_test_[0-9a-f]{32}$/);
  generatedDatabaseNames.add(name);
  await createDatabase(name);
  return name;
}

function appConfig(database: string, mode: AppMode): Config {
  const base = loadConfig({
    ...process.env,
    APP_MODE: mode,
    PORT: "3000",
    MAILCONTROL_PREVIEW: "",
    PGDATABASE: database,
    DATABASE_URL: "",
  });
  return {
    ...base,
    mode,
    preview: false,
    allowedOrigins: ["http://localhost:3000"],
    database: { ...base.database, database },
    migrationsPath: path.resolve("db"),
    webPath: path.resolve("dist/web"),
    archivePath: undefined,
  };
}

export interface OpenedTestApp {
  database: string;
  mode: AppMode;
  pool: ReturnType<typeof createPool>;
  app: FastifyInstance;
  keys: KeyStore;
  config: Config;
}

export async function testKeyStore() {
  return createKeyStore(
    await mkdtemp(path.join(tmpdir(), "mailcontrol-keys-"))
  );
}

export async function openExistingTestApp(
  database: string,
  mode: AppMode
): Promise<OpenedTestApp> {
  assert.match(database, /^mailcontrol_test_[0-9a-f]{32}$/);
  assert.ok(
    generatedDatabaseNames.has(database),
    "Refusing to open an untracked test database"
  );
  const config = appConfig(database, mode);
  const pool = createPool(config.database);
  try {
    await initializeDatabase(pool, path.resolve("db"), mode);
    const keys = await testKeyStore();
    const app = await createApp(config, pool, keys, false);
    return { database, mode, pool, app, keys, config };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

export async function openTestApp(mode: AppMode = "local") {
  const database = await createTestDatabase();
  return openExistingTestApp(database, mode);
}

export async function closeTestApp(opened: OpenedTestApp) {
  await opened.app.close().catch(() => undefined);
  try {
    await opened.pool.end();
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "Called end on pool more than once"
    ) {
      throw error;
    }
  }
}

export async function withTestApp<T>(
  mode: AppMode,
  callback: (opened: OpenedTestApp) => Promise<T>
) {
  const opened = await openTestApp(mode);
  try {
    return await callback(opened);
  } finally {
    await closeTestApp(opened);
  }
}

export function requestHeaders(overrides: Record<string, string> = {}) {
  return {
    host: "localhost:3000",
    origin: "http://localhost:3000",
    ...overrides,
  };
}

export async function jsonRequest(
  app: FastifyInstance,
  method: "GET" | "POST" | "PATCH" | "PUT",
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {}
) {
  return app.inject({
    method,
    url,
    headers: requestHeaders({
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    }),
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

export function responseJson<T = Record<string, unknown>>(response: {
  body: string;
}) {
  return JSON.parse(response.body) as T;
}

export function uuid() {
  return randomUUID();
}

export async function cleanupTestDatabases() {
  const names = [...createdDatabaseNames];
  if (names.length === 0) return;
  for (const name of names) {
    assert.match(name, /^mailcontrol_test_[0-9a-f]{32}$/);
    const admin = createPool(adminPoolConfig());
    try {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [name]
      );
      await admin.query(`DROP DATABASE ${quoteGeneratedIdentifier(name)}`);
      createdDatabaseNames.delete(name);
      generatedDatabaseNames.delete(name);
    } finally {
      await admin.end();
    }
  }
}
