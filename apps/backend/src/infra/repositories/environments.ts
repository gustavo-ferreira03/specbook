import crypto from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { db, runBatch } from "../db/client";
import { environments, projects } from "../db/schema";

export type Environment = typeof environments.$inferSelect;
export type EnvironmentInput = Pick<Environment, "name" | "baseUrl" | "allowedOrigins" | "credentialOverrides">;

class EnvironmentsRepository {
    async list(projectId: string): Promise<Environment[]> {
        const rows = await db.select().from(environments).where(eq(environments.projectId, projectId)).orderBy(asc(environments.name));
        return rows.sort((a, b) => Number(b.name === "Production") - Number(a.name === "Production"));
    }

    async create(projectId: string, input: EnvironmentInput): Promise<Environment> {
        const row = { id: crypto.randomUUID(), projectId, ...input };
        await db.insert(environments).values(row);
        return row;
    }

    async update(row: Environment, input: EnvironmentInput): Promise<Environment> {
        await runBatch([
            db.update(environments).set(input).where(and(eq(environments.id, row.id), eq(environments.projectId, row.projectId))),
            ...(row.name === "Production" ? [db.update(projects).set({ baseUrl: input.baseUrl }).where(eq(projects.id, row.projectId))] : []),
        ]);
        return { ...row, ...input };
    }

    async delete(id: string): Promise<void> {
        await db.delete(environments).where(eq(environments.id, id));
    }
}

export const environmentsRepository = new EnvironmentsRepository();
