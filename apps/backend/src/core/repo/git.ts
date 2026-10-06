import fs from "node:fs/promises";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { projectsRepository } from "../../infra/repositories/projects";
import { reposDir } from "../paths";
import { repoBare } from "./bare";
import { currentActor, recordAudit } from "../accounts/audit";

// Lock files git leaves behind when the process is killed mid-operation.
const STALE_CHECKOUT_LOCKS = [
    "index.lock",
    "HEAD.lock",
    "config.lock",
    "packed-refs.lock",
    path.join("refs", "heads", "main.lock"),
];

class RepoGit {
    private locks = new Map<string, Promise<unknown>>();
    private hardenedCheckouts = new Set<string>();

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
            allowEnvironment: ["GIT_TERMINAL_PROMPT"],
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
        if (hasGitDir) {
            await this.hardenCheckoutConfig(projectId);
            return;
        }
        if (!options.create) throw new Error(`Git repository is missing for project ${projectId}`);
        await git.init(["--initial-branch=main"]);
        await git.addConfig("user.name", "specbook");
        await git.addConfig("user.email", "specbook@local");
        await this.hardenCheckoutConfig(projectId);
        await git.raw(["commit", "--allow-empty", "-m", "specbook: init"]);
    }

    /**
     * Content arrives from Git pushes, so symbolic links are
     * checked out as plain files holding the link target instead of real links.
     */
    private async hardenCheckoutConfig(projectId: string): Promise<void> {
        if (this.hardenedCheckouts.has(projectId)) return;
        const git = this.getProjectGit(projectId);
        const current = await git.raw(["config", "--local", "--get", "core.symlinks"]).then((value) => value.trim()).catch(() => "");
        if (current !== "false") await git.addConfig("core.symlinks", "false");
        this.hardenedCheckouts.add(projectId);
    }

    /**
     * Mirrors the checkout's main branch into the canonical bare repository,
     * creating it if missing. Callers must hold the repo lock. State problems
     * are recorded on the project (gitExternalSyncError) and rethrown.
     */
    async publishToBareUnlocked(projectId: string): Promise<void> {
        const checkoutDir = this.getRepoDir(projectId);
        if (!(await repoBare.bareExists(projectId))) {
            await repoBare.ensureBareRepo(projectId, checkoutDir);
            return;
        }
        await repoBare.publish(projectId, checkoutDir);
    }

    async getHeadSha(projectId: string): Promise<string> {
        return (await this.getProjectGit(projectId).revparse(["HEAD"])).trim();
    }

    async commitAll(projectId: string, message: string): Promise<string> {
        const git = this.getProjectGit(projectId);
        await git.add(["-A"]);
        const status = await git.status();
        if (!status.isClean()) {
            const actor = currentActor();
            await git.commit(message, actor?.kind === "user" && actor.email ? { "--author": `${actor.name} <${actor.email}>` } : undefined);
        }
        const head = await this.getHeadSha(projectId);
        await this.publishToBareUnlocked(projectId).catch((error: unknown) => {
            console.error(`[specbook] publishing ${projectId} to its canonical repository failed:`, error);
        });
        if (!status.isClean()) await recordAudit("repository.commit", { commitSha: head, message }, projectId);
        return head;
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

    /**
     * Repairs what a process killed mid-operation leaves behind: a pending
     * rebase (which makes every write fail) and stale lock files. Only safe when
     * no git operation runs on this project in this process, i.e. at boot.
     */
    async recoverInterruptedState(projectId: string): Promise<void> {
        if (this.locks.has(projectId)) {
            throw new Error(`Refusing to recover ${projectId} while a repository operation is running`);
        }
        const dir = this.getRepoDir(projectId);
        const gitDir = path.join(dir, ".git");
        if (!(await fs.stat(gitDir).then((stat) => stat.isDirectory()).catch(() => false))) return;
        for (const lock of STALE_CHECKOUT_LOCKS) {
            const target = path.join(gitDir, lock);
            if (await fs.stat(target).then(() => true).catch(() => false)) {
                console.warn(`[specbook] removing stale lock ${target}`);
                await fs.rm(target, { force: true });
            }
        }
        const git = this.getProjectGit(projectId);
        for (const name of ["rebase-merge", "rebase-apply"]) {
            const target = path.join(gitDir, name);
            if (!(await fs.stat(target).then(() => true).catch(() => false))) continue;
            console.warn(`[specbook] aborting an interrupted rebase in ${projectId}`);
            try {
                await git.rebase(["--abort"]);
            } catch (error) {
                // --abort fails when the rebase state is itself incomplete;
                // --quit drops the state and leaves HEAD where it is.
                console.error(`[specbook] rebase --abort failed for ${projectId}, falling back to --quit:`, error);
                await git.rebase(["--quit"]).catch(() => fs.rm(target, { recursive: true, force: true }));
            }
        }
        if (await repoBare.bareExists(projectId)) await repoBare.removeStaleLocks(projectId);
        await this.hardenCheckoutConfig(projectId);
    }

    /** Runs recoverInterruptedState for every project. Call at boot, before reindexing. */
    async recoverAllInterruptedState(): Promise<void> {
        for (const project of await projectsRepository.listProjects()) {
            await this.recoverInterruptedState(project.id).catch((error: unknown) => {
                console.error(`[specbook] recovering the repository of ${project.id} failed:`, error);
            });
        }
    }

}

export const repoGit = new RepoGit();
