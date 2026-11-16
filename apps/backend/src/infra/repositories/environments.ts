import crypto from "node:crypto";

import { and, asc, eq } from "drizzle-orm";

import { repoGit } from "../../core/repo/git";
import { db, runBatch } from "../db/client";
import { environments, projects } from "../db/schema";
import { specEnvironmentsRepository } from "./spec-environments";
import { specsRepository } from "./specs";

class EnvironmentsRepository {
  // oxlint-disable-next-line class-methods-use-this -- Keep this operation on the service instance used by callers.
  async list(projectId: string): Promise<Environment[]> {
    const rows = await db
      .select()
      .from(environments)
      .where(eq(environments.projectId, projectId))
      .orderBy(asc(environments.name));
    return rows.toSorted(
      (a, b) =>
        Number(b.name === "Production") - Number(a.name === "Production")
    );
  }

  // oxlint-disable-next-line class-methods-use-this -- Keep this operation on the service instance used by callers.
  async create(
    projectId: string,
    input: EnvironmentInput
  ): Promise<Environment> {
    const row = {
      id: crypto.randomUUID(),
      projectId,
      executor: "server" as const,
      runnerGroup: null,
      timeoutScale: 1,
      ...input,
    };
    await db.insert(environments).values(row);
    return row;
  }

  // oxlint-disable-next-line class-methods-use-this -- Keep this operation on the service instance used by callers.
  async update(
    row: Environment,
    input: EnvironmentInput
  ): Promise<Environment> {
    await runBatch([
      db
        .update(environments)
        .set(input)
        .where(
          and(
            eq(environments.id, row.id),
            eq(environments.projectId, row.projectId)
          )
        ),
      ...(row.name === "Production"
        ? [
            db
              .update(projects)
              .set({ baseUrl: input.baseUrl })
              .where(eq(projects.id, row.projectId)),
          ]
        : []),
    ]);
    return { ...row, ...input };
  }

  // oxlint-disable-next-line class-methods-use-this -- Keep this operation on the service instance used by callers.
  async delete(id: string): Promise<void> {
    const row = await (async () => {
      const awaitedValue1953 = await db
        .select()
        .from(environments)
        .where(eq(environments.id, id));
      return awaitedValue1953[0];
    })();
    if (!row) {
      return;
    }
    await repoGit.withRepoLock(row.projectId, async () => {
      await db.delete(environments).where(eq(environments.id, id));
      for (const spec of await specsRepository.listSpecs(row.projectId)) {
        if (spec.status === "awaiting_deploy") {
          // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
          await specEnvironmentsRepository.refresh(spec);
        }
      }
    });
  }
}

export type Environment = typeof environments.$inferSelect;
export type EnvironmentInput = Pick<
  Environment,
  "name" | "baseUrl" | "allowedOrigins" | "credentialOverrides"
> &
  Partial<Pick<Environment, "executor" | "runnerGroup" | "timeoutScale">>;

export const environmentsRepository = new EnvironmentsRepository();
