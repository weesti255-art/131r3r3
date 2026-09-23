import path from "node:path";
import type { PoolConfig } from "pg";
import type { AppMode } from "../shared/contracts.js";

export interface Config {
  mode: AppMode;
  port: number;
  host: string;
  preview: boolean;
  allowedOrigins: string[];
  database: PoolConfig;
  migrationsPath: string;
  webPath: string;
  archivePath?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.APP_MODE ?? "local";
  if (mode !== "local" && mode !== "demo") {
    throw new Error(
      "APP_MODE must be local or demo; sending is not implemented in M1."
    );
  }
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid PORT.");
  }
  if (!env.PGPASSWORD && !env.DATABASE_URL) {
    throw new Error("Database access is not configured.");
  }
  const preview = env.MAILCONTROL_PREVIEW === "1";
  if (preview && mode !== "demo") {
    throw new Error("A remote preview is allowed only in demo mode.");
  }
  const origins = [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
    ...(env.MAILCONTROL_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ];
  for (const value of origins) {
    const parsed = new URL(value);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.origin !== value
    ) {
      throw new Error("Allowed origins must be exact HTTP(S) origins.");
    }
  }
  return {
    mode,
    port,
    host: env.HOST ?? "127.0.0.1",
    preview,
    allowedOrigins: [...new Set(origins)],
    database: env.DATABASE_URL
      ? { connectionString: env.DATABASE_URL }
      : {
          host: env.PGHOST ?? "127.0.0.1",
          port: Number(env.PGPORT ?? 5432),
          user: env.PGUSER ?? "mailcontrol",
          password: env.PGPASSWORD,
          database: env.PGDATABASE ?? `mailcontrol_${mode}`,
        },
    migrationsPath: path.resolve("db"),
    webPath: path.resolve("dist/web"),
    archivePath: env.MAILCONTROL_ARCHIVE_PATH
      ? path.resolve(env.MAILCONTROL_ARCHIVE_PATH)
      : undefined,
  };
}
