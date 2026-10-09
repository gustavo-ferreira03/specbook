import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { projectSecretScrubber } from "../credentials/scrub";
import { repoGit } from "./git";
import { reindexProjectUnlocked } from "./indexer";
import { assertRepoPathSafe, readOptionalRepoFile } from "./safe-fs";

export class RepositoryRecoveryError extends Error {}

interface RecoveryFile {
    path: string;
    before: string | null;
    after: string;
    deleted: boolean;
}

export interface RepositoryRecovery {
    dirty: boolean;
    blocked: boolean;
    fingerprint: string;
    files: RecoveryFile[];
    canSave: boolean;
    message: string;
}

async function operationInProgress(projectId: string): Promise<boolean> {
    const gitDir = path.join(repoGit.getRepoDir(projectId), ".git");
    const states = ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "index.lock", "HEAD.lock"];
    return (await Promise.all(states.map((state) => fs.stat(path.join(gitDir, state)).then(() => true).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
    })))).some(Boolean);
}

export async function prepareRunRepositoryUnlocked(projectId: string): Promise<void> {
    try {
        if (await operationInProgress(projectId)) throw new RepositoryRecoveryError("Project files are being updated. Try again after the update finishes, or check Project settings → Git.");
        if (!(await repoGit.getProjectGit(projectId).status()).isClean()) {
            throw new RepositoryRecoveryError("This project has pending file edits. Review and save them in Project settings → Git, then run the check again.");
        }
        await reindexProjectUnlocked(projectId, { allowDirty: false });
    } catch (error) {
        if (error instanceof RepositoryRecoveryError) throw error;
        console.error(`[specbook] preparing project files for ${projectId} failed:`, error);
        throw new RepositoryRecoveryError("Project files could not be refreshed. Check Project settings → Git and repair the affected files before running checks.");
    }
}

export async function repositoryRecoveryUnlocked(projectId: string): Promise<RepositoryRecovery> {
    const git = repoGit.getProjectGit(projectId);
    const status = await git.status();
    if (await operationInProgress(projectId) || status.conflicted.length) {
        return { dirty: !status.isClean(), blocked: true, fingerprint: "", files: [], canSave: false, message: "A repository update needs attention. Finish that update before saving pending edits. Specbook keeps the files unchanged." };
    }
    if (status.isClean()) return { dirty: false, blocked: false, fingerprint: "", files: [], canSave: false, message: "All project files are saved. Checks are ready to run." };
    const [head, tracked, untracked, metadata] = await Promise.all([
        repoGit.getHeadSha(projectId),
        git.raw(["diff", "--name-only", "-z", "HEAD", "--"]),
        git.raw(["ls-files", "--others", "--exclude-standard", "-z"]),
        git.raw(["diff", "--raw", "HEAD", "--"]),
    ]);
    const names = [...new Set([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean))].sort();
    const blocked = (message: string): RepositoryRecovery => ({ dirty: true, blocked: true, fingerprint: "", files: [], canSave: false, message });
    if (names.length > 100) return blocked("There are more than 100 changed files. Review and save them from your Git client before running checks.");
    const root = repoGit.getRepoDir(projectId);
    const files: RecoveryFile[] = [];
    let bytes = 0;
    for (const name of names) {
        const target = path.join(root, name);
        try { await assertRepoPathSafe(root, target); }
        catch { return blocked("A changed file uses an unsafe path. Fix it from your Git client before saving edits here."); }
        const stat = await fs.stat(target).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
        });
        const beforeSize = await git.raw(["cat-file", "-s", `HEAD:${name}`]).then((value) => Number(value.trim())).catch(() => 0);
        if ((stat && !stat.isFile()) || (stat?.size ?? 0) > 256_000 || beforeSize > 256_000) return blocked("A changed file is too large to review here. Review and save it from your Git client before running checks.");
        const before = await git.raw(["show", `HEAD:${name}`]).catch(() => null);
        const after = await readOptionalRepoFile(root, target);
        bytes += Buffer.byteLength(before ?? "") + Buffer.byteLength(after ?? "");
        if (bytes > 1_000_000 || before?.includes("\0") || after?.includes("\0")) return blocked("These edits include binary files or too much content to review here. Review and save them from your Git client before running checks.");
        if (before === after) return blocked("File permissions changed without a content change. Review and save those changes from your Git client.");
        files.push({ path: name, before, after: after ?? "", deleted: after === null });
    }
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ head, metadata, files })).digest("hex");
    const scrub = await projectSecretScrubber(projectId);
    return {
        dirty: true, blocked: false, fingerprint, canSave: files.length > 0,
        files: files.map((file) => ({ ...file, before: file.before === null ? null : scrub(file.before), after: scrub(file.after) })),
        message: "Review these file changes before saving. Saving keeps the edits, creates a project revision, and refreshes the checks.",
    };
}

export async function saveRepositoryRecovery(projectId: string, fingerprint: string): Promise<{ commitSha: string; message: string }> {
    return repoGit.withRepoLock(projectId, async () => {
        const current = await repositoryRecoveryUnlocked(projectId);
        if (!current.canSave) throw new RepositoryRecoveryError(current.message);
        if (current.fingerprint !== fingerprint) throw new RepositoryRecoveryError("The files changed after this review. Refresh the changes and review them again before saving.");
        const commitSha = await repoGit.commitAll(projectId, "specbook: save reviewed pending edits");
        try {
            const result = await reindexProjectUnlocked(projectId, { allowDirty: false });
            if (result.invalidSpecs.length) {
                const count = result.invalidSpecs.length;
                return { commitSha, message: `Pending edits saved. ${count} ${count === 1 ? "check still needs" : "checks still need"} repair. Open the affected check and choose Repair in chat.` };
            }
        } catch (error) {
            console.error(`[specbook] indexing reviewed edits for ${projectId} failed:`, error);
            return { commitSha, message: "Your edits were saved. Some files still need repair before their checks can run." };
        }
        return { commitSha, message: "Pending edits saved. You can run your checks now." };
    });
}
