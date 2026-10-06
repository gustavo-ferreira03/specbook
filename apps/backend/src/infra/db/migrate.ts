import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/libsql/migrator";
import { db, initializeDatabase } from "./client";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

// src/infra/db/migrate.ts in development (tsx) and dist/index.js once bundled.
function migrationsFolder(): string {
    const candidates = [
        process.env.SPECBOOK_MIGRATIONS_DIR,
        path.resolve(moduleDir, "..", "..", "..", "drizzle"),
        path.resolve(moduleDir, "..", "drizzle"),
        path.resolve(moduleDir, "drizzle"),
    ].filter((candidate): candidate is string => Boolean(candidate));
    const found = candidates.find((candidate) => fs.existsSync(path.join(candidate, "meta", "_journal.json")));
    if (!found) throw new Error(`Drizzle migrations folder not found (looked in ${candidates.join(", ")})`);
    return found;
}

export async function runMigrations(): Promise<void> {
    await initializeDatabase();
    await migrate(db, { migrationsFolder: migrationsFolder() });
}
