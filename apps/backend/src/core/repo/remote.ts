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
        await simpleGit().listRemote([authedRemoteUrl(remoteUrl, token)]);
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

export async function flushPush(projectId: string): Promise<void> {
    pending.delete(projectId);
    clearRetry(projectId);
    const project = await projectsRepository.getProject(projectId);
    if (!project?.gitRemoteUrl) return;
    const url = authedRemoteUrl(project.gitRemoteUrl, project.gitToken);
    try {
        await withRepoLock(projectId, () => projectGit(projectId).push(url, "main").then(() => undefined));
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
}
