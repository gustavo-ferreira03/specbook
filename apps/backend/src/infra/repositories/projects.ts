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
            createdAt: new Date().toISOString(),
        };
        await db.insert(projects).values(row);
        return row;
    }

    async listProjects(): Promise<Project[]> {
        return db.select().from(projects).orderBy(asc(projects.createdAt), asc(projects.id));
    }

    async getProject(id: string): Promise<Project | null> {
        const rows = await db.select().from(projects).where(eq(projects.id, id));
        return rows[0] ?? null;
    }
}

export const projectsRepository = new ProjectsRepository();
