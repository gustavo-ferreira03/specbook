import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import { runNodeCli } from "@specbook/runtime/process";
const require = createRequire(import.meta.url);
let installing: Promise<void> | undefined;

export async function ensureChromium(): Promise<void> {
    if (existsSync(chromium.executablePath())) return;
    installing ??= (async () => {
        process.stderr.write("Downloading Chromium for Specbook…\n");
        const result = await runNodeCli(require.resolve("@playwright/test/cli"), ["install", "chromium"], { cwd: process.cwd(), timeoutMs: 300_000 });
        if (result.code !== 0 || result.timedOut) throw new Error("Chromium installation failed. Run npx playwright install chromium and check platform dependencies.");
    })().finally(() => { installing = undefined; });
    await installing;
}
