import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createClient } from "@libsql/client";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { decryptWithKey, keyFingerprint, parseEncryptionKey } from "../credentials/crypto";
import { encryptedColumns, transformSecretColumn } from "../credentials/locations";
import { writeProtectedFile } from "../credentials/files";
import { storageRoot } from "../paths";
import { isInside } from "../repo/safe-fs";

const exec = promisify(execFile);
const manifestName = "backup-manifest.json";
const backupRoots = new Set(["specbook.db", "repos", "git", "runs", "metrics", "chat", "pi-auth.json", "encryption.key", "credentials.key", manifestName]);
const manifestSchema = z.object({
    version: z.literal(1), createdAt: z.string(), keyFingerprint: z.string().nullable(),
    files: z.array(z.object({ path: z.string(), sha256: z.string(), size: z.number().int().nonnegative() })),
}).strict();


async function listFiles(root: string, prefix = ""): Promise<string[]> {
    const files: string[] = [];
    for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (/[\r\n\\]/.test(name)) throw new Error("Backup paths cannot contain newlines or backslashes.");
        if (entry.isDirectory()) files.push(...await listFiles(root, name));
        else if (entry.isFile()) files.push(name);
        else throw new Error("Backups cannot contain symbolic links or special files.");
    }
    return files.sort();
}

async function fileDigest(file: string): Promise<{ size: number; sha256: string }> {
    const hash = crypto.createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(file)) { size += chunk.length; hash.update(chunk); }
    return { size, sha256: hash.digest("hex") };
}

