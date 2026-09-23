import fastify from "fastify";
import staticFiles from "@fastify/static";
import { access, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import type { Pool } from "pg";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import type { Health } from "../shared/contracts.js";
import { ApiFailure } from "./errors.js";
import {
  groupSchema,
  createDraftSchema,
  updateDraftSchema,
  idSchema,
  listSchema,
} from "./validation.js";
import {
  createGroup,
  createCampaign,
  updateCampaign,
  listGroups,
  listAccounts,
  listCampaigns,
  listEvents,
  getCampaign,
  getOverview,
} from "./repository.js";

async function fileExists(file: string | undefined) {
  if (!file) return false;
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

export async function createApp(config: Config, pool: Pool, serveWeb = true) {
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
    const info = error as { code?: string; statusCode?: number };
    if (info.code === "23505") {
      return reply.code(409).send({
        error: {
          code: "ALREADY_EXISTS",
          message: "Группа с таким названием уже существует.",
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
    return {
      status: "ok",
      database: "connected",
      mode: config.mode,
      stage: "M1",
      version: "0.1.0",
      sendingEnabled: false,
      archiveAvailable: await fileExists(config.archivePath),
    };
  });
  app.get("/api/overview", () => getOverview(pool, config.mode));
  app.get("/api/groups", (request) =>
    listGroups(pool, listSchema.parse(request.query))
  );
  app.get("/api/accounts", (request) =>
    listAccounts(pool, listSchema.parse(request.query))
  );
  app.get("/api/campaigns", (request) =>
    listCampaigns(pool, listSchema.parse(request.query))
  );
  app.get("/api/events", (request) =>
    listEvents(pool, listSchema.parse(request.query))
  );
  app.get<{ Params: { id: string } }>("/api/campaigns/:id", (request) =>
    getCampaign(pool, idSchema.parse(request.params.id))
  );
  app.post("/api/groups", async (request, reply) => {
    const result = await createGroup(pool, groupSchema.parse(request.body));
    return reply.code(result.created ? 201 : 200).send(result.value);
  });
  app.post("/api/campaigns", async (request, reply) => {
    const result = await createCampaign(
      pool,
      createDraftSchema.parse(request.body)
    );
    return reply.code(result.created ? 201 : 200).send(result.value);
  });
  app.patch<{ Params: { id: string } }>("/api/campaigns/:id", (request) =>
    updateCampaign(
      pool,
      idSchema.parse(request.params.id),
      updateDraftSchema.parse(request.body)
    )
  );

  app.get("/download/mailcontrol-m1.zip", async (_request, reply) => {
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
      .header(
        "Content-Disposition",
        'attachment; filename="MailControl-M1.zip"'
      )
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
      ["/", "/accounts", "/campaigns", "/events"].includes(
        request.url.split("?")[0]
      )
    ) {
      return reply.header("Cache-Control", "no-store").sendFile("index.html");
    }
    return reply.code(404).send({
      error: {
        code: "NOT_FOUND",
        message: "Такой страницы или действия нет в M1.",
      },
    });
  });
  return app;
}
