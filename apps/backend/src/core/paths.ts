import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

// src/core/paths.ts in development, dist/index.js once bundled: walk up to the
// directory that holds the backend package.json instead of assuming a depth.
function findBackendRoot(start: string): string {
    let current = start;
    while (!existsSync(path.join(current, "package.json"))) {
        const parent = path.dirname(current);
        if (parent === current) return path.resolve(start, "..", "..");
        current = parent;
    }
    return current;
}

export const backendRoot = findBackendRoot(moduleDir);
export const storageRoot = process.env.SPECBOOK_STORAGE_DIR ?? path.join(backendRoot, "storage");
export const runsDir = path.join(storageRoot, "runs");
export const runBatchesDir = path.join(runsDir, "batches");
export const reposDir = path.join(storageRoot, "repos");
export const bareReposDir = path.join(storageRoot, "git");
export const sessionsDir = path.join(storageRoot, "chat", "sessions");
export const piAuthPath = path.join(storageRoot, "pi-auth.json");
export const dbPath = path.join(storageRoot, "specbook.db");
