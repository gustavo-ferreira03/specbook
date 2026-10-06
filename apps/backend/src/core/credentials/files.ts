import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export async function writeProtectedFile(file: string, contents: string | Buffer): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
        await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
}
