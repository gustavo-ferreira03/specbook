import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

const storageDir = path.join(os.tmpdir(), `specbook-vitest-${process.pid}`);
fs.mkdirSync(storageDir, { recursive: true });

export default defineConfig({
    test: {
        env: { SPECBOOK_STORAGE_DIR: storageDir },
        fileParallelism: false,
        setupFiles: ["./test/setup.ts"],
    },
});
