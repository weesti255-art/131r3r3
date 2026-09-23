import { strict as assert } from "node:assert";
import { after, describe, it } from "node:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../server/app.js";
import { loadConfig } from "../../server/config.js";
import { initializeDatabase } from "../../server/database.js";
import { cleanupTestDatabases, testKeyStore, withTestApp } from "./helpers.js";

after(cleanupTestDatabases);

describe("M1 web distribution", () => {
  it("serves the document on every screen and streams only the configured ZIP", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "mailcontrol-static-"));
    try {
      const webPath = path.join(temporary, "web");
      await mkdir(webPath);
      const html =
        '<!doctype html><html lang="ru"><title>MailControl</title></html>';
      const archivePath = path.join(temporary, "MailControl-M1.zip");
      const zip = Buffer.from("PK\u0003\u0004static-endpoint-fixture");
      await writeFile(path.join(webPath, "index.html"), html);
      await writeFile(archivePath, zip);
      await withTestApp("local", async ({ pool }) => {
        const app = await createApp(
          {
            ...loadConfig({
              ...process.env,
              APP_MODE: "local",
              PORT: "3000",
              MAILCONTROL_PREVIEW: "",
            }),
            allowedOrigins: ["http://localhost:3000"],
            webPath,
            archivePath,
          },
          pool,
          await testKeyStore()
        );
        try {
          for (const url of ["/", "/accounts", "/campaigns", "/events"]) {
            const response = await app.inject({
              url,
              headers: { host: "localhost:3000" },
            });
            assert.equal(response.statusCode, 200, url);
            assert.match(
              String(response.headers["content-type"]),
              /text\/html/
            );
            assert.equal(response.body, html);
          }
          const downloaded = await app.inject({
            url: "/download/mailcontrol.zip",
            headers: { host: "localhost:3000" },
          });
          assert.equal(downloaded.statusCode, 200);
          assert.equal(downloaded.headers["content-type"], "application/zip");
          assert.match(
            String(downloaded.headers["content-disposition"]),
            /attachment/
          );
          assert.deepEqual(downloaded.rawPayload, zip);
          const missing = await app.inject({
            url: "/missing-file",
            headers: { host: "localhost:3000" },
          });
          assert.equal(missing.statusCode, 404);
          const traversal = await app.inject({
            url: "/download/../../.env",
            headers: { host: "localhost:3000" },
          });
          assert.notEqual(traversal.statusCode, 200);
        } finally {
          await app.close();
        }
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("refuses changed migrations rather than silently rewriting saved schema history", async () => {
    const temporary = await mkdtemp(
      path.join(tmpdir(), "mailcontrol-migrations-")
    );
    try {
      const original = await readFile("db/001_initial.sql", "utf8");
      await writeFile(
        path.join(temporary, "001_initial.sql"),
        original + "\n-- deliberately changed test copy\n"
      );
      await withTestApp("local", async ({ pool }) => {
        await assert.rejects(
          initializeDatabase(pool, temporary, "local"),
          /Applied migration changed/
        );
        const count = await pool.query(
          "SELECT count(*)::int AS count FROM schema_migrations"
        );
        assert.equal(count.rows[0].count, 2);
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
