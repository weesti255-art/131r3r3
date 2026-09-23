import type {
  CheckOutcome,
  OutgoingMessage,
  SendOutcome,
  Sender,
  SenderCredentials,
} from "./types.js";

export interface TestSenderOptions {
  delayMs: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function localPart(email: string) {
  return email.slice(0, email.indexOf("@")).toLowerCase();
}

/**
 * Deterministic behaviour keyed by address prefixes, documented in README.
 * Accounts: auth-error*, needs-check*, blocked*, temp-error*.
 * Recipients: fail-address or bounce, fail-temp*, fail-content or spam, unknown or lost.
 */
export function classifyTestAccount(email: string): CheckOutcome {
  const local = localPart(email);
  if (local.startsWith("auth-error"))
    return {
      kind: "rejected",
      category: "auth",
      code: "535",
      message: "Тестовый отправитель: неверный пароль приложения",
    };
  if (local.startsWith("needs-check"))
    return {
      kind: "rejected",
      category: "needs_check",
      code: "535",
      message: "Тестовый отправитель: требуется подтверждение владельца",
    };
  if (local.startsWith("blocked"))
    return {
      kind: "rejected",
      category: "account_blocked",
      code: "550",
      message: "Тестовый отправитель: ящик заблокирован сервисом",
    };
  if (local.startsWith("temp-error"))
    return {
      kind: "rejected",
      category: "temporary",
      code: "421",
      message: "Тестовый отправитель: временная ошибка сервиса",
    };
  return { kind: "ok", response: "Тестовый отправитель: вход выполнен" };
}

export function classifyTestRecipient(email: string): SendOutcome {
  const local = localPart(email);
  if (local.startsWith("fail-address") || local.startsWith("bounce"))
    return {
      kind: "rejected",
      category: "recipient",
      code: "550",
      message: "Тестовый отправитель: адрес получателя не существует",
    };
  if (local.startsWith("fail-temp"))
    return {
      kind: "rejected",
      category: "temporary",
      code: "451",
      message: "Тестовый отправитель: временная ошибка, повторите позже",
      scope: "message",
    };
  if (local.startsWith("fail-content") || local.startsWith("spam"))
    return {
      kind: "rejected",
      category: "content_or_policy",
      code: "550",
      message: "Тестовый отправитель: письмо отклонено как спам",
    };
  if (local.startsWith("unknown") || local.startsWith("lost"))
    return {
      kind: "unknown",
      message:
        "Тестовый отправитель: ответ сервера потерян после передачи письма",
    };
  return { kind: "accepted", response: "250 OK (тестовый отправитель)" };
}

export function createTestSender(options: TestSenderOptions): Sender {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return {
    kind: "test",
    async check(credentials: SenderCredentials) {
      await sleep(Math.min(options.delayMs(), 200));
      return classifyTestAccount(credentials.email);
    },
    async send(credentials: SenderCredentials, message: OutgoingMessage) {
      await sleep(options.delayMs());
      const account = classifyTestAccount(credentials.email);
      if (account.kind === "rejected") return account;
      return classifyTestRecipient(message.to);
    },
  };
}
