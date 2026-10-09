import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cleanup = new Set<string>();
process.once("exit", () => {
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

function removeOnExit(dir: string): void {
    cleanup.add(dir);
}

export function useTempStorage(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specbook-test-"));
    process.env.SPECBOOK_STORAGE_DIR = dir;
    process.env.LOG_LEVEL ??= "silent";
    removeOnExit(dir);
    return dir;
}

export function tempDir(prefix = "specbook-test-"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    removeOnExit(dir);
    return dir;
}

export const HUMAN_SPEC = { preconditions: [], steps: ["Abrir a página"], expectedResult: "Página exibida", postconditions: [] };

export const VALID_SPEC = [
    'import { test, expect } from "specbook";',
    "",
    'test("Abrir a aplicação", async ({ page, step }) => {',
    '    await step("Abrir a página", async () => {',
    '        await page.goto("/");',
    '        await expect(page.getByRole("heading")).toBeVisible();',
    "    });",
    "});",
    "",
].join("\n");
