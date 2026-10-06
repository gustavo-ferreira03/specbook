import fs from "node:fs";
import { createClient } from "@libsql/client";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/libsql";
import { dbPath, storageRoot } from "../../core/paths";
import * as schema from "./schema";

fs.mkdirSync(storageRoot, { recursive: true });

// `timeout` is SQLite's busy timeout in milliseconds. libsql applies it to every
// connection it opens, including the fresh one it creates after each interactive
// transaction, so it is set here rather than with a per-connection PRAGMA.
const client = createClient({ url: `file:${dbPath}`, timeout: 5000 });

export async function initializeDatabase(): Promise<void> {
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA busy_timeout = 5000");
    // libsql already enables foreign keys on every connection; keep it explicit.
    await client.execute("PRAGMA foreign_keys = ON");
}

export const db = drizzle(client, { schema });

export type DbQuery = BatchItem<"sqlite">;

/**
 * Runs the queries atomically in a single SQLite transaction. The statements
 * execute back to back without yielding to the event loop, so unlike an
 * interactive `db.transaction` no other request can queue a conflicting write
 * on a second connection while the transaction is open.
 */
export async function runBatch(queries: DbQuery[]): Promise<void> {
    if (queries.length === 0) return;
    await db.batch(queries as [DbQuery, ...DbQuery[]]);
}
