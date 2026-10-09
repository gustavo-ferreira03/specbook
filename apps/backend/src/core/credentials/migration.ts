import fs from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db, runBatch, type DbQuery } from "../../infra/db/client";
import { piAuthPath, storageRoot } from "../paths";
import { clearEncryptionKeyCache, decryptWithKey, encryptionKeySource, encryptWithKey, keyFingerprint, legacyKeyPath, loadEncryptionKey, localKeyPath, parseEncryptionKey } from "./crypto";
import { writeProtectedFile } from "./files";
import { encryptedColumns, transformSecretColumn } from "./locations";

const rotationPath = path.join(storageRoot, "key-rotation.json");
const rotationSchema = z.object({ from: z.string(), to: z.string(), previousKey: z.string(), nextKey: z.string() }).strict();

async function readOptional(file: string): Promise<string | null> {
    try { return await fs.readFile(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

async function readOptionalKey(file: string): Promise<Buffer | null> {
    try { return parseEncryptionKey(await fs.readFile(file)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

async function reencryptStoredSecrets(target: Buffer, fallbacks: Buffer[]): Promise<void> {
    const transform = (value: string): string => {
        try { decryptWithKey(value, target); return value; } catch {}
        for (const key of fallbacks) {
            try { return encryptWithKey(decryptWithKey(value, key), target); } catch {}
        }
        throw new Error("Stored credentials could not be decrypted. Restore the matching encryption key before starting Specbook.");
    };
    const queries: DbQuery[] = [];
    for (const field of encryptedColumns) {
        const columns = await db.all<{ name: string }>(sql.raw(`PRAGMA table_info(${field.table})`));
        if (!columns.some((column) => column.name === field.column)) continue;
        const idColumn = "id" in field ? field.id : "id";
        const rows = await db.all<{ id: string | number; value: string | null }>(sql.raw(`SELECT ${idColumn} AS id, ${field.column} AS value FROM ${field.table}`));
        for (const row of rows) {
            if (!row.value) continue;
            const next = transformSecretColumn(row.value, "json" in field ? field.json : undefined, transform);
            if (next !== row.value) queries.push(db.run(sql`UPDATE ${sql.raw(field.table)} SET ${sql.raw(field.column)} = ${next} WHERE ${sql.raw(idColumn)} = ${row.id}`));
        }
    }
    const auth = await readOptional(piAuthPath);
    let nextAuth: string | null = null;
    if (auth !== null) {
        if (auth.startsWith("v1:")) nextAuth = transform(auth);
        else {
            const parsed: unknown = JSON.parse(auth);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The saved model credentials file is invalid.");
            nextAuth = encryptWithKey(JSON.stringify(parsed), target);
        }
    }
    await runBatch(queries);
    if (nextAuth !== null && nextAuth !== auth) await writeProtectedFile(piAuthPath, nextAuth);
}

async function finishRotation(record: z.infer<typeof rotationSchema>, current: Buffer): Promise<void> {
    const fingerprint = keyFingerprint(current);
    const old = fingerprint === record.from ? current : parseEncryptionKey(decryptWithKey(record.previousKey, current));
    const next = fingerprint === record.to ? current : parseEncryptionKey(decryptWithKey(record.nextKey, current));
    if (keyFingerprint(old) !== record.from || keyFingerprint(next) !== record.to) throw new Error("Key rotation does not match the configured encryption key.");
    await reencryptStoredSecrets(next, [old]);
    if (encryptionKeySource() === "local") {
        await writeProtectedFile(localKeyPath, next);
        clearEncryptionKeyCache();
    } else if (fingerprint !== record.to) {
        throw new Error("Key rotation is complete. Configure the new SPECBOOK_ENCRYPTION_KEY or SPECBOOK_ENCRYPTION_KEY_FILE before restarting Specbook.");
    }
    await fs.rm(rotationPath, { force: true });
}

export async function migrateSecrets(): Promise<void> {
    const key = loadEncryptionKey();
    const pending = await readOptional(rotationPath);
    if (pending) await finishRotation(rotationSchema.parse(JSON.parse(pending)), key);
    const target = loadEncryptionKey();
    const old = await readOptionalKey(legacyKeyPath);
    const local = encryptionKeySource() !== "local" ? await readOptionalKey(localKeyPath) : null;
    await reencryptStoredSecrets(target, [old, local].filter((entry): entry is Buffer => entry !== null));
    await fs.rm(legacyKeyPath, { force: true });
    if (encryptionKeySource() !== "local") await fs.rm(localKeyPath, { force: true });
}

export async function rotateEncryptionKey(next: Buffer): Promise<{ fingerprint: string; requiresConfiguration: boolean }> {
    await migrateSecrets();
    const current = loadEncryptionKey();
    if (keyFingerprint(current) === keyFingerprint(next)) throw new Error("The new encryption key must differ from the current key.");
    const record = { from: keyFingerprint(current), to: keyFingerprint(next), previousKey: encryptWithKey(current.toString("base64"), next), nextKey: encryptWithKey(next.toString("base64"), current) };
    await writeProtectedFile(rotationPath, JSON.stringify(record));
    await reencryptStoredSecrets(next, [current]);
    const requiresConfiguration = encryptionKeySource() !== "local";
    if (!requiresConfiguration) {
        await writeProtectedFile(localKeyPath, next);
        clearEncryptionKeyCache();
        await fs.rm(rotationPath, { force: true });
    }
    return { fingerprint: record.to, requiresConfiguration };
}
