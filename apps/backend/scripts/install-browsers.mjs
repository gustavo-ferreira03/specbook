import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const mcpRequire = createRequire(require.resolve("@playwright/mcp/package.json"));
const clis = [
    path.join(path.dirname(mcpRequire.resolve("playwright/package.json")), "cli.js"),
    require.resolve("@playwright/test/cli"),
];
const withDeps = process.argv.includes("--with-deps");

for (const cli of clis) {
    const commands = withDeps ? [["install-deps", "chromium"], ["install", "chromium"]] : [["install", "chromium"]];
    for (const args of commands) {
        const result = spawnSync(process.execPath, [cli, ...args], { stdio: "inherit" });
        if (result.error) throw result.error;
        if (result.status !== 0) process.exit(result.status ?? 1);
    }
}
