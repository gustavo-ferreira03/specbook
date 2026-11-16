import crypto from "node:crypto";

import { and, asc, eq } from "drizzle-orm";

import { db, runBatch } from "../db/client";
import { environments, projects } from "../db/schema";

class ProjectsRepository {
  // oxlint-disable-next-line class-methods-use-this -- Keep this operation on the service instance used by callers.
  async createProject(name: string, baseUrl: string): Promise<Project> {
    const row: Project = {
      id: crypto.randomUUID(),
      name,
      baseUrl,
      contextSyncError: null,
      gitAccessTokenHash: null,
      gitAccessTokenPrefix: null,
      gitAccessTokenCreatedAt: null,
      gitAccessTokenLastUsedAt: null,
      gitExternalSyncError: null,
      createdAt: new Date().toISOString(),
    };
    await runBatch([
      db.insert(projects).values(row),
      db.insert(environments).values({
        id: crypto.randomUUID(),
        projectId: row.id,
        name: "Production",
        baseUrl,
        allowedOrigins: [],
        credentialOverrides: {},
      }),
    ]);
    return row;
  }

  // oxlint-disable-next-line class-methods-use-this -- Keep this operation on the service instance used by callers.
  async setContextSyncError(id: string, error: string | null): Promise<void> {
    await db
      .update(projects)
      .set({ contextSyncError: error })
      .where(eq(projects.id, id));
  }

  // oxlint-disable-next-line class-methods-use-this -- Keep this operation on the service instance used by callers.
  async setGitExternalSyncError(
    id: string,
    error: string | null
  ): Promise<void> {
    await db
      .update(projects)
      .set({ gitExternalSyncError: error })
      .where(eq(projects.id, id));
  }

  // oxlint-disable-next-line class-methods-use-this -- Keep this operation on the service instance used by callers.
  async setGitAccessToken(
    id: string,
    token: { hash: string; prefix: string; createdAt: string } | null
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

  // oxlint-disable-next-line class-methods-use-this -- Keep this operation on the service instance used by callers.
  async touchGitAccessToken(id: string, usedAt: string): Promise<void> {
    await db
      .update(projects)
      .set({ gitAccessTokenLastUsedAt: usedAt })
      .where(eq(projects.id, id));
  }

  // oxlint-disable-next-line class-methods-use-this -- Keep this operation on the service instance used by callers.
  async updateProject(
    id: string,
    patch: Partial<Pick<Project, "name" | "baseUrl">>
  ): Promise<void> {
    await runBatch([
      db.update(projects).set(patch).where(eq(projects.id, id)),
      ...(patch.baseUrl
        ? [
            db
              .update(environments)
              .set({ baseUrl: patch.baseUrl })
              .where(
                and(
                  eq(environments.projectId, id),
                  eq(environments.name, "Production")
                )
              ),
          ]
        : []),
    ]);
  }

  // oxlint-disable-next-line class-methods-use-this -- Keep this operation on the service instance used by callers.
  async listProjects(): Promise<Project[]> {
    const rows = await db
      .select()
      .from(projects)
      .orderBy(asc(projects.createdAt), asc(projects.id));
    return rows;
  }

  // oxlint-disable-next-line class-methods-use-this -- Keep this operation on the service instance used by callers.
  async getProject(id: string): Promise<Project | null> {
    const rows = await db.select().from(projects).where(eq(projects.id, id));
    return rows[0] ?? null;
  }

  // oxlint-disable-next-line class-methods-use-this -- Keep this operation on the service instance used by callers.
  async deleteProject(id: string): Promise<void> {
    await db.delete(projects).where(eq(projects.id, id));
  }
}

type ProjectRow = typeof projects.$inferSelect;
export type Project = ProjectRow;

export const projectsRepository = new ProjectsRepository();
