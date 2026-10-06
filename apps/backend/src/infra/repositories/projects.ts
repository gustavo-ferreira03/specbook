import crypto from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { projects } from "../db/schema";

export type Project = typeof projects.$inferSelect;

class ProjectsRepository {
    async createProject(name: string, baseUrl: string): Promise<Project> {
        const row: Project = {
            id: crypto.randomUUID(),
            name,
            baseUrl,
            ciAllowedOrigins: [],
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

    async updateProject(id: string, patch: Partial<Pick<Project, "name" | "baseUrl" | "ciAllowedOrigins">>): Promise<void> {
        await db.update(projects).set(patch).where(eq(projects.id, id));
    }

    async listProjects(): Promise<Project[]> {
        const rows = await db.select().from(projects).orderBy(asc(projects.createdAt), asc(projects.id));
        return rows;
    }

    async getProject(id: string): Promise<Project | null> {
        const rows = await db.select().from(projects).where(eq(projects.id, id));
        return rows[0] ?? null;
    }

    async deleteProject(id: string): Promise<void> {
        await db.delete(projects).where(eq(projects.id, id));
    }
}

export const projectsRepository = new ProjectsRepository();
