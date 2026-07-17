import crypto from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { projects } from "../db/schema";

export type Project = typeof projects.$inferSelect;

export async function createProject(name: string, baseUrl: string): Promise<Project> {
    const row: Project = {
        id: crypto.randomUUID(),
        name,
        baseUrl,
        createdAt: new Date().toISOString(),
    };
    await db.insert(projects).values(row);
    return row;
}

export async function listProjects(): Promise<Project[]> {
    return db.select().from(projects).orderBy(asc(projects.createdAt), asc(projects.id));
}

export async function getProject(id: string): Promise<Project | null> {
    const rows = await db.select().from(projects).where(eq(projects.id, id));
    return rows[0] ?? null;
}
