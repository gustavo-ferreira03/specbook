import { z } from "zod";

const days = z.number().int().min(1).max(3650);
export const retentionSettingsSchema = z.object({
    runsPerSpec: z.number().int().min(1).max(1000).default(20),
    runDays: days.default(30),
    videoDays: days.default(7),
    batchDays: days.default(30),
    metricDays: days.default(90),
    browserProfileDays: days.default(30),
}).strict();
export type RetentionSettings = z.infer<typeof retentionSettingsSchema>;

export interface RetentionCleanup {
    completedAt: string;
    removedRuns: number;
    removedVideos: number;
    removedBatches: number;
    removedMetrics: number;
    removedBrowserProfiles: number;
}
