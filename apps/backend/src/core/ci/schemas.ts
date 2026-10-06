import { z } from "zod";

export const httpUrlSchema = z.string().url().max(2048).refine((value) => {
    try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash;
    } catch { return false; }
}, "Use an HTTP(S) URL without credentials");

export const qualityGateSchema = z.object({
    failOnFlaky: z.boolean().default(false),
    failOnKnownBugs: z.boolean().default(false),
}).strict();

export const ciRunSchema = z.object({
    environment: z.string().trim().min(1).max(80).optional(),
    featureId: z.string().uuid().optional(),
    specIds: z.array(z.string().uuid()).min(1).max(500).optional(),
    baseUrl: httpUrlSchema.optional(),
    commitSha: z.string().trim().min(1).max(128).optional(),
    ref: z.string().trim().min(1).max(500).optional(),
    buildUrl: httpUrlSchema.optional(),
    qualityGate: qualityGateSchema.default({ failOnFlaky: false, failOnKnownBugs: false }),
}).strict().refine((value) => !(value.featureId && value.specIds), "Select a Feature or Specs, not both");

export const ciResultQuerySchema = z.object({
    wait: z.enum(["true", "false"]).optional(),
    format: z.enum(["json", "junit", "markdown"]).default("json"),
});

export const deploySchema = z.object({
    environment: z.string().trim().min(1).max(120).optional(),
    url: httpUrlSchema.optional(),
    commitSha: z.string().trim().min(1).max(128).optional(),
    ref: z.string().trim().min(1).max(500).optional(),
}).strict();
