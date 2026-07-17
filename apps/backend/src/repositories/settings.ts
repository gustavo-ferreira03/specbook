import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { appSettings, type LlmSettings } from "../db/schema";

const SETTINGS_ID = 1;
const defaults: LlmSettings = {
    provider: "",
    model: "",
};

export async function getLlmSettings(): Promise<LlmSettings> {
    const rows = await db.select().from(appSettings).where(eq(appSettings.id, SETTINGS_ID)).limit(1);
    const llm = rows[0]?.llm;
    return {
        provider: typeof llm?.provider === "string" ? llm.provider : defaults.provider,
        model: typeof llm?.model === "string" ? llm.model : defaults.model,
    };
}

export async function updateLlmSettings(llm: LlmSettings): Promise<LlmSettings> {
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
