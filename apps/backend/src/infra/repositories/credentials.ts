import { asc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { credentialProfiles } from "../db/schema";

export type CredentialProfileRow = typeof credentialProfiles.$inferSelect;

class CredentialsRepository {
    async insertProfile(row: CredentialProfileRow): Promise<void> {
        await db.insert(credentialProfiles).values(row);
    }

    async updateProfile(
        id: string,
        patch: Pick<CredentialProfileRow, "allowedOrigins" | "fields" | "updatedAt">,
    ): Promise<void> {
        await db.update(credentialProfiles).set(patch).where(eq(credentialProfiles.id, id));
    }

    async listProfiles(projectId: string): Promise<CredentialProfileRow[]> {
        return db
            .select()
            .from(credentialProfiles)
            .where(eq(credentialProfiles.projectId, projectId))
            .orderBy(asc(credentialProfiles.name));
    }

    async getProfile(id: string): Promise<CredentialProfileRow | null> {
        const rows = await db.select().from(credentialProfiles).where(eq(credentialProfiles.id, id));
        return rows[0] ?? null;
    }

    async deleteProfile(id: string): Promise<void> {
        await db.delete(credentialProfiles).where(eq(credentialProfiles.id, id));
    }

    async deleteProjectProfiles(projectId: string): Promise<void> {
        await db.delete(credentialProfiles).where(eq(credentialProfiles.projectId, projectId));
    }
}

export const credentialsRepository = new CredentialsRepository();
