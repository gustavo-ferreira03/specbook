import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export const backendRoot = path.resolve(moduleDir, "..", "..");
export const storageRoot = process.env.SPECBOOK_STORAGE_DIR ?? path.join(backendRoot, "storage");
export const runsDir = path.join(storageRoot, "runs");
export const runBatchesDir = path.join(runsDir, "batches");
export const reposDir = path.join(storageRoot, "repos");
export const sessionsDir = path.join(storageRoot, "chat", "sessions");
export const piAuthPath = path.join(storageRoot, "pi-auth.json");
export const dbPath = path.join(storageRoot, "specbook.db");
