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
            gitRemoteUrl: null,
            gitToken: null,
            gitPushError: null,
            gitConflictPaths: null,
            contextSyncError: null,
            createdAt: new Date().toISOString(),
        };
        await db.insert(projects).values(row);
        return row;
    }

    async updateGitConnection(id: string, remoteUrl: string | null, token: string | null): Promise<void> {
        await db
            .update(projects)
            .set({ gitRemoteUrl: remoteUrl, gitToken: token, gitPushError: null, gitConflictPaths: null })
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

    async listProjects(): Promise<Project[]> {
        return db.select().from(projects).orderBy(asc(projects.createdAt), asc(projects.id));
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
