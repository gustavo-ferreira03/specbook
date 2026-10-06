import type { SecuritySettings } from "../../core/chat/safety-settings";
import { retentionSettingsSchema, type RetentionCleanup, type RetentionSettings } from "../../core/operations/schemas";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { appSettings, type LlmSettings } from "../db/schema";

const SETTINGS_ID = 1;

class SettingsRepository {
    private defaults: LlmSettings = {
        provider: "",
        model: "",
    };

    async getRetention(): Promise<{ settings: RetentionSettings; lastCleanup: RetentionCleanup | null }> {
        const [row] = await db.select({ settings: appSettings.retention, lastCleanup: appSettings.retentionLastCleanup }).from(appSettings).where(eq(appSettings.id, SETTINGS_ID)).limit(1);
        return { settings: retentionSettingsSchema.parse(row?.settings ?? {}), lastCleanup: row?.lastCleanup ?? null };
    }

    async updateRetention(settings: RetentionSettings): Promise<void> {
        const updatedAt = new Date().toISOString();
        await db.insert(appSettings).values({ id: SETTINGS_ID, llm: this.defaults, retention: settings, updatedAt })
            .onConflictDoUpdate({ target: appSettings.id, set: { retention: settings, updatedAt } });
    }

    async recordRetentionCleanup(retentionLastCleanup: RetentionCleanup): Promise<void> {
        const updatedAt = new Date().toISOString();
        await db.insert(appSettings).values({ id: SETTINGS_ID, llm: this.defaults, retentionLastCleanup, updatedAt })
            .onConflictDoUpdate({ target: appSettings.id, set: { retentionLastCleanup, updatedAt } });
    }

    async getSecuritySettings(): Promise<SecuritySettings | null> {
        const rows = await db.select({ security: appSettings.security }).from(appSettings).where(eq(appSettings.id, SETTINGS_ID)).limit(1);
        return rows[0]?.security ?? null;
    }

    async updateSecuritySettings(security: SecuritySettings): Promise<void> {
        const updatedAt = new Date().toISOString();
        await db.insert(appSettings).values({ id: SETTINGS_ID, llm: this.defaults, security, updatedAt })
            .onConflictDoUpdate({ target: appSettings.id, set: { security, updatedAt } });
    }

    async getAgentPaused(): Promise<boolean> {
        const rows = await db.select({ paused: appSettings.agentPaused }).from(appSettings).where(eq(appSettings.id, SETTINGS_ID)).limit(1);
        return rows[0]?.paused ?? false;
    }

    async setAgentPaused(paused: boolean): Promise<boolean> {
        const updatedAt = new Date().toISOString();
        await db.insert(appSettings).values({ id: SETTINGS_ID, llm: this.defaults, agentPaused: paused, updatedAt })
            .onConflictDoUpdate({ target: appSettings.id, set: { agentPaused: paused, updatedAt } });
        return paused;
    }

    async getLlmSettings(): Promise<LlmSettings> {
        const rows = await db.select().from(appSettings).where(eq(appSettings.id, SETTINGS_ID)).limit(1);
        const llm = rows[0]?.llm;
        return {
            provider: typeof llm?.provider === "string" ? llm.provider : this.defaults.provider,
            model: typeof llm?.model === "string" ? llm.model : this.defaults.model,
        };
    }

    async updateLlmSettings(llm: LlmSettings): Promise<LlmSettings> {
        const values = {
            id: SETTINGS_ID,
            llm,
            updatedAt: new Date().toISOString(),
        };
        await db
            .insert(appSettings)
            .values(values)
            .onConflictDoUpdate({
                target: appSettings.id,
                set: {
                    llm: values.llm,
                    updatedAt: values.updatedAt,
                },
            });
        return llm;
    }
}

export const settingsRepository = new SettingsRepository();
