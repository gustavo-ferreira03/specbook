import fs from "node:fs/promises";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { reposDir } from "../paths";

class RepoGit {
    private locks = new Map<string, Promise<unknown>>();

    getRepoDir(projectId: string): string {
        const absoluteRoot = path.resolve(reposDir);
        const dir = path.resolve(absoluteRoot, projectId);
        if (path.dirname(dir) !== absoluteRoot) throw new Error("Invalid project repo directory");
        return dir;
    }

    getProjectGit(projectId: string): SimpleGit {
        return simpleGit({
            baseDir: this.getRepoDir(projectId),
            timeout: { block: 30_000 },
        }).env("GIT_TERMINAL_PROMPT", "0");
    }

    async withRepoLock<T>(projectId: string, work: () => Promise<T>): Promise<T> {
        const previous = this.locks.get(projectId) ?? Promise.resolve();
        const current = previous.catch(() => undefined).then(work);
        this.locks.set(projectId, current);
        try {
            return await current;
        } finally {
            if (this.locks.get(projectId) === current) this.locks.delete(projectId);
        }
    }

    async ensureProjectRepo(projectId: string, options: { create?: boolean } = {}): Promise<void> {
        const dir = this.getRepoDir(projectId);
        await fs.mkdir(dir, { recursive: true });
        const git = simpleGit(dir);
        const hasGitDir = await fs
            .stat(path.join(dir, ".git"))
            .then((stat) => stat.isDirectory())
            .catch(() => false);
        if (hasGitDir) return;
        if (!options.create) throw new Error(`Git repository is missing for project ${projectId}`);
        await git.init(["--initial-branch=main"]);
        await git.addConfig("user.name", "specbook");
        await git.addConfig("user.email", "specbook@local");
        await git.raw(["commit", "--allow-empty", "-m", "specbook: init"]);
    }

    async getHeadSha(projectId: string): Promise<string> {
        return (await this.getProjectGit(projectId).revparse(["HEAD"])).trim();
    }

    async commitAll(projectId: string, message: string): Promise<string> {
        const git = this.getProjectGit(projectId);
        await git.add(["-A"]);
        const status = await git.status();
        if (!status.isClean()) await git.commit(message);
        return this.getHeadSha(projectId);
    }

    async assertRepoWritableUnlocked(projectId: string): Promise<void> {
        const gitDir = path.join(this.getRepoDir(projectId), ".git");
        const rebaseInProgress = await Promise.all(["rebase-merge", "rebase-apply"].map((name) =>
            fs.stat(path.join(gitDir, name)).then(() => true).catch((error) => {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
                throw error;
            }),
        ));
        if (rebaseInProgress.some(Boolean)) throw new Error("The project repository has an unfinished rebase");
        const status = await this.getProjectGit(projectId).status();
        if (!status.isClean()) throw new Error("The project repository has uncommitted changes; sync them first");
    }

    async pinRunCommitUnlocked(projectId: string, runId: string, commitSha: string): Promise<void> {
        if (!/^[0-9a-f-]{36}$/i.test(runId) || !/^[0-9a-f]{40}$/i.test(commitSha)) {
            throw new Error("Invalid run commit reference");
        }
        await this.getProjectGit(projectId).raw(["update-ref", `refs/specbook/runs/${runId}`, commitSha]);
    }

    async deleteRunCommitRefsUnlocked(projectId: string, runIds: string[]): Promise<void> {
        for (const runId of runIds) {
            if (!/^[0-9a-f-]{36}$/i.test(runId)) continue;
            await this.getProjectGit(projectId).raw(["update-ref", "-d", `refs/specbook/runs/${runId}`]);
        }
    }

    getAuthedRemoteUrl(remoteUrl: string, token: string | null): string {
        if (!token) return remoteUrl;
        const url = new URL(remoteUrl);
        url.username = "x-access-token";
        url.password = token;
        return url.toString();
    }

    sanitizeGitError(error: unknown, token: string | null): string {
        const message = error instanceof Error ? error.message : String(error);
        return token ? message.split(token).join("***") : message;
    }
}

export const repoGit = new RepoGit();
