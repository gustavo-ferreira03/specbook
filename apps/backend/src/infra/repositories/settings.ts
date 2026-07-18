import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { appSettings, type LlmSettings } from "../db/schema";

const SETTINGS_ID = 1;

class SettingsRepository {
    private defaults: LlmSettings = {
        provider: "",
        model: "",
    };

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
