import type { SmtpOverride } from "../config.js";
import {
  SmtpError,
  smtpCheck,
  smtpSend,
  type SmtpClientOptions,
} from "./smtp-client.js";
import type {
  CheckOutcome,
  OutgoingMessage,
  SendOutcome,
  Sender,
  SenderCredentials,
} from "./types.js";

/** Mail: smtp.mail.ru:465, TLS with certificate verification, full email as login. */
export const MAIL_SMTP: SmtpClientOptions = {
  host: "smtp.mail.ru",
  port: 465,
  secure: true,
  timeoutMs: 30000,
};

function describe(error: SmtpError) {
  return error.reply
    ? `${error.reply.code} ${error.reply.text}`.slice(0, 500)
    : error.message.slice(0, 500);
}

function code(error: SmtpError) {
  return error.reply ? String(error.reply.code) : null;
}

const NEEDS_CHECK =
  /confirm|verify|verification|captcha|browser|web|подтверд|провер|application password|пароль приложени/i;
const BLOCKED = /block|suspend|disabled|заблок|отключ/i;
const SPAM = /spam|policy|content|reject|спам|запрещ/i;
const RATE = /limit|too many|rate|quota|throttl|лимит|слишком много/i;

/** One place that knows Mail's answers; the queue only sees the categories. */
export function classifySmtpError(error: SmtpError): SendOutcome {
  const reply = error.reply;
  const message = describe(error);
  const errorCode = code(error);
  const text = reply?.text ?? "";
  const messageStage = ["rcpt", "data", "message"].includes(error.stage);
  const temporary = (category: "temporary" | "connection" = "temporary") =>
    ({
      kind: "rejected",
      category,
      code: errorCode,
      message,
      scope: messageStage ? "message" : "account",
    }) as const;
  if (!reply) {
    if (error.stage === "message")
      return { kind: "unknown", message: `Ответ не получен после передачи письма: ${message}` };
    return temporary("connection");
  }
  const permanent = reply.code >= 500;
  switch (error.stage) {
    case "auth":
      if (!permanent) return temporary();
      if (BLOCKED.test(text))
        return { kind: "rejected", category: "account_blocked", code: errorCode, message };
      if (reply.code === 534 || NEEDS_CHECK.test(text))
        return { kind: "rejected", category: "needs_check", code: errorCode, message };
      return { kind: "rejected", category: "auth", code: errorCode, message };
    case "mail":
      if (!permanent || RATE.test(text)) return temporary();
      if (BLOCKED.test(text))
        return { kind: "rejected", category: "account_blocked", code: errorCode, message };
      return { kind: "rejected", category: "content_or_policy", code: errorCode, message };
    case "rcpt":
      if (!permanent) return temporary();
      if (SPAM.test(text) && !/user|mailbox|recipient|address|адрес/i.test(text))
        return { kind: "rejected", category: "content_or_policy", code: errorCode, message };
      return { kind: "rejected", category: "recipient", code: errorCode, message };
    case "data":
    case "message":
      if (!permanent) return temporary();
      return { kind: "rejected", category: "content_or_policy", code: errorCode, message };
    default:
      return temporary("connection");
  }
}

export function createMailSender(override?: SmtpOverride): Sender {
  const options: SmtpClientOptions = override
    ? {
        host: override.host,
        port: override.port,
        secure: override.secure,
        ca: override.ca,
        servername: "localhost",
        timeoutMs: 5000,
      }
    : MAIL_SMTP;
  return {
    kind: "mail",
    async check(credentials: SenderCredentials): Promise<CheckOutcome> {
      try {
        const reply = await smtpCheck(options, credentials.email, credentials.password);
        return { kind: "ok", response: `${reply.code} ${reply.text}`.slice(0, 200) };
      } catch (error) {
        if (!(error instanceof SmtpError)) throw error;
        const outcome = classifySmtpError(error);
        if (outcome.kind === "rejected" && outcome.category !== "recipient" && outcome.category !== "content_or_policy")
          return outcome as CheckOutcome;
        return {
          kind: "rejected",
          category: "connection",
          code: code(error),
          message: describe(error),
        };
      }
    },
    async send(credentials: SenderCredentials, message: OutgoingMessage): Promise<SendOutcome> {
      try {
        const reply = await smtpSend(options, credentials.email, credentials.password, message);
        return { kind: "accepted", response: `${reply.code} ${reply.text}`.slice(0, 200) };
      } catch (error) {
        if (!(error instanceof SmtpError)) throw error;
        return classifySmtpError(error);
      }
    },
  };
}
