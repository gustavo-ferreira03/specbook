import "dotenv/config";
import path from "node:path";
import { defineConfig } from "drizzle-kit";

// Mirrors core/paths.ts (storageRoot / dbPath) so drizzle-kit and the server
// always open the same database. drizzle-kit runs from apps/backend.
const storageRoot = process.env.SPECBOOK_STORAGE_DIR ?? path.join(process.cwd(), "storage");

export default defineConfig({
    schema: "./src/infra/db/schema.ts",
    out: "./drizzle",
    dialect: "sqlite",
    dbCredentials: {
        url: `file:${path.resolve(storageRoot, "specbook.db")}`,
    },
});
