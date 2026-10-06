import { constants } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../infra/db/client";
import { storageRoot } from "./paths";

const require = createRequire(import.meta.url);

interface SystemCheck {
    id: string;
    label: string;
    ok: boolean;
    message: string;
    nextStep?: string;
}

async function check(id: string, label: string, verify: () => Promise<void>, nextStep: string): Promise<SystemCheck> {
    try {
        await verify();
        return { id, label, ok: true, message: "Available" };
    } catch {
        return { id, label, ok: false, message: "Unavailable", nextStep };
    }
}

async function executable(name: string): Promise<void> {
    for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
        if (await fs.access(path.join(dir, name), constants.X_OK).then(() => true, () => false)) return;
    }
    throw new Error(`${name} is unavailable`);
}

async function chromium(mcp: boolean): Promise<void> {
    const loader = mcp ? createRequire(require.resolve("@playwright/mcp/package.json")) : require;
    const { chromium: browser } = loader(mcp ? "playwright" : "playwright-core") as { chromium: { executablePath: () => string } };
    await fs.access(browser.executablePath(), constants.X_OK);
}

export async function systemStatus() {
    const checks = await Promise.all([
        check("database", "Database", async () => { await db.get(sql`select 1`); }, "Restart Specbook and check the database volume permissions."),
        check("storage", "Storage", async () => {
            const directory = await fs.mkdtemp(path.join(storageRoot, ".ready-"));
            try {
                const file = path.join(directory, "check");
                await fs.writeFile(file, "ready");
                if (await fs.readFile(file, "utf8") !== "ready") throw new Error("Storage read failed");
            } finally { await fs.rm(directory, { recursive: true, force: true }); }
        }, "Give Specbook read and write access to its data volume, and check that the disk has free space."),
        check("chromium", "Test browser", () => chromium(false), "Run pnpm --filter backend browser:install, or recreate the container with the current Specbook image."),
        check("mcp_chromium", "Agent browser", () => chromium(true), "Run pnpm --filter backend browser:install to install both required Chromium builds."),
        check("xvfb", "Browser display", () => executable("Xvfb"), "Install xvfb on the server, or use the Specbook container image."),
        check("x11vnc", "Live browser viewer", () => executable("x11vnc"), "Install x11vnc on the server, or use the Specbook container image."),
    ]);
    return { ok: checks.every((result) => result.ok), checkedAt: new Date().toISOString(), checks };
}
