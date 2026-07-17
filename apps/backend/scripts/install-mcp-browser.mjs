import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const mcpRequire = createRequire(require.resolve("@playwright/mcp/package.json"));
const playwrightRoot = path.dirname(mcpRequire.resolve("playwright/package.json"));
const playwrightCli = path.join(playwrightRoot, "cli.js");
const commands = process.argv.includes("--with-deps")
    ? [["install-deps", "chromium"], ["install", "chromium"]]
    : [["install", "chromium"]];

for (const args of commands) {
    const result = spawnSync(process.execPath, [playwrightCli, ...args], { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}
