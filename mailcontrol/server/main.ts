import { loadConfig } from "./config.js";
import { createPool, initializeDatabase } from "./database.js";
import { createApp } from "./app.js";

async function main() {
  const config = loadConfig();
  const pool = createPool(config.database);
  try {
    await initializeDatabase(pool, config.migrationsPath, config.mode);
    const app = await createApp(config, pool);
    app.addHook("onClose", () => pool.end());
    let closing = false;
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => {
        if (closing) return;
        closing = true;
        void app.close().catch(() => {
          process.exitCode = 1;
        });
      });
    }
    await app.listen({ port: config.port, host: config.host });
    console.log(
      `MailControl M1: port ${config.port}, mode ${config.mode}. Sending is disabled.`
    );
  } catch (error) {
    await pool.end();
    throw error;
  }
}

main().catch((error: unknown) => {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "configuration_or_migration";
  console.error(
    `[mailcontrol] startup failed (${code}). Check PostgreSQL, APP_MODE and migration consistency.`
  );
  process.exitCode = 1;
});
