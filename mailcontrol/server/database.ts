import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg, { type PoolClient, type PoolConfig } from "pg";
import type { AppMode } from "../shared/contracts.js";
import { seedDemo } from "./demo.js";

pg.types.setTypeParser(1184, (value) => new Date(value).toISOString());

export function createPool(config: PoolConfig) {
  const pool = new pg.Pool({
    ...config,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 10000,
    application_name: "mailcontrol-m1",
  });
  pool.on("error", () =>
    console.error("[mailcontrol] database connection interrupted")
  );
  return pool;
}

/** Docker starts the database first, but authentication may still be settling. */
export async function waitForDatabase(pool: pg.Pool, attempts = 20) {
  for (let index = 1; ; index++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (error) {
      if (index >= attempts) throw error;
      console.error(`[mailcontrol] database not ready (${(error as { code?: string }).code ?? "error"}), retry ${index}/${attempts}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

export async function transaction<T>(
  pool: pg.Pool,
  action: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await action(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function initializeDatabase(
  pool: pg.Pool,
  migrationsPath: string,
  mode: AppMode
) {
  await transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(173103101)");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const files = (await readdir(migrationsPath))
      .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
      .sort();
    for (const file of files) {
      const sql = (
        await readFile(path.join(migrationsPath, file), "utf8")
      ).replaceAll("\r\n", "\n");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const applied = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE version = $1",
        [file]
      );
      if (applied.rowCount) {
        if (applied.rows[0].checksum !== checksum) {
          throw new Error(`Applied migration changed: ${file}`);
        }
        continue;
      }
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)",
        [file, checksum]
      );
    }
    await client.query(
      "INSERT INTO app_settings(singleton, mode) VALUES (true, $1) ON CONFLICT DO NOTHING",
      [mode]
    );
    const result = await client.query<{
      mode: AppMode;
      demo_seed_version: number;
    }>(
      "SELECT mode, demo_seed_version FROM app_settings WHERE singleton = true FOR UPDATE"
    );
    if (result.rows[0]?.mode !== mode) {
      throw new Error(
        "Database mode mismatch. Use a separate database for demo and local modes."
      );
    }
    if (mode === "demo" && result.rows[0].demo_seed_version < 1) {
      await seedDemo(client);
      await client.query(
        "UPDATE app_settings SET demo_seed_version = 1 WHERE singleton = true"
      );
    }
  });
}
