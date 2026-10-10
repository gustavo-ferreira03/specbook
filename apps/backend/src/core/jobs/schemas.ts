import { errorCodeSchema } from "../errors";
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
    featureId: z.string().trim().max(100).optional(),
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
    errorCode: errorCodeSchema.optional(),
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
    errorCode: errorCodeSchema.optional(),
    classification: z.enum(["test_drift", "application_bug", "environment"]),
    reason: z.string().trim().min(1).max(8000),
    reproduction: z.array(z.string()).min(1).max(30),
    evidence: z.array(z.string()).min(1).max(30),
});

const storedCandidateSchema = specCandidateSchema.partial().extend({
    id: z.string().default(""), title: z.string().default(""), goal: z.string().default(""), feature: z.string().default(""), why: z.string().default(""),
    selected: z.boolean().optional(), jobId: z.string().optional(), specId: z.string().optional(), runId: z.string().optional(),
    resolvedFeatureId: z.string().optional(), error: z.string().optional(),
    state: z.enum(["proposed", "passed", "failed", "needs_answer", "generating", "stopped", "queued"]).optional(),
    finishedAt: z.string().optional(), questionId: z.string().optional(),
}).passthrough();
export const storedSpecBatchSchema = z.object({
    candidates: z.array(storedCandidateSchema), sourceChatId: z.string().default(""), contextRevisionId: z.string().optional(), selectedAt: z.string().optional(),
    contextStatus: z.string().optional(), contextReviewRequired: z.boolean().optional(),
}).passthrough();
export type SpecBatch = z.infer<typeof storedSpecBatchSchema>;
export type SpecBatchCandidate = z.infer<typeof storedCandidateSchema>;

export const proposalVerificationSchema = z.object({
    id: z.string().default(""), status: z.enum(["passed", "failed", "error"]), durationMs: z.number().nullable().default(null),
    failReason: z.string().nullable().default(null), failedStep: z.string().nullable().default(null),
    sourceHash: z.string().default(""), baseUrl: z.string().default(""), screenshots: z.array(z.string()).default([]),
    errorCode: errorCodeSchema.nullable().optional(),
    review: z.object({ verdict: z.enum(["matches", "weak", "assertion_wrong", "app_differs", "contradicts", "unclear"]), reason: z.string() }).nullable().optional(),
});
const proposalParamsSchema = z.object({
    specId: z.string().optional(), featureId: z.string().optional(), title: z.string().optional(), description: z.string().optional(),
    humanSpec: humanSpecSchema.optional(), testSource: z.string().optional(),
}).passthrough();
export const inboxPayloadSchema = z.object({
    specBatch: storedSpecBatchSchema.optional().catch(undefined), verification: proposalVerificationSchema.optional().catch(undefined),
    params: z.custom<z.infer<typeof proposalParamsSchema>>((value) => proposalParamsSchema.safeParse(value).success).optional().catch(undefined),
    before: z.object({ yaml: z.string().optional(), testSource: z.string().nullable().optional() }).passthrough().optional().catch(undefined),
    credentialRequest: z.object({ profileName: z.string(), fields: z.array(z.object({ key: z.string(), label: z.string().optional() })) }).optional().catch(undefined),
    waitingFor: z.enum(["credentials", "investigation", "run_prerequisite"]).optional().catch(undefined),
    errorCode: errorCodeSchema.nullable().optional().catch(undefined),
    runIntentId: z.string().optional().catch(undefined), sourceChatId: z.string().optional().catch(undefined), discussionChatId: z.string().optional().catch(undefined),
    regressionIntentId: z.string().optional().catch(undefined), sourceItemId: z.string().optional().catch(undefined),
    specId: z.string().nullable().optional().catch(undefined), runId: z.string().nullable().optional().catch(undefined),
    baseHead: z.string().optional().catch(undefined), requiresVerification: z.boolean().optional().catch(true),
    mcpContractChange: z.boolean().optional().catch(undefined), retiredByScope: z.boolean().optional().catch(undefined),
    ignoredCheck: z.boolean().optional().catch(undefined), rulesVersion: z.coerce.number().optional().catch(undefined),
}).passthrough();
export type InboxPayload = z.infer<typeof inboxPayloadSchema>;

export function payloadOf(item: { payload: unknown }): InboxPayload {
    const parsed = inboxPayloadSchema.safeParse(item.payload);
    return parsed.success ? parsed.data : {};
}

export function specBatchOf(item: { payload: unknown }): SpecBatch | undefined {
    return payloadOf(item).specBatch;
}

export function verificationOf(item: { payload: unknown }) {
    return payloadOf(item).verification;
}
