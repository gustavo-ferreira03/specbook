import crypto from "node:crypto";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../../core/credentials/crypto";
import { db } from "../db/client";
import { projects } from "../db/schema";
import { logger } from "../logger";

export type Project = typeof projects.$inferSelect;

/** Tokens written before encryption was introduced are stored verbatim. */
function isEncryptedToken(stored: string): boolean {
    return /^v1:[^:]+:[^:]+:[^:]+$/.test(stored);
}

/** The Git token is encrypted at rest; callers always see plaintext. */
function withPlainToken(row: Project): Project {
    if (!row.gitToken || !isEncryptedToken(row.gitToken)) return row;
    try {
        return { ...row, gitToken: decryptSecret(row.gitToken) };
    } catch (error) {
        logger.error("could not decrypt the project Git token; reconnect the remote", { projectId: row.id, error });
        return { ...row, gitToken: null };
    }
}

class ProjectsRepository {
    async createProject(name: string, baseUrl: string): Promise<Project> {
        const row: Project = {
            id: crypto.randomUUID(),
            name,
            baseUrl,
            gitRemoteUrl: null,
            gitToken: null,
            gitPushError: null,
            gitConflictPaths: null,
            contextSyncError: null,
            gitAccessTokenHash: null,
            gitAccessTokenPrefix: null,
            gitAccessTokenCreatedAt: null,
            gitAccessTokenLastUsedAt: null,
            gitExternalSyncError: null,
            createdAt: new Date().toISOString(),
        };
        await db.insert(projects).values(row);
        return row;
    }

    async updateGitConnection(id: string, remoteUrl: string | null, token: string | null): Promise<void> {
        await db
            .update(projects)
            .set({
                gitRemoteUrl: remoteUrl,
                gitToken: token ? encryptSecret(token) : null,
                gitPushError: null,
                gitConflictPaths: null,
            })
            .where(eq(projects.id, id));
    }

    async setGitPushError(id: string, error: string | null): Promise<void> {
        await db.update(projects).set({ gitPushError: error }).where(eq(projects.id, id));
    }

    async setGitConflictPaths(id: string, paths: string[] | null): Promise<void> {
        await db.update(projects).set({ gitConflictPaths: paths }).where(eq(projects.id, id));
    }

    async setContextSyncError(id: string, error: string | null): Promise<void> {
        await db.update(projects).set({ contextSyncError: error }).where(eq(projects.id, id));
    }

    async setGitExternalSyncError(id: string, error: string | null): Promise<void> {
        await db.update(projects).set({ gitExternalSyncError: error }).where(eq(projects.id, id));
    }

    async setGitAccessToken(
        id: string,
        token: { hash: string; prefix: string; createdAt: string } | null,
    ): Promise<void> {
        await db
            .update(projects)
            .set({
                gitAccessTokenHash: token?.hash ?? null,
                gitAccessTokenPrefix: token?.prefix ?? null,
                gitAccessTokenCreatedAt: token?.createdAt ?? null,
                gitAccessTokenLastUsedAt: null,
            })
            .where(eq(projects.id, id));
    }

    async touchGitAccessToken(id: string, usedAt: string): Promise<void> {
        await db.update(projects).set({ gitAccessTokenLastUsedAt: usedAt }).where(eq(projects.id, id));
    }

    async updateProject(id: string, patch: Partial<Pick<Project, "name" | "baseUrl">>): Promise<void> {
        await db.update(projects).set(patch).where(eq(projects.id, id));
    }

    async listProjects(): Promise<Project[]> {
        const rows = await db.select().from(projects).orderBy(asc(projects.createdAt), asc(projects.id));
        return rows.map(withPlainToken);
    }

    async getProject(id: string): Promise<Project | null> {
        const rows = await db.select().from(projects).where(eq(projects.id, id));
        return rows[0] ? withPlainToken(rows[0]) : null;
    }

    /** Encrypts Git tokens stored in plaintext by earlier versions. Returns how many were migrated. */
    async encryptLegacyGitTokens(): Promise<number> {
        const rows = await db
            .select({ id: projects.id, gitToken: projects.gitToken })
            .from(projects)
            .where(isNotNull(projects.gitToken));
        let migrated = 0;
        for (const row of rows) {
            if (!row.gitToken || isEncryptedToken(row.gitToken)) continue;
            await db
                .update(projects)
                .set({ gitToken: encryptSecret(row.gitToken) })
                .where(and(eq(projects.id, row.id), eq(projects.gitToken, row.gitToken)));
            migrated += 1;
        }
        return migrated;
    }

    async deleteProject(id: string): Promise<void> {
        await db.delete(projects).where(eq(projects.id, id));
    }
}

export const projectsRepository = new ProjectsRepository();
