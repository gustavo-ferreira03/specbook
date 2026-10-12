import fs from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { backendRoot } from "../../../core/paths";
import { access } from "../access";

export function createCliRouter(packageFile = process.env.SPECBOOK_CLI_PACKAGE_FILE ?? path.join(backendRoot, "dist", "specbook.tgz")): Hono {
    const router = new Hono();
    router.get("/cli/specbook.tgz", access("public"), async (c) => {
        c.header("Cache-Control", "no-cache");
        c.header("X-Content-Type-Options", "nosniff");
        try {
            const data = await fs.readFile(packageFile);
            return c.body(new Uint8Array(data), 200, {
                "Content-Type": "application/gzip",
                "Content-Disposition": 'attachment; filename="specbook.tgz"',
            });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            return c.json({ error: "CLI package is not built. From the repository root, run: pnpm --filter @specbook/runtime build && mkdir -p apps/backend/dist && pnpm --dir apps/cli pack --out ../backend/dist/specbook.tgz" }, 404);
        }
    });
    return router;
}
