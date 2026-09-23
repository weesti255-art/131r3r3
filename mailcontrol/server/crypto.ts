import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PREFIX = "enc:v1";

export interface KeyStore {
  /** Creates the key file on first use; never returns the key over the API. */
  encrypt(plain: string): Promise<{ ciphertext: string; keyId: string }>;
  decrypt(ciphertext: string, keyId: string): Promise<string>;
  keyId(): Promise<string>;
}

export function keyFilePath(dataDir: string) {
  return path.join(dataDir, "mailcontrol.key");
}

function fingerprint(key: Buffer) {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function createKeyStore(dataDir: string): KeyStore {
  let loaded: { key: Buffer; id: string } | null = null;
  const file = keyFilePath(dataDir);

  async function load() {
    if (loaded) return loaded;
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      const fresh = randomBytes(32).toString("hex");
      try {
        await writeFile(file, fresh + "\n", { mode: 0o600, flag: "wx" });
      } catch (writeError) {
        // Another process created it first; fall through and read that one.
        if ((writeError as NodeJS.ErrnoException).code !== "EEXIST")
          throw writeError;
      }
      raw = await readFile(file, "utf8");
    }
    const key = Buffer.from(raw.trim(), "hex");
    if (key.length !== 32)
      throw new Error("The encryption key file is damaged.");
    loaded = { key, id: fingerprint(key) };
    return loaded;
  }

  return {
    async keyId() {
      return (await load()).id;
    },
    async encrypt(plain) {
      const { key, id } = await load();
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([
        cipher.update(plain, "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return {
        keyId: id,
        ciphertext: [
          PREFIX,
          iv.toString("base64"),
          tag.toString("base64"),
          body.toString("base64"),
        ].join(":"),
      };
    },
    async decrypt(ciphertext, keyId) {
      const { key, id } = await load();
      if (keyId !== id)
        throw new Error(
          "The stored password was encrypted with a different key file."
        );
      const parts = ciphertext.split(":");
      if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== PREFIX)
        throw new Error("Unsupported ciphertext format.");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(parts[2], "base64")
      );
      decipher.setAuthTag(Buffer.from(parts[3], "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(parts[4], "base64")),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}
