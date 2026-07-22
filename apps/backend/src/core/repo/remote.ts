import { simpleGit } from "simple-git";
import { projectsRepository } from "../../infra/repositories/projects";
import { repoGit } from "./git";

const PUSH_RETRY_MS = 60_000;

class RepoRemote {
    private pending = new Set<string>();
    private retryTimers = new Map<string, NodeJS.Timeout>();

    async testRemote(remoteUrl: string, token: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
        try {
            const heads = await simpleGit({ timeout: { block: 30_000 } })
                .env("GIT_TERMINAL_PROMPT", "0")
                .listRemote(["--heads", repoGit.getAuthedRemoteUrl(remoteUrl, token)]);
            const branches = heads
                .split("\n")
                .map((line) => line.trim().split(/\s+/)[1])
                .filter(Boolean);
            if (branches.length > 0 && !branches.includes("refs/heads/main")) {
                return { ok: false, error: "The remote repository must use a main branch" };
            }
            return { ok: true };
        } catch (error) {
            return { ok: false, error: repoGit.sanitizeGitError(error, token) };
        }
    }

    private clearRetry(projectId: string): void {
        const timer = this.retryTimers.get(projectId);
        if (timer) clearTimeout(timer);
        this.retryTimers.delete(projectId);
    }

    schedulePush(projectId: string): void {
        if (this.pending.has(projectId)) return;
        this.pending.add(projectId);
        queueMicrotask(() => {
            void this.flushPush(projectId).catch(console.error);
        });
    }

    cancelScheduledPush(projectId: string): void {
        this.pending.delete(projectId);
        this.clearRetry(projectId);
    }

    async flushPush(projectId: string): Promise<void> {
        this.pending.delete(projectId);
        this.clearRetry(projectId);
        await repoGit.withRepoLock(projectId, async () => {
            const project = await projectsRepository.getProject(projectId);
            if (!project?.gitRemoteUrl || project.gitConflictPaths?.length) return;
            const url = repoGit.getAuthedRemoteUrl(project.gitRemoteUrl, project.gitToken);
            try {
                await repoGit.getProjectGit(projectId).push(url, "main");
                await projectsRepository.setGitPushError(projectId, null);
            } catch (error) {
                await projectsRepository.setGitPushError(projectId, repoGit.sanitizeGitError(error, project.gitToken));
                const timer = setTimeout(() => {
                    this.retryTimers.delete(projectId);
                    this.schedulePush(projectId);
                }, PUSH_RETRY_MS);
                timer.unref();
                this.retryTimers.set(projectId, timer);
            }
        });
    }
}

export const repoRemote = new RepoRemote();
