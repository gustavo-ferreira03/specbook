import { asc, eq } from "drizzle-orm";

import { db } from "../db/client";
import { credentialProfiles } from "../db/schema";

class CredentialsRepository {
  // oxlint-disable-next-line class-methods-use-this -- Keep this operation on the service instance used by callers.
  async insertProfile(row: CredentialProfileRow): Promise<void> {
    await db.insert(credentialProfiles).values(row);
  }

  // oxlint-disable-next-line class-methods-use-this -- Keep this operation on the service instance used by callers.
  async updateProfile(
    id: string,
    patch: Pick<CredentialProfileRow, "allowedOrigins" | "fields" | "updatedAt">
  ): Promise<void> {
    await db
      .update(credentialProfiles)
      .set(patch)
      .where(eq(credentialProfiles.id, id));
  }

  // oxlint-disable-next-line class-methods-use-this -- Keep this operation on the service instance used by callers.
  async listProfiles(projectId: string): Promise<CredentialProfileRow[]> {
    return await db
      .select()
      .from(credentialProfiles)
      .where(eq(credentialProfiles.projectId, projectId))
      .orderBy(asc(credentialProfiles.name));
  }

  // oxlint-disable-next-line class-methods-use-this -- Keep this operation on the service instance used by callers.
  async getProfile(id: string): Promise<CredentialProfileRow | null> {
    const rows = await db
      .select()
      .from(credentialProfiles)
      .where(eq(credentialProfiles.id, id));
    return rows[0] ?? null;
  }

  // oxlint-disable-next-line class-methods-use-this -- Keep this operation on the service instance used by callers.
  async deleteProfile(id: string): Promise<void> {
    await db.delete(credentialProfiles).where(eq(credentialProfiles.id, id));
  }

  // oxlint-disable-next-line class-methods-use-this -- Keep this operation on the service instance used by callers.
  async deleteProjectProfiles(projectId: string): Promise<void> {
    await db
      .delete(credentialProfiles)
      .where(eq(credentialProfiles.projectId, projectId));
  }
}

export type CredentialProfileRow = typeof credentialProfiles.$inferSelect;

export const credentialsRepository = new CredentialsRepository();
