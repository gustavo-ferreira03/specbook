import { z } from "zod";

export const jobLimitsSchema = z.object({
    wallTimeMs: z.number().int().min(1000).max(86_400_000).default(3_600_000),
    maxActions: z.number().int().min(1).max(10_000).default(500),
}).strict();
export const createJobSchema = z.object({
    kind: z.enum(["review", "failure_triage", "regenerate", "coverage", "explore", "generate_spec"]).default("review"),
    specId: z.string().uuid().optional(),
    runId: z.string().uuid().optional(),
    goal: z.string().trim().min(1).max(12000).default("Review this project's Specs and propose useful improvements. Ask when blocked."),
    trigger: z.enum(["manual", "schedule", "spec_failure", "webhook", "steward", "chat"]).default("manual"),
    limits: jobLimitsSchema.default(() => jobLimitsSchema.parse({})),
}).strict();
export const humanSpecSchema = z.object({
    preconditions: z.array(z.string()),
    steps: z.array(z.string()).min(1),
    expectedResult: z.string(),
    postconditions: z.array(z.string()),
});
export const featureProposalSchema = z.object({
    parentId: z.string().optional(), title: z.string().min(1), description: z.string(),
});
export const newSpecProposalSchema = z.object({
    featureId: z.string(), title: z.string().min(1), description: z.string(),
    humanSpec: humanSpecSchema, testSource: z.string().min(1),
});
export const specCandidateSchema = z.object({
    title: z.string().trim().min(1).max(200),
    goal: z.string().trim().min(1).max(1000),
    feature: z.string().trim().min(1).max(200),
    featureId: z.string().uuid().optional(),
    why: z.string().trim().min(1).max(2000),
    apiDocsUrl: z.string().url().max(2000).optional(),
}).strict();
export const specBatchProposalSchema = z.object({
    title: z.string().trim().min(1).max(200).default("Which Specs would you like to add?"),
    candidates: z.array(specCandidateSchema).min(1).max(40),
}).strict();
export const selectSpecBatchSchema = z.object({
    candidateIds: z.array(z.string().uuid()).min(1).max(40),
}).strict();
export const fixProposalSchema = z.object({
    specId: z.string(), title: z.string().optional(), description: z.string().optional(),
    humanSpec: humanSpecSchema.optional(), testSource: z.string().optional(),
});
export const reportSchema = z.object({
    kind: z.enum(["question", "bug_report", "note"]),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(30000),
});
export const reviewSchema = z.object({
    action: z.enum(["approve", "reject", "answer", "dismiss", "report_bug", "ignore"]),
    answer: z.string().trim().min(1).max(12000).optional(),
});
export type JobLimits = z.infer<typeof jobLimitsSchema>;
export type JobStatus = "queued" | "running" | "paused" | "blocked" | "completed" | "stalled" | "cancelled";
export type InboxKind = "new_spec" | "spec_fix" | "spec_batch" | "feature" | "question" | "bug_report" | "note";

export const triageSchema = z.object({
    classification: z.enum(["test_drift", "application_bug", "environment"]),
    reason: z.string().trim().min(1).max(8000),
    reproduction: z.array(z.string()).min(1).max(30),
    evidence: z.array(z.string()).min(1).max(30),
});
