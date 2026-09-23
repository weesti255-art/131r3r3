import net from "node:net";
import tls from "node:tls";
import { randomBytes } from "node:crypto";
import type { OutgoingMessage } from "./types.js";

export type SmtpStage =
  | "connect"
  | "greeting"
  | "ehlo"
  | "auth"
  | "mail"
  | "rcpt"
  | "data"
  /** Final terminator already sent: a lost answer here is an unknown outcome. */
  | "message"
  | "quit";

export interface SmtpReply {
  code: number;
  text: string;
}

export class SmtpError extends Error {
  constructor(
    public readonly stage: SmtpStage,
    message: string,
    public readonly reply: SmtpReply | null = null,
    public readonly cause: Error | null = null
  ) {
    super(message);
  }
}

export interface SmtpClientOptions {
  host: string;
  port: number;
  secure: boolean;
  servername?: string;
  ca?: string;
  timeoutMs: number;
}

class Connection {
  private socket!: net.Socket;
  private buffer = "";
  private pendingLines: string[] = [];
  private ready: SmtpReply[] = [];
  private waiters: Array<{
    resolve: (reply: SmtpReply) => void;
    reject: (error: Error) => void;
  }> = [];
  private closed: Error | null = null;
  stage: SmtpStage = "connect";

  constructor(private readonly options: SmtpClientOptions) {}

  async open() {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(this.wrap(error));
      const connectOptions = {
        host: this.options.host,
        port: this.options.port,
        servername: this.options.servername ?? this.options.host,
        ca: this.options.ca ? [this.options.ca] : undefined,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2" as const,
      };
      this.socket = this.options.secure
        ? tls.connect(connectOptions, resolve)
        : net.connect(
            { host: this.options.host, port: this.options.port },
            resolve
          );
      this.socket.setEncoding("utf8");
      this.socket.setTimeout(this.options.timeoutMs);
      this.socket.once("error", onError);
      this.socket.on("data", (chunk: string) => this.onData(chunk));
      this.socket.on("timeout", () => this.fail(new Error("SMTP timeout")));
      this.socket.on("error", (error) => this.fail(error));
      this.socket.on("close", () =>
        this.fail(new Error("SMTP connection closed"))
      );
    });
  }

  private wrap(error: Error) {
    return new SmtpError(this.stage, error.message, null, error);
  }

  private fail(error: Error) {
    if (this.closed) return;
    this.closed = error;
    const pending = this.waiters;
    this.waiters = [];
    for (const waiter of pending) waiter.reject(this.wrap(error));
    this.socket.destroy();
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\r\n")) !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      if (!/^\d{3}([ -]|$)/.test(line)) {
        this.fail(new Error(`Invalid SMTP reply: ${line.slice(0, 80)}`));
        return;
      }
      this.pendingLines.push(line.slice(4));
      if (line[3] === "-") continue;
      const reply = {
        code: Number(line.slice(0, 3)),
        text: this.pendingLines.join("\n"),
      };
      this.pendingLines = [];
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(reply);
      else this.ready.push(reply);
    }
  }

  read(): Promise<SmtpReply> {
    const queued = this.ready.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.reject(this.wrap(this.closed));
    return new Promise((resolve, reject) =>
      this.waiters.push({ resolve, reject })
    );
  }

  async command(line: string, stage: SmtpStage): Promise<SmtpReply> {
    this.stage = stage;
    if (this.closed) throw this.wrap(this.closed);
    this.socket.write(line + "\r\n");
    return this.read();
  }

  async write(payload: string) {
    if (this.closed) throw this.wrap(this.closed);
    await new Promise<void>((resolve, reject) =>
      this.socket.write(payload, (error) =>
        error ? reject(this.wrap(error)) : resolve()
      )
    );
  }

  end() {
    this.socket.end();
    this.socket.destroy();
  }
}

function expect(reply: SmtpReply, stage: SmtpStage, ok: number[]) {
  if (!ok.includes(reply.code))
    throw new SmtpError(stage, `${reply.code} ${reply.text}`, reply);
  return reply;
}

function encodeWord(value: string) {
  return /^[\x20-\x7e]*$/.test(value) && !/[=?"]/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export function buildMime(message: OutgoingMessage, domain: string) {
  const body = Buffer.from(message.text.replace(/\r?\n/g, "\r\n"), "utf8")
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n");
  const from = message.from.name
    ? `${encodeWord(message.from.name)} <${message.from.email}>`
    : message.from.email;
  return [
    `From: ${from}`,
    `To: <${message.to}>`,
    `Subject: ${encodeWord(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString("hex")}@${domain}>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join("\r\n");
}

async function login(
  connection: Connection,
  user: string,
  password: string,
  hostname: string
) {
  connection.stage = "greeting";
  expect(await connection.read(), "greeting", [220]);
  const ehlo = expect(
    await connection.command(`EHLO ${hostname}`, "ehlo"),
    "ehlo",
    [250]
  );
  const methods =
    ehlo.text
      .split("\n")
      .find((line) => /^AUTH\b/i.test(line))
      ?.toUpperCase()
      .split(/\s+/)
      .slice(1) ?? [];
  if (methods.includes("PLAIN")) {
    const token = Buffer.from(`\0${user}\0${password}`, "utf8").toString(
      "base64"
    );
    expect(await connection.command(`AUTH PLAIN ${token}`, "auth"), "auth", [
      235,
    ]);
  } else if (methods.includes("LOGIN") || methods.length === 0) {
    expect(await connection.command("AUTH LOGIN", "auth"), "auth", [334]);
    expect(
      await connection.command(
        Buffer.from(user, "utf8").toString("base64"),
        "auth"
      ),
      "auth",
      [334]
    );
    expect(
      await connection.command(
        Buffer.from(password, "utf8").toString("base64"),
        "auth"
      ),
      "auth",
      [235]
    );
  } else {
    throw new SmtpError(
      "auth",
      `Unsupported AUTH methods: ${methods.join(" ")}`
    );
  }
}

export async function smtpCheck(
  options: SmtpClientOptions,
  user: string,
  password: string
): Promise<SmtpReply> {
  const connection = new Connection(options);
  try {
    await connection.open();
    await login(connection, user, password, "mailcontrol.local");
    const bye = await connection.command("QUIT", "quit").catch(() => null);
    return bye ?? { code: 221, text: "closed" };
  } finally {
    connection.end();
  }
}

export async function smtpSend(
  options: SmtpClientOptions,
  user: string,
  password: string,
  message: OutgoingMessage
): Promise<SmtpReply> {
  const connection = new Connection(options);
  try {
    await connection.open();
    await login(connection, user, password, "mailcontrol.local");
    expect(
      await connection.command(`MAIL FROM:<${message.from.email}>`, "mail"),
      "mail",
      [250]
    );
    expect(
      await connection.command(`RCPT TO:<${message.to}>`, "rcpt"),
      "rcpt",
      [250, 251]
    );
    expect(await connection.command("DATA", "data"), "data", [354]);
    const mime = buildMime(message, message.from.email.split("@")[1]);
    await connection.write(mime.replace(/\r\n\./g, "\r\n..") + "\r\n");
    // From here on the letter may already be accepted even if the answer is lost.
    const accepted = await connection.command(".", "message");
    expect(accepted, "message", [250]);
    await connection.command("QUIT", "quit").catch(() => null);
    return accepted;
  } finally {
    connection.end();
  }
}
