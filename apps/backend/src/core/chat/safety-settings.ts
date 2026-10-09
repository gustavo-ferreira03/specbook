import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { settingsRepository } from "../../infra/repositories/settings";

const storedSecuritySettingsSchema = z.object({ sendScreenshotsToModel: z.boolean().default(true) });
export const securitySettingsSchema = storedSecuritySettingsSchema.strict();
export type SecuritySettings = z.infer<typeof securitySettingsSchema>;
let current = securitySettingsSchema.parse({});
let generation = 0;

export async function getSecuritySettings(): Promise<SecuritySettings> {
    const started = generation;
    const stored = storedSecuritySettingsSchema.parse(await settingsRepository.getSecuritySettings() ?? {});
    if (started === generation) current = stored;
    return current;
}

export async function updateSecuritySettings(input: unknown): Promise<SecuritySettings> {
    const settings = securitySettingsSchema.parse(input);
    await settingsRepository.updateSecuritySettings(settings);
    generation++;
    current = settings;
    return settings;
}

export async function agentSettings(): Promise<SettingsManager> {
    await getSecuritySettings();
    const settings = SettingsManager.inMemory();
    settings.setCacheWarmingMode("off");
    settings.getBlockImages = () => !current.sendScreenshotsToModel;
    return settings;
}
