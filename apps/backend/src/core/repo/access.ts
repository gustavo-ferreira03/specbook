import crypto from "node:crypto";
import { projectsRepository, type Project } from "../../infra/repositories/projects";

const TOKEN_PREFIX = "sbk_";
const TOUCH_INTERVAL_MS = 60_000;

const lastTouched = new Map<string, number>();

/**
 * Tokens are 256-bit random strings rather than user-chosen passwords, so a
 * single SHA-256 is enough: there is nothing to brute force and Git clients
 * re-authenticate on every request of a clone, which rules out a slow KDF.
 */
function hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
}

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
    const token = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
    const createdAt = new Date().toISOString();
    const prefix = token.slice(0, TOKEN_PREFIX.length + 6);
    await projectsRepository.setGitAccessToken(projectId, { hash: hashToken(token), prefix, createdAt });
    lastTouched.delete(projectId);
    return { token, info: { hasToken: true, prefix, createdAt, lastUsedAt: null } };
}

export async function revokeGitAccessToken(projectId: string): Promise<void> {
    await projectsRepository.setGitAccessToken(projectId, null);
    lastTouched.delete(projectId);
}

export function verifyGitAccessToken(project: Project, candidate: string): boolean {
    if (!project.gitAccessTokenHash) return false;
    const expected = Buffer.from(project.gitAccessTokenHash, "hex");
    const actual = Buffer.from(hashToken(candidate), "hex");
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
}

/** Records token usage at most once a minute; a single clone issues several requests. */
export async function noteGitAccessTokenUse(projectId: string): Promise<void> {
    const now = Date.now();
    const previous = lastTouched.get(projectId) ?? 0;
    if (now - previous < TOUCH_INTERVAL_MS) return;
    lastTouched.set(projectId, now);
    await projectsRepository.touchGitAccessToken(projectId, new Date(now).toISOString());
}
