import fastify from "fastify";
import staticFiles from "@fastify/static";
import { access, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import type { Pool } from "pg";
import { ZodError } from "zod";
import { APP_VERSION, type Config } from "./config.js";
import type { Health } from "../shared/contracts.js";
import { ApiFailure } from "./errors.js";
import type { KeyStore } from "./crypto.js";
import {
  accountImportSchema,
  bigIdSchema,
  bulkAccountSchema,
  createDraftSchema,
  eventListSchema,
  groupSchema,
  idSchema,
  importPreviewSchema,
  listSchema,
  overviewSchema,
  recipientsSchema,
  requestKeySchema,
  resolveTaskSchema,
  settingsSchema,
  taskListSchema,
  templateSchema,
  testSendSchema,
  updateDraftSchema,
} from "./validation.js";
import {
  createGroup,
  createCampaign,
  updateCampaign,
  listGroups,
  listAccounts,
  listCampaigns,
  listEvents,
  listTasks,
  listAttempts,
  listWorkers,
  getAttempt,
  getCampaign,
  getOverview,
  getSettings,
  loadSettingsRow,
  updateSettings,
} from "./repository.js";
import {
  accountTemplate,
  bulkAccounts,
  checkAccount,
  checkMany,
  importAccounts,
  previewAccountImport,
} from "./accounts.js";
import {
  campaignReportCsv,
  createTestSend,
  excludeTask,
  pauseCampaign,
  previewRecipients,
  resolveTask,
  resumeCampaign,
  setRecipients,
  startCampaign,
  stopCampaign,
} from "./campaigns.js";
import { createMailSender } from "./sender/mail.js";
import { createTestSender } from "./sender/test.js";
import type { Sender } from "./sender/types.js";

function isWebRoute(pathname: string) {
  return (
    ["/", "/accounts", "/campaigns", "/events", "/settings"].includes(
      pathname
    ) || /^\/campaigns\/[0-9a-f-]{36}$/i.test(pathname)
  );
}

async function fileExists(file: string | undefined) {
  if (!file) return false;
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

export async function createApp(
  config: Config,
  pool: Pool,
  keys: KeyStore,
  serveWeb = true
) {
  const mailSenderAllowed = config.mode === "local" && !config.preview;
  async function effectiveSenderKind(): Promise<"test" | "mail"> {
    const settings = await loadSettingsRow(pool);
    return mailSenderAllowed ? settings.sender_kind : "test";
  }
  async function currentSender(): Promise<Sender> {
    const kind = await effectiveSenderKind();
    if (kind === "mail") return createMailSender(config.smtpOverride);
    const settings = await loadSettingsRow(pool);
    return createTestSender({
      delayMs: () => Math.min(settings.test_sender_delay_ms, 300),
    });
  }
  const app = fastify({
    logger: false,
    bodyLimit: 300000,
    requestTimeout: 15000,
  });
  const allowedOrigins = new Set(config.allowedOrigins);
  const allowedHosts = new Set(
    config.allowedOrigins.map((origin) => new URL(origin).host)
  );

  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()"
    );
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'" +
        (config.preview ? "" : "; frame-ancestors 'self'")
    );
    if (!config.preview) reply.header("X-Frame-Options", "SAMEORIGIN");
    const host = request.headers.host?.toLowerCase();
    const readOnly = request.method === "GET" || request.method === "HEAD";
    // A managed demo can be inspected before its exact external origin is configured.
    if (!host || (!allowedHosts.has(host) && !(config.preview && readOnly))) {
      throw new ApiFailure(
        403,
        "HOST_NOT_ALLOWED",
        "Доступ разрешён только через адрес этого приложения."
      );
    }
    if (request.url.startsWith("/api/"))
      reply.header("Cache-Control", "no-store");
    if (!readOnly) {
      const origin = request.headers.origin;
      if (
        (origin && !allowedOrigins.has(origin)) ||
        request.headers["sec-fetch-site"] === "cross-site"
      ) {
        throw new ApiFailure(
          403,
          "ORIGIN_NOT_ALLOWED",
          "Запрос с другого сайта запрещён."
        );
      }
      if (!["POST", "PATCH", "PUT", "DELETE"].includes(request.method)) {
        throw new ApiFailure(
          405,
          "METHOD_NOT_ALLOWED",
          "Этот метод не поддерживается."
        );
      }
      if (
        !["DELETE"].includes(request.method) &&
        !/^application\/json(?:\s*;|$)/i.test(
          request.headers["content-type"] ?? ""
        )
      ) {
        throw new ApiFailure(
          415,
          "JSON_REQUIRED",
          "Ожидаются данные в формате JSON."
        );
      }
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      const fields: Record<string, string> = {};
      for (const issue of error.issues)
        fields[issue.path.join(".") || "form"] ??= issue.message;
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Проверьте заполнение полей.",
          fields,
        },
      });
    }
    if (error instanceof ApiFailure) {
      return reply
        .code(error.status)
        .send({ error: { code: error.code, message: error.message } });
    }
    const info = error as {
      code?: string;
      statusCode?: number;
      constraint?: string;
    };
    if (info.code === "23505") {
      return reply.code(409).send({
        error: {
          code: "ALREADY_EXISTS",
          message:
            info.constraint === "account_groups_name_unique"
              ? "Группа с таким названием уже существует."
              : "Такая запись уже существует. Обновите страницу.",
        },
      });
    }
    if (info.code === "23503") {
      return reply.code(400).send({
        error: {
          code: "GROUP_NOT_FOUND",
          message: "Выбранная группа не найдена. Обновите страницу.",
        },
      });
    }
    if (info.statusCode && info.statusCode >= 400 && info.statusCode < 500) {
      return reply.code(info.statusCode).send({
        error: {
          code: "INVALID_REQUEST",
          message:
            info.statusCode === 413
              ? "Запрос слишком большой."
              : "Некорректный запрос.",
        },
      });
    }
    console.error(
      `[mailcontrol] request ${request.id} failed (${info.code ?? "internal"})`
    );
    return reply.code(503).send({
      error: {
        code: "SERVICE_UNAVAILABLE",
        message:
          "Сервер или база данных недоступны. Изменения не подтверждены — повторите сохранение после восстановления связи.",
      },
    });
  });

  app.get("/api/health", async (): Promise<Health> => {
    await pool.query("SELECT 1");
    const senderKind = await effectiveSenderKind();
    const workers = await listWorkers(pool);
    return {
      status: "ok",
      database: "connected",
      mode: config.mode,
      stage: "MVP-1",
      version: APP_VERSION,
      senderKind,
      sendingEnabled: senderKind === "mail",
      workersAlive: workers.filter((worker) => worker.alive).length,
      archiveAvailable: await fileExists(config.archivePath),
    };
  });
  app.get("/api/overview", async (request) => {
    const query = overviewSchema.parse(request.query);
    const since = query.since
      ? new Date(query.since)
      : new Date(new Date().setUTCHours(0, 0, 0, 0));
    return getOverview(pool, config.mode, since, await effectiveSenderKind());
  });
  app.get("/api/settings", () =>
    getSettings(pool, config.mode, mailSenderAllowed)
  );
  app.patch("/api/settings", (request) =>
    updateSettings(
      pool,
      config.mode,
      mailSenderAllowed,
      settingsSchema.parse(request.body)
    )
  );

  app.get("/api/groups", (request) =>
    listGroups(pool, listSchema.parse(request.query))
  );
  app.post("/api/groups", async (request, reply) => {
    const result = await createGroup(pool, groupSchema.parse(request.body));
    return reply.code(result.created ? 201 : 200).send(result.value);
  });

  app.get("/api/accounts", (request) =>
    listAccounts(pool, listSchema.parse(request.query))
  );
  app.get("/api/accounts/import/template", (request, reply) => {
    const { format } = templateSchema.parse(request.query);
    return reply
      .header(
        "Content-Type",
        format === "csv"
          ? "text/csv; charset=utf-8"
          : "text/plain; charset=utf-8"
      )
      .header(
        "Content-Disposition",
        `attachment; filename="mailcontrol-accounts-template.${format === "csv" ? "csv" : "txt"}"`
      )
      .send(accountTemplate(format));
  });
  app.post("/api/accounts/import/preview", (request) => {
    const input = importPreviewSchema.parse(request.body);
    return previewAccountImport(pool, input.text, input.format);
  });
  app.post("/api/accounts/import", (request) =>
    importAccounts(pool, keys, accountImportSchema.parse(request.body))
  );
  app.post("/api/accounts/bulk", async (request) => {
    const input = bulkAccountSchema.parse(request.body);
    const sender = await currentSender();
    return bulkAccounts(pool, input, (ids) =>
      checkMany(pool, keys, sender, ids)
    );
  });
  app.post<{ Params: { id: string } }>(
    "/api/accounts/:id/check",
    async (request) => {
      requestKeySchema.parse(request.body);
      return checkAccount(
        pool,
        keys,
        await currentSender(),
        idSchema.parse(request.params.id)
      );
    }
  );

  app.get("/api/campaigns", (request) =>
    listCampaigns(pool, listSchema.parse(request.query))
  );
  app.post("/api/campaigns", async (request, reply) => {
    const result = await createCampaign(
      pool,
      createDraftSchema.parse(request.body)
    );
    return reply.code(result.created ? 201 : 200).send(result.value);
  });
  app.get<{ Params: { id: string } }>("/api/campaigns/:id", (request) =>
    getCampaign(pool, idSchema.parse(request.params.id))
  );
  app.patch<{ Params: { id: string } }>("/api/campaigns/:id", (request) =>
    updateCampaign(
      pool,
      idSchema.parse(request.params.id),
      updateDraftSchema.parse(request.body)
    )
  );
  app.post<{ Params: { id: string } }>(
    "/api/campaigns/:id/recipients/preview",
    (request) => {
      idSchema.parse(request.params.id);
      const input = importPreviewSchema.parse(request.body);
      return previewRecipients(input.text, input.format);
    }
  );
  app.put<{ Params: { id: string } }>(
    "/api/campaigns/:id/recipients",
    (request) =>
      setRecipients(
        pool,
        idSchema.parse(request.params.id),
        recipientsSchema.parse(request.body)
      )
  );
  app.get<{ Params: { id: string } }>("/api/campaigns/:id/tasks", (request) =>
    listTasks(
      pool,
      idSchema.parse(request.params.id),
      taskListSchema.parse(request.query)
    )
  );
  app.get<{ Params: { id: string; taskId: string } }>(
    "/api/campaigns/:id/tasks/:taskId/attempts",
    (request) =>
      listAttempts(
        pool,
        idSchema.parse(request.params.id),
        bigIdSchema.parse(request.params.taskId)
      )
  );
  const actions = {
    start: startCampaign,
    pause: pauseCampaign,
    resume: resumeCampaign,
    stop: stopCampaign,
  };
  for (const [name, action] of Object.entries(actions)) {
    app.post<{ Params: { id: string } }>(
      `/api/campaigns/:id/${name}`,
      (request) => {
        requestKeySchema.parse(request.body);
        return action(pool, idSchema.parse(request.params.id));
      }
    );
  }
  app.post<{ Params: { id: string } }>(
    "/api/campaigns/:id/test-send",
    (request) => {
      const input = testSendSchema.parse(request.body);
      return createTestSend(
        pool,
        idSchema.parse(request.params.id),
        input.recipient,
        input.requestKey
      );
    }
  );
  app.post<{ Params: { id: string; taskId: string } }>(
    "/api/campaigns/:id/tasks/:taskId/exclude",
    (request) => {
      requestKeySchema.parse(request.body);
      return excludeTask(
        pool,
        idSchema.parse(request.params.id),
        bigIdSchema.parse(request.params.taskId)
      );
    }
  );
  app.post<{ Params: { id: string; taskId: string } }>(
    "/api/campaigns/:id/tasks/:taskId/resolve",
    (request) => {
      const input = resolveTaskSchema.parse(request.body);
      return resolveTask(
        pool,
        idSchema.parse(request.params.id),
        bigIdSchema.parse(request.params.taskId),
        input.decision,
        input.requestKey
      );
    }
  );
  app.get<{ Params: { id: string } }>(
    "/api/campaigns/:id/report.csv",
    async (request, reply) => {
      const report = await campaignReportCsv(
        pool,
        idSchema.parse(request.params.id)
      );
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header(
          "Content-Disposition",
          `attachment; filename="mailcontrol-${report.campaign.id.slice(0, 8)}.csv"; filename*=UTF-8''${encodeURIComponent(report.filename)}`
        )
        .send(report.content);
    }
  );

  app.get("/api/events", (request) =>
    listEvents(pool, eventListSchema.parse(request.query))
  );
  app.get<{ Params: { id: string } }>("/api/attempts/:id", (request) =>
    getAttempt(pool, bigIdSchema.parse(request.params.id))
  );

  app.get("/download/mailcontrol.zip", async (_request, reply) => {
    if (!config.archivePath || !(await fileExists(config.archivePath))) {
      throw new ApiFailure(
        404,
        "ARCHIVE_NOT_AVAILABLE",
        "Архив ещё не подготовлен."
      );
    }
    const metadata = await stat(config.archivePath);
    return reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", 'attachment; filename="MailControl.zip"')
      .header("Content-Length", metadata.size)
      .header("Cache-Control", "no-store")
      .send(createReadStream(config.archivePath));
  });

  if (serveWeb) {
    await access(config.webPath);
    await app.register(staticFiles, {
      root: config.webPath,
      index: ["index.html"],
    });
  }
  app.setNotFoundHandler((request, reply) => {
    if (
      serveWeb &&
      request.method === "GET" &&
      isWebRoute(request.url.split("?")[0])
    ) {
      return reply.header("Cache-Control", "no-store").sendFile("index.html");
    }
    return reply.code(404).send({
      error: {
        code: "NOT_FOUND",
        message: "Такой страницы или действия нет.",
      },
    });
  });
  return app;
}
