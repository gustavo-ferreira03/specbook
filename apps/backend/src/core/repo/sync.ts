import { simpleGit, type SimpleGit } from "simple-git";
import { projectsRepository } from "../../infra/repositories/projects";
import { specsRepository } from "../../infra/repositories/specs";
import { authedRemoteUrl, projectGit, repoDir, sanitizeGitError, withRepoLock } from "./git";
import { reindexProjectUnlocked, type RobotValidator } from "./indexer";
import { schedulePush } from "./remote";

export type SyncOutcome = {
    status: "no-remote" | "clean" | "updated" | "conflict";
    conflictedPaths: string[];
};

const ORIGIN_MAIN = "refs/remotes/origin/main";

async function conflictedPaths(git: SimpleGit): Promise<string[]> {
    return (await git.raw(["diff", "--name-only", "--diff-filter=U"]))
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

async function markConflicts(projectId: string, paths: string[]): Promise<void> {
    for (const conflicted of paths) {
        const specPath = /\/spec\.(yml|md|robot)$/.test(conflicted)
            ? conflicted.replace(/\/spec\.(yml|md|robot)$/, "")
            : conflicted.replace(/\.(yml|md|robot)$/, "");
        const spec = await specsRepository.getSpecByPath(projectId, specPath);
        if (spec) await specsRepository.updateSpecStatus(spec.id, "conflict");
    }
    await projectsRepository.setGitConflictPaths(projectId, paths);
}

async function integrate(
    projectId: string,
    validate: RobotValidator | undefined,
    resolver?: Map<string, "local" | "remote">,
): Promise<SyncOutcome> {
    const git = simpleGit({
        baseDir: repoDir(projectId),
        timeout: { block: 30_000 },
        unsafe: { allowUnsafeEditor: true },
    }).env({ GIT_EDITOR: "true", GIT_TERMINAL_PROMPT: "0" });
    const local = (await git.revparse(["HEAD"])).trim();
    const remote = (await git.revparse([ORIGIN_MAIN])).trim();
    if (remote === local) {
        await reindexProjectUnlocked(projectId, validate ? { validate } : {});
        return { status: "clean", conflictedPaths: [] };
    }

    const base = await git.raw(["merge-base", "HEAD", ORIGIN_MAIN]).then((value) => value.trim()).catch(() => "");
    if (base === remote) {
        await reindexProjectUnlocked(projectId, validate ? { validate } : {});
        schedulePush(projectId);
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

    await reindexProjectUnlocked(projectId, validate ? { validate } : {});
    schedulePush(projectId);
    return { status: "updated", conflictedPaths: [] };
}

export async function syncProject(
    projectId: string,
    options: { validate?: RobotValidator } = {},
): Promise<SyncOutcome> {
    return withRepoLock(projectId, async () => {
        const project = await projectsRepository.getProject(projectId);
        if (!project) return { status: "no-remote", conflictedPaths: [] };
        if (!project.gitRemoteUrl) {
            await reindexProjectUnlocked(projectId, options.validate ? { validate: options.validate } : {});
            return { status: "no-remote", conflictedPaths: [] };
        }
        const url = authedRemoteUrl(project.gitRemoteUrl, project.gitToken);
        const git = projectGit(projectId);
        try {
            await git.fetch(url, `+main:${ORIGIN_MAIN}`);
        } catch (error) {
            const message = sanitizeGitError(error, project.gitToken);
            if (/couldn't find remote ref|no matching remote head/i.test(message)) {
                const heads = await git.listRemote(["--heads", url]).catch((headError) => {
                    throw new Error(sanitizeGitError(headError, project.gitToken));
                });
                if (heads.trim()) throw new Error("The remote repository must use a main branch");
                await reindexProjectUnlocked(projectId, options.validate ? { validate: options.validate } : {});
                await projectsRepository.setGitConflictPaths(projectId, null);
                schedulePush(projectId);
                return { status: "clean", conflictedPaths: [] };
            }
            throw new Error(message);
        }
        const outcome = await integrate(projectId, options.validate);
        if (outcome.status !== "conflict") await projectsRepository.setGitConflictPaths(projectId, null);
        return outcome;
    });
}

export async function resolveConflicts(
    projectId: string,
    choices: { path: string; keep: "local" | "remote" }[],
    options: { validate?: RobotValidator } = {},
): Promise<SyncOutcome> {
    const resolver = new Map(choices.map((choice) => [choice.path, choice.keep]));
    return withRepoLock(projectId, async () => {
        const project = await projectsRepository.getProject(projectId);
        if (!project?.gitRemoteUrl) return { status: "no-remote", conflictedPaths: [] };
        const recordedConflicts = project.gitConflictPaths ?? [];
        if (recordedConflicts.some((conflicted) => !resolver.has(conflicted))) {
            return { status: "conflict", conflictedPaths: recordedConflicts };
        }
        const url = authedRemoteUrl(project.gitRemoteUrl, project.gitToken);
        try {
            await projectGit(projectId).fetch(url, `+main:${ORIGIN_MAIN}`);
        } catch (error) {
            throw new Error(sanitizeGitError(error, project.gitToken));
        }
        const outcome = await integrate(projectId, options.validate, resolver);
        if (outcome.status === "updated" || outcome.status === "clean") {
            await projectsRepository.setGitConflictPaths(projectId, null);
        }
        return outcome;
    });
}

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
    const timer = setInterval(() => {
        void (async () => {
            for (const project of await projectsRepository.listProjects()) {
                if (!project.gitRemoteUrl || project.gitConflictPaths?.length) continue;
                await syncProject(project.id).catch((error) =>
                    console.error(`[specbook] sync failed for ${project.id}:`, error),
                );
            }
        })().catch(console.error);
    }, intervalMs);
    timer.unref();
}
