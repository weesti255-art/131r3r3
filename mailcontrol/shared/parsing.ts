/** Import parsing shared by server and tests: accounts `email | app_password` and recipients `email`. */

export const MAIL_DOMAINS = [
  "mail.ru",
  "inbox.ru",
  "bk.ru",
  "list.ru",
  "internet.ru",
  "xmail.ru",
] as const;

const EMAIL_PATTERN =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_PATTERN.test(value);
}

export function isMailDomain(email: string): boolean {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  return (MAIL_DOMAINS as readonly string[]).includes(domain);
}

export interface ParsedLine {
  line: number;
  fields: string[];
}

/** RFC 4180-style CSV: quotes, doubled quotes, CR/LF inside quotes. */
export function parseCsv(text: string): ParsedLine[] {
  const rows: ParsedLine[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  const source = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index++;
        } else quoted = false;
      } else {
        if (char === "\n") line++;
        field += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      fields.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index++;
      fields.push(field);
      rows.push({ line: rowLine, fields });
      fields = [];
      field = "";
      line++;
      rowLine = line;
    } else field += char;
  }
  if (field.length || fields.length) {
    fields.push(field);
    rows.push({ line: rowLine, fields });
  }
  return rows.filter((row) => row.fields.some((value) => value.trim() !== ""));
}

export function parseLines(text: string, separator = "|"): ParsedLine[] {
  return text
    .replace(/^\uFEFF/, "")
    .split(/\r\n|\r|\n/)
    .map((raw, index) => ({ line: index + 1, raw: raw.trim() }))
    .filter((row) => row.raw !== "")
    .map((row) => ({
      line: row.line,
      fields: row.raw.split(separator).map((value) => value.trim()),
    }));
}

export type AccountRow =
  | { line: number; ok: true; email: string; password: string }
  | { line: number; ok: false; email: string | null; reason: string };

function checkAccountEmail(raw: string): string | null {
  const email = normalizeEmail(raw);
  if (!isValidEmail(email)) return "Некорректный адрес электронной почты";
  if (!isMailDomain(email))
    return "Домен не относится к Почте Mail (mail.ru, inbox.ru, bk.ru, list.ru, internet.ru, xmail.ru)";
  return null;
}

/**
 * Error rows expose the email only when it parsed as a plausible address;
 * the raw line (which may hold a password) is never returned.
 */
export function parseAccounts(
  text: string,
  format: "lines" | "csv"
): AccountRow[] {
  let rows: ParsedLine[];
  if (format === "csv") {
    rows = parseCsv(text);
    const header = rows[0]?.fields.map((value) => value.trim().toLowerCase());
    if (
      !header ||
      header[0] !== "email" ||
      header[1] !== "app_password" ||
      header.length !== 2
    ) {
      return [
        {
          line: 1,
          ok: false,
          email: null,
          reason: "Ожидается заголовок CSV: email,app_password",
        },
      ];
    }
    rows = rows.slice(1);
  } else {
    rows = parseLines(text);
  }
  return rows.map((row) => {
    const [rawEmail = "", password = "", ...rest] = row.fields;
    const email = normalizeEmail(rawEmail);
    const safeEmail = isValidEmail(email) ? email : null;
    if (rest.length > 0 || row.fields.length < 2) {
      return {
        line: row.line,
        ok: false as const,
        email: safeEmail,
        reason:
          format === "csv"
            ? "Ожидаются ровно два поля: email и пароль приложения"
            : "Ожидается строка вида email | app_password",
      };
    }
    const emailProblem = checkAccountEmail(rawEmail);
    if (emailProblem)
      return {
        line: row.line,
        ok: false as const,
        email: safeEmail,
        reason: emailProblem,
      };
    const trimmed = password.trim();
    if (trimmed.length < 8 || trimmed.length > 200)
      return {
        line: row.line,
        ok: false as const,
        email,
        reason: "Пароль приложения отсутствует или короче 8 символов",
      };
    if (/\s/.test(trimmed))
      return {
        line: row.line,
        ok: false as const,
        email,
        reason: "Пароль приложения не должен содержать пробелы",
      };
    return { line: row.line, ok: true as const, email, password: trimmed };
  });
}

export type RecipientRow =
  | { line: number; ok: true; email: string }
  | { line: number; ok: false; email: string | null; reason: string };

export function parseRecipients(
  text: string,
  format: "lines" | "csv"
): RecipientRow[] {
  let rows: ParsedLine[];
  if (format === "csv") {
    rows = parseCsv(text);
    const header = rows[0]?.fields.map((value) => value.trim().toLowerCase());
    if (!header || header[0] !== "email") {
      return [
        {
          line: 1,
          ok: false,
          email: null,
          reason: "Ожидается заголовок CSV: email",
        },
      ];
    }
    rows = rows.slice(1);
  } else {
    rows = parseLines(text, "\u0000").map((row) => ({
      line: row.line,
      fields: row.fields[0].split(/[;,\s]+/).filter(Boolean),
    }));
  }
  return rows.map((row) => {
    if (row.fields.filter((value) => value.trim()).length !== 1) {
      return {
        line: row.line,
        ok: false as const,
        email: null,
        reason: "Ожидается один адрес в строке",
      };
    }
    const email = normalizeEmail(row.fields[0]);
    if (!isValidEmail(email))
      return {
        line: row.line,
        ok: false as const,
        email: email.length <= 254 && email.includes("@") ? email : null,
        reason: "Некорректный адрес электронной почты",
      };
    return { line: row.line, ok: true as const, email };
  });
}
