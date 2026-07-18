import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
    schema: "./src/infra/db/schema.ts",
    out: "./drizzle",
    dialect: "sqlite",
    dbCredentials: {
        url: "file:storage/specbook.db",
    },
});
