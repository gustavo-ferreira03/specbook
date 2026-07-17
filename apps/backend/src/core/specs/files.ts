import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { specsDir, storageRoot } from "../paths";

function resolveWithin(root: string, relativePath: string): string {
    const absoluteRoot = path.resolve(root);
    const absolutePath = path.resolve(absoluteRoot, relativePath);
    const relative = path.relative(absoluteRoot, absolutePath);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error("Spec executable path is outside storage");
    }
    return absolutePath;
}

export async function writeSpecExecutable(
    specId: string,
    version: number,
    source: string,
): Promise<{ executablePath: string; executableHash: string }> {
    const dir = resolveWithin(specsDir, specId);
    await fs.mkdir(dir, { recursive: true });
    const absolute = resolveWithin(dir, `v${version}.robot`);
    await fs.writeFile(absolute, source, "utf8");
    return {
        executablePath: path.relative(storageRoot, absolute),
        executableHash: crypto.createHash("sha256").update(source).digest("hex"),
    };
}

export async function readSpecExecutable(executablePath: string): Promise<string> {
    const absolute = resolveWithin(storageRoot, executablePath);
    const [canonicalRoot, canonicalPath] = await Promise.all([
        fs.realpath(storageRoot),
        fs.realpath(absolute),
    ]);
    resolveWithin(canonicalRoot, path.relative(canonicalRoot, canonicalPath));
    return fs.readFile(canonicalPath, "utf8");
}

export async function removeSpecExecutable(executablePath: string): Promise<void> {
    const absolute = resolveWithin(storageRoot, executablePath);
    await fs.rm(absolute, { force: true });
    await fs.rmdir(path.dirname(absolute)).catch(() => undefined);
}
