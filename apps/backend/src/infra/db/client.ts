import fs from "node:fs";
import { createClient } from "@libsql/client";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/libsql";
import { dbPath, storageRoot } from "../../core/paths";
import * as schema from "./schema";

fs.mkdirSync(storageRoot, { recursive: true });

const client = createClient({ url: `file:${dbPath}`, timeout: 5000 });

export async function initializeDatabase(): Promise<void> {
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA busy_timeout = 5000");
    await client.execute("PRAGMA foreign_keys = ON");
}

export const db = drizzle(client, { schema });

export type DbQuery = BatchItem<"sqlite">;

export async function runBatch(queries: DbQuery[]): Promise<void> {
    if (queries.length === 0) return;
    await db.batch(queries as [DbQuery, ...DbQuery[]]);
}
