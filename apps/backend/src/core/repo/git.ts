import fs from "node:fs/promises";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { reposDir } from "../paths";

const repoLocks = new Map<string, Promise<unknown>>();

export function repoDir(projectId: string): string {
    const absoluteRoot = path.resolve(reposDir);
    const dir = path.resolve(absoluteRoot, projectId);
    if (path.dirname(dir) !== absoluteRoot) throw new Error("Invalid project repo directory");
    return dir;
}

export function projectGit(projectId: string): SimpleGit {
    return simpleGit(repoDir(projectId));
}

export async function withRepoLock<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = repoLocks.get(projectId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    repoLocks.set(projectId, current);
    try {
        return await current;
    } finally {
        if (repoLocks.get(projectId) === current) repoLocks.delete(projectId);
    }
}

export async function ensureProjectRepo(projectId: string): Promise<void> {
    const dir = repoDir(projectId);
    await fs.mkdir(dir, { recursive: true });
    const git = simpleGit(dir);
    const hasGitDir = await fs
        .stat(path.join(dir, ".git"))
        .then((stat) => stat.isDirectory())
        .catch(() => false);
    if (hasGitDir) return;
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.name", "specbook");
    await git.addConfig("user.email", "specbook@local");
    await git.raw(["commit", "--allow-empty", "-m", "specbook: init"]);
}

export async function headSha(projectId: string): Promise<string> {
    return (await projectGit(projectId).revparse(["HEAD"])).trim();
}

export async function commitAll(projectId: string, message: string): Promise<string> {
    const git = projectGit(projectId);
    await git.add(["-A"]);
    const status = await git.status();
    if (!status.isClean()) await git.commit(message);
    return headSha(projectId);
}

export function authedRemoteUrl(remoteUrl: string, token: string | null): string {
    if (!token) return remoteUrl;
    const url = new URL(remoteUrl);
    url.username = "x-access-token";
    url.password = token;
    return url.toString();
}

export function sanitizeGitError(error: unknown, token: string | null): string {
    const message = error instanceof Error ? error.message : String(error);
    return token ? message.split(token).join("***") : message;
}
