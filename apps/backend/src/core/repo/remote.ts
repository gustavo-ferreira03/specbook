import { simpleGit } from "simple-git";
import { projectsRepository } from "../../infra/repositories/projects";
import { authedRemoteUrl, projectGit, sanitizeGitError, withRepoLock } from "./git";

const PUSH_RETRY_MS = 60_000;
const pending = new Set<string>();
const retryTimers = new Map<string, NodeJS.Timeout>();

export async function testRemote(
    remoteUrl: string,
    token: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
        const heads = await simpleGit({ timeout: { block: 30_000 } })
            .env("GIT_TERMINAL_PROMPT", "0")
            .listRemote(["--heads", authedRemoteUrl(remoteUrl, token)]);
        const branches = heads
            .split("\n")
            .map((line) => line.trim().split(/\s+/)[1])
            .filter(Boolean);
        if (branches.length > 0 && !branches.includes("refs/heads/main")) {
            return { ok: false, error: "The remote repository must use a main branch" };
        }
        return { ok: true };
    } catch (error) {
        return { ok: false, error: sanitizeGitError(error, token) };
    }
}

function clearRetry(projectId: string): void {
    const timer = retryTimers.get(projectId);
    if (timer) clearTimeout(timer);
    retryTimers.delete(projectId);
}

export function schedulePush(projectId: string): void {
    if (pending.has(projectId)) return;
    pending.add(projectId);
    queueMicrotask(() => {
        void flushPush(projectId).catch(console.error);
    });
}

export function cancelScheduledPush(projectId: string): void {
    pending.delete(projectId);
    clearRetry(projectId);
}

export async function flushPush(projectId: string): Promise<void> {
    pending.delete(projectId);
    clearRetry(projectId);
    await withRepoLock(projectId, async () => {
        const project = await projectsRepository.getProject(projectId);
        if (!project?.gitRemoteUrl || project.gitConflictPaths?.length) return;
        const url = authedRemoteUrl(project.gitRemoteUrl, project.gitToken);
        try {
            await projectGit(projectId).push(url, "main");
            await projectsRepository.setGitPushError(projectId, null);
        } catch (error) {
            await projectsRepository.setGitPushError(projectId, sanitizeGitError(error, project.gitToken));
            const timer = setTimeout(() => {
                retryTimers.delete(projectId);
                schedulePush(projectId);
            }, PUSH_RETRY_MS);
            timer.unref();
            retryTimers.set(projectId, timer);
        }
    });
}
