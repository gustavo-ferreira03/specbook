import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { storageRoot } from "../paths";

export const parseEncryptionKey = function parseEncryptionKey(
  value: string | Buffer
): Buffer {
  if (Buffer.isBuffer(value) && value.length === 32) {
    return value;
  }
  const text = value.toString().trim();
  const key = (() => {
    if (/^[a-f0-9]{64}$/iu.test(text)) {
      return Buffer.from(text, "hex");
    }
    if (/^[A-Za-z0-9+/]{43}=$/u.test(text)) {
      return Buffer.from(text, "base64");
    }
    return null;
  })();
  if (!key || key.length !== 32) {
    throw new Error(
      "The encryption key must contain 32 bytes, encoded as hex or base64 (key files may also contain 32 raw bytes)."
    );
  }
  return key;
};

export const encryptionKeySource = function encryptionKeySource():
  | "environment"
  | "file"
  | "local" {
  if (process.env.SPECBOOK_ENCRYPTION_KEY) {
    return "environment";
  }
  if (process.env.SPECBOOK_ENCRYPTION_KEY_FILE) {
    return "file";
  }
  return "local";
};

export const loadEncryptionKey = function loadEncryptionKey(): Buffer {
  const configured = process.env.SPECBOOK_ENCRYPTION_KEY;
  const file = process.env.SPECBOOK_ENCRYPTION_KEY_FILE;
  if (configured && file) {
    throw new Error(
      "Set either SPECBOOK_ENCRYPTION_KEY or SPECBOOK_ENCRYPTION_KEY_FILE, not both."
    );
  }
  const source = configured ?? file ?? localKeyPath;
  if (cachedKey?.source === source) {
    return cachedKey.key;
  }
  let key: Buffer;
  if (configured) {
    key = parseEncryptionKey(configured);
  } else if (file) {
    key = parseEncryptionKey(fs.readFileSync(file));
  } else {
    try {
      key = parseEncryptionKey(fs.readFileSync(localKeyPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      key = crypto.randomBytes(32);
      fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
      try {
        fs.writeFileSync(localKeyPath, key, { mode: 0o600, flag: "wx" });
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw writeError;
        }
        key = parseEncryptionKey(fs.readFileSync(localKeyPath));
      }
    }
  }
  cachedKey = { source, key };
  return key;
};

export const keyFingerprint = function keyFingerprint(
  key = loadEncryptionKey()
): string {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
};

export const encryptWithKey = function encryptWithKey(
  value: string,
  key: Buffer
): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf-8"),
    cipher.final(),
  ]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ciphertext.toString("base64")}`;
};

export const decryptWithKey = function decryptWithKey(
  stored: string,
  key: Buffer
): string {
  const [version, iv, tag, ciphertext, extra] = stored.split(":");
  if (
    version !== "v1" ||
    !iv ||
    !tag ||
    ciphertext === undefined ||
    extra !== undefined
  ) {
    throw new Error("Unrecognized secret format");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf-8");
};

export const encryptSecret = function encryptSecret(value: string): string {
  return encryptWithKey(value, loadEncryptionKey());
};

export const decryptSecret = function decryptSecret(stored: string): string {
  try {
    return decryptWithKey(stored, loadEncryptionKey());
  } catch (error) {
    throw new Error(
      "Stored credentials could not be decrypted. Restore the matching encryption key before starting Specbook.",
      { cause: error }
    );
  }
};

export const clearEncryptionKeyCache =
  function clearEncryptionKeyCache(): void {
    cachedKey = null;
  };

export const localKeyPath = path.join(storageRoot, "encryption.key");
let cachedKey: { source: string; key: Buffer } | null = null;
