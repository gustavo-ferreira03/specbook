import { z } from "zod";
import { errorCodeSchema } from "./errors.ts";
import { httpTarget } from "./network/targets.ts";
import { MAX_REPLAY_BYTES } from "./replay.ts";

export const RUNNER_PROTOCOL_VERSION = 2;
export const RUNNER_ARTIFACT_UPLOAD_LIMIT_BYTES = 64 * 1024 * 1024;
export const RUNNER_REQUEST_LIMIT_BYTES = 90 * 1024 * 1024;

const id = z.string().uuid();
const origin = z.string().max(2000).refine((value) => {
    try { return httpTarget(value).origin === value; } catch { return false; }
}, "Use an HTTP(S) origin without credentials, path or fragment");
const baseUrl = z.string().max(2000).refine((value) => {
    try { return !httpTarget(value).search; } catch { return false; }
}, "Use an HTTP(S) URL without credentials, query or fragment");

export const runnerArtifactPathSchema = z.string().regex(/^(?:spec\.(?:ts|yml)|evidence\.json|evidence\/step-\d{2,3}\.png|evidence\/execution\.webm|evidence\/replay\.json\.gz)$/);

export const runnerPayloadSchema = z.object({
    batchId: id,
    projectId: id,
    baseUrl,
    networkPolicy: z.object({ origins: z.array(origin).min(1).max(100), allowPrivate: z.boolean() }).strict(),
    timeoutMs: z.number().int().min(1000).max(30 * 60 * 1000),
    specs: z.array(z.object({
        runId: id,
        specId: id,
        title: z.string().max(500),
        files: z.object({ "spec.ts": z.string().max(200_000), "spec.yml": z.string().max(200_000) }).strict(),
    }).strict()).min(1).max(1000),
}).strict();
export type RunnerPayload = z.infer<typeof runnerPayloadSchema>;

export const runnerQueueEntrySchema = z.object({
    projectId: id,
    projectName: z.string(),
    environmentId: id,
    environmentName: z.string(),
    group: z.string().nullable(),
    executor: z.enum(["runner", "tunnel"]),
    queued: z.number().int().nonnegative(),
    oldestQueuedAt: z.string().datetime().nullable(),
    oldestWaitMs: z.number().nonnegative(),
    onlineRunners: z.number().int().nonnegative(),
    busyRunners: z.number().int().nonnegative(),
    reason: z.string().nullable(),
}).strict();
export type RunnerQueueEntry = z.infer<typeof runnerQueueEntrySchema>;

const runnerVersionFields = {
    instanceId: id,
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/).max(100),
    protocolVersion: z.number().int().nonnegative(),
    concurrency: z.number().int().min(1).max(32),
};
export const runnerClaimRequestSchema = z.object(runnerVersionFields).strict();
export const runnerClaimResponseSchema = z.object({
    runner: z.object({ id, name: z.string(), group: z.string().nullable() }).strict(),
    lease: z.object({
        jobId: id,
        leaseId: id,
        leaseExpiresAt: z.string().datetime(),
        heartbeatMs: z.number().int().min(100).max(60_000),
        work: runnerPayloadSchema,
    }).strict().nullable(),
}).strict();
export type RunnerClaim = z.infer<typeof runnerClaimResponseSchema>;

export const runnerHeartbeatSchema = z.object({ leaseId: id, ...runnerVersionFields }).strict();
export const runnerHeartbeatResponseSchema = z.object({ leaseExpiresAt: z.string().datetime() }).strict();
export const runnerReleaseSchema = z.object({ leaseId: id, reason: z.string().trim().min(1).max(2000).optional() }).strict();
export const runnerDisconnectSchema = z.object({ instanceId: id }).strict();

export const runnerCompleteRequestSchema = z.object({
    leaseId: id,
    durationMs: z.number().int().nonnegative(),
    processFailure: z.string().max(2000).nullable(),
    results: z.array(z.object({
        runId: id,
        status: z.enum(["passed", "failed", "error"]),
        durationMs: z.number().nonnegative().nullable(),
        failReason: z.string().max(2000).nullable(),
        failedStep: z.string().max(500).nullable(),
        errorCode: errorCodeSchema.nullable().optional(),
        artifacts: z.array(z.object({
            path: runnerArtifactPathSchema,
            // Flat matching avoids regexp stack exhaustion on large artifacts.
            content: z.string().max(48 * 1024 * 1024).regex(/^[A-Za-z0-9+/]*={0,2}$/)
                .refine((value) => value.length % 4 === 0, "Use padded base64 artifact content"),
        }).strict().refine((artifact) => artifact.path !== "evidence/replay.json.gz" || Buffer.byteLength(artifact.content, "base64") <= MAX_REPLAY_BYTES,
            "Replay exceeds the 15 MB compressed limit")).max(105),
    }).strict()).min(1).max(1000),
}).strict();
export type RunnerCompletion = z.infer<typeof runnerCompleteRequestSchema>;

export const runnerJsonSchemas = {
    queue: z.toJSONSchema(runnerQueueEntrySchema),
    claim: z.toJSONSchema(runnerClaimRequestSchema),
    claimed: z.toJSONSchema(runnerClaimResponseSchema),
    heartbeat: z.toJSONSchema(runnerHeartbeatSchema),
    complete: z.toJSONSchema(runnerCompleteRequestSchema),
};
