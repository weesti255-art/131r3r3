import { loadConfig } from "./config.js";
import { createKeyStore } from "./crypto.js";
import { createPool, initializeDatabase, waitForDatabase } from "./database.js";
import { Worker } from "./worker-core.js";

async function main() {
  const config = loadConfig();
  const pool = createPool(config.database);
  await waitForDatabase(pool);
  await initializeDatabase(pool, config.migrationsPath, config.mode);
  const worker = new Worker({
    pool,
    config,
    keys: createKeyStore(config.dataDir),
  });
  const controller = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => controller.abort());
  }
  console.log(
    `MailControl worker ${worker.id.slice(0, 8)}: mode ${config.mode}, concurrency ${config.workerConcurrency}.`
  );
  await worker.run(controller.signal);
  await pool.end();
}

main().catch((error: unknown) => {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "startup";
  console.error(
    `[mailcontrol worker] failed (${code}): ${(error as Error).message}`
  );
  process.exitCode = 1;
});
