import { projectsRepository, type Project } from "../../infra/repositories/projects";
import { issuePrefixedToken, verifyTokenHash } from "../accounts/tokens";

const TOUCH_INTERVAL_MS = 60_000;

const lastTouched = new Map<string, number>();

export interface GitAccessTokenInfo {
    hasToken: boolean;
    prefix: string | null;
    createdAt: string | null;
    lastUsedAt: string | null;
}

export function accessTokenInfoOf(project: Project): GitAccessTokenInfo {
    return {
        hasToken: Boolean(project.gitAccessTokenHash),
        prefix: project.gitAccessTokenPrefix,
        createdAt: project.gitAccessTokenCreatedAt,
        lastUsedAt: project.gitAccessTokenLastUsedAt,
    };
}

/** Creates a token, replacing any previous one. The plain value is returned once. */
export async function issueGitAccessToken(projectId: string): Promise<{ token: string; info: GitAccessTokenInfo }> {
    const { token, hash, prefix } = issuePrefixedToken("sbk_");
    const createdAt = new Date().toISOString();
    await projectsRepository.setGitAccessToken(projectId, { hash, prefix, createdAt });
    lastTouched.delete(projectId);
    return { token, info: { hasToken: true, prefix, createdAt, lastUsedAt: null } };
}

export async function revokeGitAccessToken(projectId: string): Promise<void> {
    await projectsRepository.setGitAccessToken(projectId, null);
    lastTouched.delete(projectId);
}

export function verifyGitAccessToken(project: Project, candidate: string): boolean {
    return project.gitAccessTokenHash ? verifyTokenHash(project.gitAccessTokenHash, candidate) : false;
}

/** Records token usage at most once a minute; a single clone issues several requests. */
export async function noteGitAccessTokenUse(projectId: string): Promise<void> {
    const now = Date.now();
    const previous = lastTouched.get(projectId) ?? 0;
    if (now - previous < TOUCH_INTERVAL_MS) return;
    lastTouched.set(projectId, now);
    await projectsRepository.touchGitAccessToken(projectId, new Date(now).toISOString());
}
