import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

// Project repositories accept content from Git pushes, so any
// path inside them may be a symlink planted to reach files outside the repo.
// Every read or write of repo content goes through these helpers.

export class UnsafeRepoPathError extends Error {}

function assertInside(root: string, target: string): void {
    const relative = path.relative(root, target);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new UnsafeRepoPathError(`Path escapes the project repository: ${target}`);
    }
}

// Rejects the target if it or any parent directory below root is a symlink.
async function assertNoSymlinks(root: string, target: string): Promise<void> {
    const resolvedRoot = path.resolve(root);
    const resolvedTarget = path.resolve(target);
    assertInside(resolvedRoot, resolvedTarget);
    const parts = path.relative(resolvedRoot, resolvedTarget).split(path.sep);
    let current = resolvedRoot;
    for (const part of parts) {
        current = path.join(current, part);
        let stat;
        try {
            stat = await fs.lstat(current);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
        }
        if (stat.isSymbolicLink()) {
            throw new UnsafeRepoPathError(`Symbolic links are not allowed in project repositories: ${current}`);
        }
    }
}

export async function readRepoFile(root: string, target: string): Promise<string> {
    await assertNoSymlinks(root, target);
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        return await handle.readFile("utf8");
    } finally {
        await handle.close();
    }
}

export async function readOptionalRepoFile(root: string, target: string): Promise<string | null> {
    try {
        return await readRepoFile(root, target);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

export async function writeRepoFile(root: string, target: string, content: string): Promise<void> {
    await assertNoSymlinks(root, target);
    const handle = await fs.open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o644,
    );
    try {
        await handle.writeFile(content, "utf8");
    } finally {
        await handle.close();
    }
}

export async function assertRepoPathSafe(root: string, target: string): Promise<void> {
    await assertNoSymlinks(root, target);
}