async function keyFor(root: string): Promise<Buffer | null> {
    if (process.env.SPECBOOK_ENCRYPTION_KEY && process.env.SPECBOOK_ENCRYPTION_KEY_FILE) throw new Error("Set only one encryption key source.");
    if (process.env.SPECBOOK_ENCRYPTION_KEY) return parseEncryptionKey(process.env.SPECBOOK_ENCRYPTION_KEY);
    if (process.env.SPECBOOK_ENCRYPTION_KEY_FILE) return parseEncryptionKey(await fs.readFile(process.env.SPECBOOK_ENCRYPTION_KEY_FILE));
    for (const name of ["encryption.key", "credentials.key"]) {
        try { return parseEncryptionKey(await fs.readFile(path.join(root, name))); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return null;
}

async function validateStorage(root: string): Promise<void> {
    const database = await fs.lstat(path.join(root, "specbook.db"));
    if (!database.isFile() || database.size === 0) throw new Error("The backup does not contain a Specbook database.");
    const client = createClient({ url: `file:${path.join(root, "specbook.db")}` });
    try {
        if (!(await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'")).rows.length) throw new Error("The backup does not contain a Specbook database.");
        const integrity = await client.execute("PRAGMA integrity_check");
        if (integrity.rows[0]?.integrity_check !== "ok") throw new Error("The backup database failed its integrity check.");
        if ((await client.execute("PRAGMA foreign_key_check")).rows.length) throw new Error("The backup database contains broken references.");
        const key = await keyFor(root);
        const check = (value: string): string => {
            if (!key) throw new Error("This backup needs its external encryption key. Set SPECBOOK_ENCRYPTION_KEY or SPECBOOK_ENCRYPTION_KEY_FILE.");
            try { decryptWithKey(value, key); }
            catch { throw new Error("The configured encryption key does not match this backup."); }
            return value;
        };
        for (const column of encryptedColumns) {
            const info = await client.execute(`PRAGMA table_info(${column.table})`);
            if (!info.rows.some((row) => row.name === column.column)) continue;
            const rows = await client.execute(`SELECT ${column.column} AS value FROM ${column.table}`);
            for (const row of rows.rows) if (typeof row.value === "string" && row.value) transformSecretColumn(row.value, "json" in column ? column.json : undefined, check);
        }
        const auth = await fs.readFile(path.join(root, "pi-auth.json"), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
        if (auth?.startsWith("v1:")) check(auth);
        else if (auth) JSON.parse(auth);
    } finally { client.close(); }
}

export async function backupStorage(archivePath: string): Promise<void> {
    const archive = path.resolve(archivePath);
    if (isInside(path.resolve(storageRoot), archive, { allowRoot: true })) throw new Error("Write backups outside the Specbook storage directory.");
    const staging = await fs.mkdtemp(path.join(os.tmpdir(), "specbook-backup-"));
    const output = `${archive}.${crypto.randomUUID()}.tmp`;
    try {
        const { db } = await import("../../infra/db/client");
        await db.run(sql`VACUUM INTO ${path.join(staging, "specbook.db")}`);
        for (const name of ["repos", "git", "runs", "metrics", "chat/sessions", "pi-auth.json", "encryption.key", "credentials.key"]) {
            const source = path.join(storageRoot, name);
            const stat = await fs.lstat(source).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
            if (!stat) continue;
            if (stat.isSymbolicLink()) throw new Error("Backups cannot contain symbolic links.");
            await fs.mkdir(path.dirname(path.join(staging, name)), { recursive: true });
            await fs.cp(source, path.join(staging, name), { recursive: true, preserveTimestamps: true });
        }
        await validateStorage(staging);
        const key = await keyFor(staging);
        const files = [];
        for (const file of await listFiles(staging)) files.push({ path: file, ...await fileDigest(path.join(staging, file)) });
        await writeProtectedFile(path.join(staging, manifestName), JSON.stringify({ version: 1, createdAt: new Date().toISOString(), keyFingerprint: key ? keyFingerprint(key) : null, files }));
        await fs.mkdir(path.dirname(archive), { recursive: true });
        await fs.writeFile(output, "", { flag: "wx", mode: 0o600 });
        await exec("tar", ["-czf", output, "-C", staging, "."], { maxBuffer: 4 * 1024 * 1024 });
        await fs.chmod(output, 0o600);
        await fs.link(output, archive);
    } finally {
        await fs.rm(output, { force: true });
        await fs.rm(staging, { recursive: true, force: true });
    }
}

export async function restoreStorage(archivePath: string): Promise<void> {
    const archive = path.resolve(archivePath);
    const existing = (await fs.readdir(storageRoot)).filter((name) => name !== ".operations.lock");
    if (existing.length) throw new Error("Restore requires an empty storage directory. Existing data was not changed.");
    const staging = await fs.mkdtemp(path.join(os.tmpdir(), "specbook-restore-"));
    try {
        const { stdout: names } = await exec("tar", ["-tzf", archive], { maxBuffer: 64 * 1024 * 1024 });
        for (const name of names.split("\n").filter(Boolean)) {
            if (path.isAbsolute(name) || name.split("/").includes("..") || /[\r\\]/.test(name)) throw new Error("The backup contains an unsafe path.");
            const normalized = name.replace(/^(\.\/)+/, "").replace(/\/$/, "");
            if (normalized && (!backupRoots.has(normalized.split("/")[0]) || normalized.startsWith("chat/") && !/^chat\/sessions(?:\/|$)/.test(normalized))) throw new Error("The backup contains an unsupported storage path.");
        }
        const { stdout: listing } = await exec("tar", ["-tvzf", archive], { maxBuffer: 64 * 1024 * 1024 });
        if (listing.split("\n").some((line) => line && !/^[d-]/.test(line))) throw new Error("The backup contains links or special files.");
        await exec("tar", ["--extract", "--gzip", "--file", archive, "--directory", staging, "--no-same-owner", "--no-same-permissions", "--keep-old-files"], { maxBuffer: 4 * 1024 * 1024 });
        const manifest = manifestSchema.parse(JSON.parse(await fs.readFile(path.join(staging, manifestName), "utf8")));
        const files = (await listFiles(staging)).filter((file) => file !== manifestName);
        if (files.length !== manifest.files.length || new Set(manifest.files.map((file) => file.path)).size !== files.length) throw new Error("Backup contents do not match the manifest.");
        for (const file of manifest.files) {
            if (!files.includes(file.path) || !isInside(staging, path.resolve(staging, file.path), { allowRoot: true })) throw new Error("The backup manifest contains an unsafe path.");
            const digest = await fileDigest(path.join(staging, file.path));
            if (digest.size !== file.size || digest.sha256 !== file.sha256) throw new Error("Backup checksum verification failed.");
        }
        const key = await keyFor(staging);
        if (manifest.keyFingerprint && (!key || keyFingerprint(key) !== manifest.keyFingerprint)) throw new Error("This backup needs its matching encryption key.");
        await validateStorage(staging);
        await fs.rm(path.join(staging, manifestName));
        const prepared = await fs.mkdtemp(path.join(storageRoot, ".restore-"));
        const copied: string[] = [];
        try {
            for (const entry of await fs.readdir(staging)) {
                await fs.cp(path.join(staging, entry), path.join(prepared, entry), { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
                if (await fs.lstat(path.join(storageRoot, entry)).then(() => true, (error: NodeJS.ErrnoException) => {
                    if (error.code === "ENOENT") return false;
                    throw error;
                })) throw new Error("The restore destination changed. Existing data was not replaced.");
                await fs.rename(path.join(prepared, entry), path.join(storageRoot, entry));
                copied.push(entry);
            }
        } catch (error) {
            for (const entry of copied) await fs.rm(path.join(storageRoot, entry), { recursive: true, force: true });
            throw error;
        } finally { await fs.rm(prepared, { recursive: true, force: true }); }
        for (const file of ["encryption.key", "credentials.key", "pi-auth.json"]) await fs.chmod(path.join(storageRoot, file), 0o600).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
