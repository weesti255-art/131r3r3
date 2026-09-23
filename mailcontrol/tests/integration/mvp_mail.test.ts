import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { createMailSender } from "../../server/sender/mail.js";
import { buildMime } from "../../server/sender/smtp-client.js";
import { isMailDomain, MAIL_DOMAINS } from "../../shared/parsing.js";
import { SmtpStand } from "./smtp_stand.js";

const stand = new SmtpStand();
before(() => stand.start());
after(() => stand.stop());

function sender() {
  return createMailSender({
    host: "127.0.0.1",
    port: stand.port,
    secure: false,
  });
}
const credentials = (email: string) => ({ email, password: "app-password" });
const message = (to: string) => ({
  from: { email: "owner@mail.ru", name: "Иван Петров" },
  to,
  subject: "Тема с кириллицей",
  text: "Первая строка.\n.Строка с точкой\nСледующая строка",
});

describe("A14 Mail adapter on a controlled SMTP stand", () => {
  it("recognises all six Mail domains and rejects others", () => {
    for (const domain of MAIL_DOMAINS)
      assert.equal(isMailDomain(`user@${domain}`), true, domain);
    assert.equal(isMailDomain("user@gmail.com"), false);
    assert.equal(isMailDomain("user@mail.ru.evil.com"), false);
    assert.equal(isMailDomain("user@sub.mail.ru"), false);
  });

  it("logs in with the full address, sends UTF-8 text and reports acceptance", async () => {
    stand.passwords.set("owner@mail.ru", "app-password");
    const outcome = await sender().send(
      credentials("owner@mail.ru"),
      message("reader@example.com")
    );
    assert.equal(outcome.kind, "accepted");
    const received = stand.received.at(-1)!;
    assert.equal(received.user, "owner@mail.ru");
    assert.equal(received.from, "owner@mail.ru");
    assert.equal(received.to, "reader@example.com");
    assert.match(received.data, /Subject: =\?UTF-8\?B\?/);
    assert.match(received.data, /Content-Transfer-Encoding: base64/);
    const body = received.data.split("\r\n\r\n")[1].replace(/\r\n/g, "");
    assert.equal(
      Buffer.from(body, "base64").toString("utf8"),
      "Первая строка.\r\n.Строка с точкой\r\nСледующая строка"
    );
    const check = await sender().check(credentials("owner@mail.ru"));
    assert.equal(check.kind, "ok");
  });

  it("maps wrong password, verification requirement and blocked account to the right categories", async () => {
    stand.passwords.set("wrong@mail.ru", "another-password");
    const auth = await sender().send(
      credentials("wrong@mail.ru"),
      message("r@example.com")
    );
    assert.deepEqual(
      [auth.kind, "category" in auth ? auth.category : null],
      ["rejected", "auth"]
    );
    stand.rulesByUser.set("verify@mail.ru", {
      at: "auth",
      code: 535,
      text: "5.7.8 Please confirm your account in the web interface",
    });
    const verify = await sender().check(credentials("verify@mail.ru"));
    assert.deepEqual(
      [verify.kind, "category" in verify ? verify.category : null],
      ["rejected", "needs_check"]
    );
    stand.rulesByUser.set("locked@mail.ru", {
      at: "mail",
      code: 550,
      text: "5.7.1 Sender account is blocked",
    });
    const blocked = await sender().send(
      credentials("locked@mail.ru"),
      message("r@example.com")
    );
    assert.deepEqual(
      [blocked.kind, "category" in blocked ? blocked.category : null],
      ["rejected", "account_blocked"]
    );
  });

  it("separates recipient errors, content rejections and temporary failures", async () => {
    stand.rulesByRecipient.set("nobody@example.com", {
      at: "rcpt",
      code: 550,
      text: "5.1.1 User unknown",
    });
    const recipient = await sender().send(
      credentials("owner@mail.ru"),
      message("nobody@example.com")
    );
    assert.deepEqual(
      [recipient.kind, "category" in recipient ? recipient.category : null],
      ["rejected", "recipient"]
    );
    stand.rulesByRecipient.set("spamtrap@example.com", {
      at: "message",
      code: 550,
      text: "spam message rejected",
    });
    const spam = await sender().send(
      credentials("owner@mail.ru"),
      message("spamtrap@example.com")
    );
    assert.deepEqual(
      [spam.kind, "category" in spam ? spam.category : null],
      ["rejected", "content_or_policy"]
    );
    stand.rulesByRecipient.set("busy@example.com", {
      at: "rcpt",
      code: 451,
      text: "4.7.1 Try again later",
    });
    const busy = await sender().send(
      credentials("owner@mail.ru"),
      message("busy@example.com")
    );
    assert.deepEqual(
      [
        busy.kind,
        "category" in busy ? busy.category : null,
        "scope" in busy ? busy.scope : null,
      ],
      ["rejected", "temporary", "message"]
    );
    stand.rulesByUser.set("rate@mail.ru", {
      at: "mail",
      code: 421,
      text: "4.7.0 Too many connections, try later",
    });
    const rate = await sender().send(
      credentials("rate@mail.ru"),
      message("r@example.com")
    );
    assert.deepEqual(
      [
        rate.kind,
        "category" in rate ? rate.category : null,
        "scope" in rate ? rate.scope : null,
      ],
      ["rejected", "temporary", "account"]
    );
  });

  it("treats a lost answer after the message was handed over as an unknown outcome, not as a failure", async () => {
    stand.rulesByRecipient.set("silent@example.com", {
      at: "message",
      drop: true,
    });
    const outcome = await sender().send(
      credentials("owner@mail.ru"),
      message("silent@example.com")
    );
    assert.equal(outcome.kind, "unknown");
    const closed = createMailSender({
      host: "127.0.0.1",
      port: 1,
      secure: false,
    });
    const refused = await closed.send(
      credentials("owner@mail.ru"),
      message("r@example.com")
    );
    assert.deepEqual(
      [refused.kind, "category" in refused ? refused.category : null],
      ["rejected", "connection"]
    );
  });

  it("builds a MIME message with encoded display name and no bare CR/LF", () => {
    const mime = buildMime(message("reader@example.com"), "mail.ru");
    assert.match(mime, /^From: =\?UTF-8\?B\?.+\?= <owner@mail\.ru>\r\n/);
    assert.match(mime, /\r\nTo: <reader@example\.com>\r\n/);
    assert.equal(/[^\r]\n/.test(mime), false);
  });
});
