import path from "node:path";
import type { PoolConfig } from "pg";
import type { AppMode } from "../shared/contracts.js";

export const APP_VERSION = "1.0.0";

export interface SmtpOverride {
  host: string;
  port: number;
  secure: boolean;
  /** PEM CA for the controlled SMTP stand; production keeps the system store. */
  ca?: string;
}

export interface Config {
  mode: AppMode;
  port: number;
  host: string;
  preview: boolean;
  allowedOrigins: string[];
  database: PoolConfig;
  migrationsPath: string;
  webPath: string;
  dataDir: string;
  archivePath?: string;
  workerConcurrency: number;
  /** Only honoured together with MAILCONTROL_SMTP_STAND=1 (tests). */
  smtpOverride?: SmtpOverride;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.APP_MODE ?? "local";
  if (mode !== "local" && mode !== "demo") {
    throw new Error("APP_MODE must be local or demo.");
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
  const concurrency = Number(env.WORKER_CONCURRENCY ?? 4);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error("WORKER_CONCURRENCY must be between 1 and 32.");
  }
  let smtpOverride: SmtpOverride | undefined;
  if (env.MAILCONTROL_SMTP_STAND === "1") {
    const smtpPort = Number(env.MAILCONTROL_SMTP_PORT ?? 465);
    if (!env.MAILCONTROL_SMTP_HOST || !Number.isInteger(smtpPort))
      throw new Error("The SMTP stand needs MAILCONTROL_SMTP_HOST and PORT.");
    smtpOverride = {
      host: env.MAILCONTROL_SMTP_HOST,
      port: smtpPort,
      secure: env.MAILCONTROL_SMTP_SECURE !== "0",
      ca: env.MAILCONTROL_SMTP_CA,
    };
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
    dataDir: path.resolve(env.MAILCONTROL_DATA_DIR ?? ".local/data"),
    archivePath: env.MAILCONTROL_ARCHIVE_PATH
      ? path.resolve(env.MAILCONTROL_ARCHIVE_PATH)
      : undefined,
    workerConcurrency: concurrency,
    smtpOverride,
  };
}
