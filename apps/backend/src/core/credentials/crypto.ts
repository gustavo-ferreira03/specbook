import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { storageRoot } from "../paths";

export const localKeyPath = path.join(storageRoot, "encryption.key");
export const legacyKeyPath = path.join(storageRoot, "credentials.key");
let cachedKey: { source: string; key: Buffer } | null = null;

export function parseEncryptionKey(value: string | Buffer): Buffer {
    if (Buffer.isBuffer(value) && value.length === 32) return value;
    const text = value.toString().trim();
    const key = /^[a-f0-9]{64}$/i.test(text) ? Buffer.from(text, "hex")
        : /^[A-Za-z0-9+/]{43}=$/.test(text) ? Buffer.from(text, "base64") : null;
    if (!key || key.length !== 32) throw new Error("The encryption key must contain 32 bytes, encoded as hex or base64 (key files may also contain 32 raw bytes).");
    return key;
}

export function encryptionKeySource(): "environment" | "file" | "local" {
    return process.env.SPECBOOK_ENCRYPTION_KEY ? "environment" : process.env.SPECBOOK_ENCRYPTION_KEY_FILE ? "file" : "local";
}

export function loadEncryptionKey(): Buffer {
    const configured = process.env.SPECBOOK_ENCRYPTION_KEY;
    const file = process.env.SPECBOOK_ENCRYPTION_KEY_FILE;
    if (configured && file) throw new Error("Set either SPECBOOK_ENCRYPTION_KEY or SPECBOOK_ENCRYPTION_KEY_FILE, not both.");
    const source = configured ?? file ?? localKeyPath;
    if (cachedKey?.source === source) return cachedKey.key;
    let key: Buffer;
    if (configured) key = parseEncryptionKey(configured);
    else if (file) key = parseEncryptionKey(fs.readFileSync(file));
    else {
        try { key = parseEncryptionKey(fs.readFileSync(localKeyPath)); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            key = fs.existsSync(legacyKeyPath) ? parseEncryptionKey(fs.readFileSync(legacyKeyPath)) : crypto.randomBytes(32);
            fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
            try { fs.writeFileSync(localKeyPath, key, { mode: 0o600, flag: "wx" }); }
            catch (writeError) {
                if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
                key = parseEncryptionKey(fs.readFileSync(localKeyPath));
            }
        }
    }
    cachedKey = { source, key };
    return key;
}

export function keyFingerprint(key = loadEncryptionKey()): string {
    return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function encryptWithKey(value: string, key: Buffer): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptWithKey(stored: string, key: Buffer): string {
    const [version, iv, tag, ciphertext, extra] = stored.split(":");
    if (version !== "v1" || !iv || !tag || ciphertext === undefined || extra !== undefined) throw new Error("Unrecognized secret format");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}

export function encryptSecret(value: string): string {
    return encryptWithKey(value, loadEncryptionKey());
}

export function decryptSecret(stored: string): string {
    try { return decryptWithKey(stored, loadEncryptionKey()); }
    catch (cause) { throw new Error("Stored credentials could not be decrypted. Restore the matching encryption key before starting Specbook.", { cause }); }
}

export function clearEncryptionKeyCache(): void { cachedKey = null; }
