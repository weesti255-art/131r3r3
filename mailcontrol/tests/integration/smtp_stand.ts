import net from "node:net";

export type StandRule =
  | { at: "auth"; code: number; text: string }
  | { at: "mail"; code: number; text: string }
  | { at: "rcpt"; code: number; text: string }
  | { at: "data"; code: number; text: string }
  | { at: "message"; code: number; text: string }
  | { at: "message"; drop: true };

/**
 * Minimal controlled SMTP server: EHLO, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA.
 * Behaviour is keyed by the authenticated user or the recipient address.
 */
export class SmtpStand {
  private server = net.createServer((socket) => this.serve(socket));
  rulesByUser = new Map<string, StandRule>();
  rulesByRecipient = new Map<string, StandRule>();
  received: Array<{ from: string; to: string; data: string; user: string }> =
    [];
  passwords = new Map<string, string>();
  port = 0;

  async start() {
    await new Promise<void>((resolve) =>
      this.server.listen(0, "127.0.0.1", resolve)
    );
    this.port = (this.server.address() as net.AddressInfo).port;
  }

  async stop() {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private serve(socket: net.Socket) {
    let buffer = "";
    let user = "";
    let from = "";
    let to = "";
    let inData = false;
    let data = "";
    let loginStage: "user" | "pass" | null = null;
    const write = (line: string) => socket.write(line + "\r\n");
    const fail = (rule: StandRule | undefined, stage: StandRule["at"]) => {
      if (!rule || rule.at !== stage) return false;
      if ("drop" in rule) {
        socket.destroy();
        return true;
      }
      write(`${rule.code} ${rule.text}`);
      return true;
    };
    write("220 stand.local ESMTP MailControl test stand");
    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            const rule =
              this.rulesByRecipient.get(to) ?? this.rulesByUser.get(user);
            if (fail(rule, "message")) continue;
            this.received.push({ from, to, data, user });
            write("250 2.0.0 Ok: queued as STAND");
          } else data += line.replace(/^\.\./, ".") + "\r\n";
          continue;
        }
        if (loginStage === "user") {
          user = Buffer.from(line, "base64").toString("utf8");
          loginStage = "pass";
          write("334 UGFzc3dvcmQ6");
          continue;
        }
        if (loginStage === "pass") {
          loginStage = null;
          this.authenticate(
            user,
            Buffer.from(line, "base64").toString("utf8"),
            write,
            fail
          );
          continue;
        }
        const command = line.split(" ")[0].toUpperCase();
        if (command === "EHLO")
          write("250-stand.local\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME");
        else if (command === "AUTH" && /PLAIN/i.test(line)) {
          const token = Buffer.from(
            line.split(" ")[2] ?? "",
            "base64"
          ).toString("utf8");
          const [, name, password] = token.split("\0");
          user = name ?? "";
          this.authenticate(user, password ?? "", write, fail);
        } else if (command === "AUTH" && /LOGIN/i.test(line)) {
          loginStage = "user";
          write("334 VXNlcm5hbWU6");
        } else if (command === "MAIL") {
          from = line.match(/<([^>]*)>/)?.[1] ?? "";
          if (fail(this.rulesByUser.get(user), "mail")) continue;
          write("250 2.1.0 Ok");
        } else if (command === "RCPT") {
          to = line.match(/<([^>]*)>/)?.[1] ?? "";
          if (fail(this.rulesByRecipient.get(to), "rcpt")) continue;
          write("250 2.1.5 Ok");
        } else if (command === "DATA") {
          if (fail(this.rulesByRecipient.get(to), "data")) continue;
          inData = true;
          data = "";
          write("354 End data with <CR><LF>.<CR><LF>");
        } else if (command === "QUIT") {
          write("221 2.0.0 Bye");
          socket.end();
        } else if (command === "RSET" || command === "NOOP") write("250 Ok");
        else write("502 5.5.2 Command not implemented");
      }
    });
  }

  private authenticate(
    user: string,
    password: string,
    write: (line: string) => void,
    fail: (rule: StandRule | undefined, stage: StandRule["at"]) => boolean
  ) {
    if (fail(this.rulesByUser.get(user), "auth")) return;
    const expected = this.passwords.get(user);
    if (expected !== undefined && expected !== password) {
      write(
        "535 5.7.8 Error: authentication failed: Invalid user or password!"
      );
      return;
    }
    write("235 2.7.0 Authentication successful");
  }
}
