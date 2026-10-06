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

/**
 * Points the backend at a fresh temporary storage directory. Must run before any
 * app module is imported: core/paths.ts reads SPECBOOK_STORAGE_DIR at import time
 * and the DB client is a singleton opened on import. Test files therefore import
 * app modules dynamically, after calling this. node --test runs each file in its
 * own process, so every file gets its own storage and DB.
 */
export function useTempStorage(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specbook-test-"));
    process.env.SPECBOOK_STORAGE_DIR = dir;
    process.env.LOG_LEVEL ??= "silent";
    removeOnExit(dir);
    return dir;
}

/** Temporary directory removed when the test file finishes. */
export function tempDir(prefix = "specbook-test-"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    removeOnExit(dir);
    return dir;
}

/** Steps of HUMAN_SPEC, matched by the step() titles of VALID_SPEC. */
export const HUMAN_SPEC = { preconditions: [], steps: ["Abrir a página"], expectedResult: "Página exibida", postconditions: [] };

/** A spec.ts that passes the allowlist validation and the named-steps rule for HUMAN_SPEC. */
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
