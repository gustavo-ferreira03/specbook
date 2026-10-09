import "dotenv/config";
import path from "node:path";
import { defineConfig } from "drizzle-kit";

const storageRoot = process.env.SPECBOOK_STORAGE_DIR ?? path.join(process.cwd(), "storage");

export default defineConfig({
    schema: "./src/infra/db/schema.ts",
    out: "./drizzle",
    dialect: "sqlite",
    dbCredentials: {
        url: `file:${path.resolve(storageRoot, "specbook.db")}`,
    },
});
