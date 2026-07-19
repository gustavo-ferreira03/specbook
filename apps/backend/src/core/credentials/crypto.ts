import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { storageRoot } from "../paths";

const keyPath = path.join(storageRoot, "credentials.key");
let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
    if (cachedKey) return cachedKey;
    let key: Buffer;
    try {
        key = fs.readFileSync(keyPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        fs.mkdirSync(storageRoot, { recursive: true });
        key = crypto.randomBytes(32);
        fs.writeFileSync(keyPath, key, { mode: 0o600 });
    }
    if (key.length !== 32) throw new Error("credentials.key must contain exactly 32 bytes");
    cachedKey = key;
    return key;
}

export function encryptSecret(value: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", loadKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptSecret(stored: string): string {
    const [version, iv, tag, ciphertext] = stored.split(":");
    if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Unrecognized secret format");
    const decipher = crypto.createDecipheriv("aes-256-gcm", loadKey(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}
