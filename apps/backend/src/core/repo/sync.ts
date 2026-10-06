import { simpleGit, type SimpleGit } from "simple-git";
import { projectsRepository } from "../../infra/repositories/projects";
import { specsRepository } from "../../infra/repositories/specs";
import { BareStateError, repoBare } from "./bare";
import { repoGit } from "./git";
import { reindexProjectUnlocked } from "./indexer";
import { isSyncError, repoRemote, SYNC_ERROR_PREFIX } from "./remote";

export type SyncOutcome = {
    status: "no-remote" | "clean" | "updated" | "conflict";
    conflictedPaths: string[];
};

const ORIGIN_MAIN = "refs/remotes/origin/main";
async function recordSyncError(projectId: string, error: unknown | null): Promise<void> {
    try {
        const project = await projectsRepository.getProject(projectId);
        if (!project) return;
        if (error === null) {
            if (isSyncError(project.gitPushError)) await projectsRepository.setGitPushError(projectId, null);
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        await projectsRepository.setGitPushError(projectId, `${SYNC_ERROR_PREFIX}${message}`);
    } catch (dbError) {
        console.error(`[specbook] recording the sync state of ${projectId} failed:`, dbError);
    }
}

/**
 * Rejects a fetched GitHub tree that contains symbolic links (mode 120000) or
 * gitlinks (mode 160000) before anything from it is checked out. Only the tip
 * is checked: it is the only incoming tree the checkout ever materialises.
 */
async function assertNoForbiddenEntries(git: SimpleGit, ref: string): Promise<void> {
    const listing = await git.raw(["ls-tree", "-r", "-z", ref]);
    for (const entry of listing.split("\0")) {
        if (!entry) continue;
        const tab = entry.indexOf("\t");
        const mode = entry.slice(0, entry.indexOf(" "));
        if (mode === "120000" || mode === "160000") {
            const kind = mode === "120000" ? "a symbolic link" : "a submodule";
            throw new Error(`The GitHub repository contains ${kind} at ${entry.slice(tab + 1)}; Specbook does not accept symbolic links or submodules`);
        }
    }
}

/** Makes the checkout contain everything pushed to the canonical repository before it is rebased. */
async function followBareUnlocked(projectId: string): Promise<void> {
    const checkoutDir = repoGit.getRepoDir(projectId);
    if (!(await repoBare.bareExists(projectId))) return;
    await repoBare.fastForwardCheckout(projectId, checkoutDir);
}

async function conflictedPaths(git: SimpleGit): Promise<string[]> {
    return (await git.raw(["diff", "--name-only", "--diff-filter=U"]))
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

async function markConflicts(projectId: string, paths: string[]): Promise<void> {
    for (const conflicted of paths) {
        const specPath = /\/spec\.(yml|ts|robot)$/.test(conflicted)
            ? conflicted.replace(/\/spec\.(yml|ts|robot)$/, "")
            : conflicted;
        const spec = await specsRepository.getSpecByPath(projectId, specPath);
        if (spec) await specsRepository.updateSpecStatus(spec.id, "conflict");
    }
    await projectsRepository.setGitConflictPaths(projectId, paths);
}

async function integrate(
    projectId: string,
    resolver?: Map<string, "local" | "remote">,
): Promise<SyncOutcome> {
    const git = simpleGit({
        baseDir: repoGit.getRepoDir(projectId),
        timeout: { block: 30_000 },
        unsafe: { allowUnsafeEditor: true },
    }).env({ GIT_EDITOR: "true", GIT_TERMINAL_PROMPT: "0" });
    const local = (await git.revparse(["HEAD"])).trim();
    const remote = (await git.revparse([ORIGIN_MAIN])).trim();
    if (remote !== local) await assertNoForbiddenEntries(git, remote);
    if (remote === local) {
        await reindexProjectUnlocked(projectId);
        return { status: "clean", conflictedPaths: [] };
    }

    const base = await git.raw(["merge-base", "HEAD", ORIGIN_MAIN]).then((value) => value.trim()).catch(() => "");
    if (base === remote) {
        await reindexProjectUnlocked(projectId);
        repoRemote.schedulePush(projectId);
        return { status: "clean", conflictedPaths: [] };
    }

    const rebaseArgs = base ? [ORIGIN_MAIN] : ["--root", "--onto", ORIGIN_MAIN];
    try {
        await git.rebase(rebaseArgs);
    } catch (rebaseError) {
        const initialConflicts = await conflictedPaths(git);
        if (!resolver) {
            await git.rebase(["--abort"]);
            if (initialConflicts.length === 0) throw rebaseError;
            await markConflicts(projectId, initialConflicts);
            return { status: "conflict", conflictedPaths: initialConflicts };
        }

        try {
            let completed = false;
            for (let round = 0; round < 100; round += 1) {
                const conflicts = await conflictedPaths(git);
                const missingChoices = conflicts.filter((file) => !resolver.has(file));
                if (missingChoices.length > 0) {
                    const unresolved = [...new Set([...resolver.keys(), ...conflicts])];
                    await git.rebase(["--abort"]);
                    await markConflicts(projectId, unresolved);
                    return { status: "conflict", conflictedPaths: unresolved };
                }
                for (const file of conflicts) {
                    const keep = resolver.get(file);
                    const sourceSha = keep === "local" ? local : remote;
                    const exists = await git
                        .raw(["cat-file", "-e", `${sourceSha}:${file}`])
                        .then(() => true)
                        .catch(() => false);
                    if (exists) await git.raw(["checkout", sourceSha, "--", file]);
                    else await git.raw(["rm", "--force", "--", file]);
                }
                await git.add(["-A"]);
                try {
                    await git.rebase(["--continue"]);
                    completed = true;
                    break;
                } catch (continueError) {
                    if ((await conflictedPaths(git)).length > 0) continue;
                    const message = continueError instanceof Error ? continueError.message : String(continueError);
                    if (!/no changes|patch is empty|previous cherry-pick is now empty/i.test(message)) {
                        throw continueError;
                    }
                    try {
                        await git.rebase(["--skip"]);
                        if ((await conflictedPaths(git)).length > 0) continue;
                        completed = true;
                        break;
                    } catch (skipError) {
                        if ((await conflictedPaths(git)).length > 0) continue;
                        throw skipError instanceof Error ? skipError : continueError;
                    }
                }
            }
            if (!completed) throw new Error("Git rebase did not finish after 100 conflict-resolution rounds");
        } catch (error) {
            await git.rebase(["--abort"]).catch(() => undefined);
            throw error;
        }
    }

    if (resolver) {
        for (const [file, keep] of resolver) {
            const sourceSha = keep === "local" ? local : remote;
            const exists = await git
                .raw(["cat-file", "-e", `${sourceSha}:${file}`])
                .then(() => true)
                .catch(() => false);
            if (exists) await git.raw(["checkout", sourceSha, "--", file]);
            else await git.raw(["rm", "--force", "--", file]).catch(() => undefined);
        }
        await git.add(["-A"]);
        if (!(await git.status()).isClean()) await git.commit("specbook: resolve git conflicts");
    }

    // The rebase rewrote local commits that may already be in the canonical
    // repository; publish the rewritten history there deliberately.
    await repoBare.publishAfterRewrite(projectId, repoGit.getRepoDir(projectId), local).catch((error: unknown) => {
        // Already recorded on the project; the checkout is still consistent
        // with GitHub, so indexing it must go on.
        if (!(error instanceof BareStateError)) throw error;
        console.error(`[specbook] publishing the sync of ${projectId} to its canonical repository failed:`, error.message);
    });
    await reindexProjectUnlocked(projectId);
    repoRemote.schedulePush(projectId);
    return { status: "updated", conflictedPaths: [] };
}

export async function syncProject(projectId: string): Promise<SyncOutcome> {
    try {
        const outcome = await syncProjectUnrecorded(projectId);
        await recordSyncError(projectId, null);
        return outcome;
    } catch (error) {
        await recordSyncError(projectId, error);
        throw error;
    }
}

async function syncProjectUnrecorded(projectId: string): Promise<SyncOutcome> {
    return repoGit.withRepoLock(projectId, async () => {
        const project = await projectsRepository.getProject(projectId);
        if (!project) return { status: "no-remote", conflictedPaths: [] };
        if (!project.gitRemoteUrl) {
            await reindexProjectUnlocked(projectId);
            return { status: "no-remote", conflictedPaths: [] };
        }
        await followBareUnlocked(projectId);
        const url = repoGit.getAuthedRemoteUrl(project.gitRemoteUrl, project.gitToken);
        const git = repoGit.getProjectGit(projectId);
        try {
            await git.fetch(url, `+main:${ORIGIN_MAIN}`);
        } catch (error) {
            const message = repoGit.sanitizeGitError(error, project.gitToken);
            if (/couldn't find remote ref|no matching remote head/i.test(message)) {
                const heads = await git.listRemote(["--heads", url]).catch((headError: unknown) => {
                    throw new Error(repoGit.sanitizeGitError(headError, project.gitToken));
                });
                if (heads.trim()) throw new Error("The remote repository must use a main branch");
                await reindexProjectUnlocked(projectId);
                await projectsRepository.setGitConflictPaths(projectId, null);
                repoRemote.schedulePush(projectId);
                return { status: "clean", conflictedPaths: [] };
            }
            throw new Error(message);
        }
        const outcome = await integrate(projectId);
        if (outcome.status !== "conflict") await projectsRepository.setGitConflictPaths(projectId, null);
        return outcome;
    });
}

export async function resolveConflicts(
    projectId: string,
    choices: { path: string; keep: "local" | "remote" }[],
): Promise<SyncOutcome> {
    const resolver = new Map(choices.map((choice) => [choice.path, choice.keep]));
    return repoGit.withRepoLock(projectId, async () => {
        const project = await projectsRepository.getProject(projectId);
        if (!project?.gitRemoteUrl) return { status: "no-remote", conflictedPaths: [] };
        const recordedConflicts = project.gitConflictPaths ?? [];
        if (recordedConflicts.some((conflicted) => !resolver.has(conflicted))) {
            return { status: "conflict", conflictedPaths: recordedConflicts };
        }
        await followBareUnlocked(projectId);
        const url = repoGit.getAuthedRemoteUrl(project.gitRemoteUrl, project.gitToken);
        try {
            await repoGit.getProjectGit(projectId).fetch(url, `+main:${ORIGIN_MAIN}`);
        } catch (error) {
            throw new Error(repoGit.sanitizeGitError(error, project.gitToken));
        }
        const outcome = await integrate(projectId, resolver);
        if (outcome.status === "updated" || outcome.status === "clean") {
            await projectsRepository.setGitConflictPaths(projectId, null);
        }
        return outcome;
    });
}

/**
 * Best-effort pull before a mutation. A failure does not block the mutation
 * (the change is committed locally and pushed later), but syncProject records
 * it on the project so it is visible instead of silently ignored.
 */
export async function syncBeforeMutation(projectId: string): Promise<void> {
    try {
        const project = await projectsRepository.getProject(projectId);
        if (!project || project.gitConflictPaths?.length) return;
        await syncProject(projectId);
    } catch (error) {
        console.error(`[specbook] pre-mutation sync failed for ${projectId}:`, error);
    }
}

export function startSyncLoop(intervalMs = 60_000): void {
    let running = false;
    const timer = setInterval(() => {
        // A slow remote can make one pass outlast the interval; skip the tick
        // instead of stacking passes that all queue on the same repo locks.
        if (running) return;
        running = true;
        void (async () => {
            for (const project of await projectsRepository.listProjects()) {
                if (!project.gitRemoteUrl || project.gitConflictPaths?.length) continue;
                await syncProject(project.id).catch((error) =>
                    console.error(`[specbook] sync failed for ${project.id}:`, error),
                );
            }
        })()
            .catch(console.error)
            .finally(() => {
                running = false;
            });
    }, intervalMs);
    timer.unref();
}
