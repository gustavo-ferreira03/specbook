import fs from "node:fs/promises";
import path from "node:path";

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const storageIndex = args.indexOf("--storage");
    if (storageIndex >= 0) {
        if (!args[storageIndex + 1]) throw new Error("Provide a directory after --storage.");
        process.env.SPECBOOK_STORAGE_DIR = path.resolve(args[storageIndex + 1]);
        args.splice(storageIndex, 2);
    }
    const [command, value, keyFile] = args;
    if (!(command === "backup" && value && args.length === 2 || command === "restore" && value && args.length === 2
        || command === "rotate-key" && value === "--new-key-file" && keyFile && args.length === 3)) {
        throw new Error("Usage: specbook-ops backup <archive.tar.gz> | restore <archive.tar.gz> | rotate-key --new-key-file <key-file> [--storage <directory>]");
    }
    const { acquireStorageLock } = await import("./core/operations/lock");
    const release = await acquireStorageLock();
    try {
        if (command === "backup") {
            const { backupStorage } = await import("./core/operations/backup");
            await backupStorage(value);
            process.stdout.write(`Backup written to ${path.resolve(value)}. Keep the archive and any external encryption key private.\n`);
        } else if (command === "restore") {
            const { restoreStorage } = await import("./core/operations/backup");
            await restoreStorage(value);
            process.stdout.write("Backup verified and restored. Start Specbook with the matching encryption key.\n");
        } else {
            const { runMigrations } = await import("./infra/db/migrate");
            const { parseEncryptionKey } = await import("./core/credentials/crypto");
            const { rotateEncryptionKey } = await import("./core/credentials/migration");
            await runMigrations();
            const result = await rotateEncryptionKey(parseEncryptionKey(await fs.readFile(keyFile)));
            process.stdout.write(`Encryption key rotated (${result.fingerprint}). ${result.requiresConfiguration ? "Configure the new key before restarting Specbook." : "The local key file was updated; keep a new backup."}\n`);
        }
    } finally { await release(); }
}

await main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "The operation failed."}\n`);
    process.exitCode = 1;
});
