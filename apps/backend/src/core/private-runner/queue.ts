import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { HTTPException } from "hono/http-exception";
import { RUNNER_ARTIFACT_UPLOAD_LIMIT_BYTES, runnerArtifactPathSchema, runnerPayloadSchema, type RunnerCompletion, type RunnerPayload } from "@specbook/runtime/runner-protocol";
import { decodeReplay, encodeReplay, MAX_REPLAY_BYTES, REPLAY_FILE } from "@specbook/runtime/replay";
import { scrubJson } from "@specbook/runtime/scrub";
import { MAX_RUNNER_ATTEMPTS, RUNNER_EXECUTION_GRACE_MS, runnerJobDeadline, runnerQueueTimeoutMs, runnersRepository, type RunnerJob, type RunnerToken } from "../../infra/repositories/runners";
import { runsDir } from "../paths";
import { createKeyedLock } from "../operations/keyed-lock";
import { logger } from "../../infra/logger";
import { issuePrefixedToken } from "../accounts/tokens";
import { publicRunner } from "./tokens";
import { projectSecretScrubber } from "../credentials/scrub";

const withQueueLock = createKeyedLock().run;
const jobLocks = createKeyedLock();
const activeCompletions = new Set<string>();
const events = new EventEmitter();
events.setMaxListeners(0);
let monitor: NodeJS.Timeout | undefined;
let maintenance: Promise<void> | undefined;

export function runnerLeaseMs(): number {
    const seconds = Number(process.env.SPECBOOK_RUNNER_LEASE_SECONDS ?? 60);
    return Number.isFinite(seconds) ? Math.min(300, Math.max(5, seconds)) * 1000 : 60_000;
}

export async function enqueueRunnerBatch(batchId: string, projectId: string, group: string | null | undefined, payload: RunnerPayload): Promise<void> {
    const work = runnerPayloadSchema.parse(payload);
    if (work.batchId !== batchId || work.projectId !== projectId) throw new Error("Runner work does not match its batch");
    await runnersRepository.enqueue(batchId, projectId, group || null, work);
    events.emit("work");
}

export async function pendingRunnerBatchIds(): Promise<string[]> {
    return (await runnersRepository.pending()).map((job) => job.batchId);
}

export async function pendingRunnerRunIds(): Promise<string[]> {
    return (await runnersRepository.pending()).flatMap((job) => job.payload.specs.map((spec) => spec.runId));
}

function waitForWork(signal: AbortSignal, milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
        const finish = () => { clearTimeout(timer); events.off("work", finish); signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, milliseconds);
        events.once("work", finish);
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
    });
}

export async function claimRunnerWork(runner: RunnerToken, signal: AbortSignal, instanceId: string): Promise<RunnerJob | null> {
    const deadline = Date.now() + 25_000;
    while (!signal.aborted) {
        await maintainRunnerQueue();
        const job = await withQueueLock("queue", async () => {
            const current = await runnersRepository.get(runner.id);
            if (!current) throw new HTTPException(401, { message: "Runner token was revoked" });
            if (current.tokenHash !== runner.tokenHash) throw new HTTPException(401, { message: "Runner token was rotated. Configure the replacement token." });
            const instance = await runnersRepository.instance(instanceId);
            if (!instance || instance.disconnectedAt || instance.runnerId !== runner.id || instance.mode !== "runner") throw new HTTPException(409, { message: "Runner instance disconnected. Restart the CLI process." });
            return runnersRepository.claim(current, runnerLeaseMs(), instanceId, [...activeCompletions]);
        });
        if (job) return job;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await waitForWork(signal, Math.min(1000, remaining));
    }
    await runnersRepository.touch(runner.id);
    return null;
}

export async function reportRunnerInstance(runner: RunnerToken, input: { instanceId: string; version: string; protocolVersion: number; concurrency: number }): Promise<void> {
    await withQueueLock("queue", async () => {
        const current = await runnersRepository.get(runner.id);
        if (!current || current.tokenHash !== runner.tokenHash) throw new HTTPException(401, { message: "Runner token changed. Configure the replacement token and restart the runner." });
        await runnersRepository.touch(runner.id, input);
        await runnersRepository.reportInstance(runner.id, input.instanceId, input);
    });
}

export async function disconnectRunnerInstance(runner: RunnerToken, instanceId: string): Promise<void> {
    await withQueueLock("queue", async () => {
        const current = await runnersRepository.get(runner.id);
        if (!current || current.tokenHash !== runner.tokenHash) throw new HTTPException(401, { message: "Runner token changed" });
        await runnersRepository.disconnect(runner.id, instanceId);
    });
    events.emit("work");
}

function leaseMatches(job: RunnerJob | null, runnerId: string, leaseId: string): job is RunnerJob {
    return Boolean(job && job.runnerId === runnerId && job.leaseId === leaseId);
}

function requireLease(job: RunnerJob | null, runnerId: string, leaseId: string): RunnerJob {
    if (!leaseMatches(job, runnerId, leaseId) || job.status !== "leased" || !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= Date.now() || runnerJobDeadline(job) <= Date.now()) {
        throw new HTTPException(409, { message: "Runner lease expired or this work was reassigned" });
    }
    return job;
}

export async function heartbeatRunnerWork(jobId: string, runnerId: string, leaseId: string): Promise<string> {
    return withQueueLock("queue", async () => {
        if (!await runnersRepository.get(runnerId)) throw new HTTPException(401, { message: "Runner token was revoked" });
        const expiresAt = await runnersRepository.heartbeat(jobId, leaseId, runnerId, runnerLeaseMs());
        if (!expiresAt) throw new HTTPException(409, { message: "Runner lease expired or this work was reassigned" });
        return expiresAt;
    });
}

export async function releaseRunnerWork(jobId: string, runnerId: string, leaseId: string, reason?: string): Promise<void> {
    await jobLocks.run(jobId, async () => {
        const job = await withQueueLock("queue", async () => {
            if (!await runnersRepository.get(runnerId)) throw new HTTPException(401, { message: "Runner token was revoked" });
            const job = requireLease(await runnersRepository.job(jobId), runnerId, leaseId);
            if (reason) { await runnersRepository.reserveCompletion(jobId); activeCompletions.add(jobId); }
            else await runnersRepository.release(jobId, leaseId, runnerId);
            return job;
        });
        if (reason) { try { await failRunnerJob(job, reason, true); } finally { activeCompletions.delete(jobId); } }
    });
    events.emit("work");
}

export async function completeRunnerWork(jobId: string, runnerId: string, completion: RunnerCompletion): Promise<void> {
    await jobLocks.run(jobId, async () => {
        const job = await withQueueLock("queue", async () => {
            if (!await runnersRepository.get(runnerId)) throw new HTTPException(401, { message: "Runner token was revoked" });
            const row = await runnersRepository.job(jobId);
            if (leaseMatches(row, runnerId, completion.leaseId) && row.status === "completed") return null;
            const job = requireLease(row, runnerId, completion.leaseId);
            const expected = new Set(job.payload.specs.map((spec) => spec.runId));
            const reported = new Set(completion.results.map((result) => result.runId));
            if (reported.size !== completion.results.length || expected.size !== reported.size || [...reported].some((id) => !expected.has(id))) {
                throw new HTTPException(400, { message: "Report one result for each Spec in the runner work" });
            }
            // Accepted uploads finish once even if their token is revoked during storage.
            await runnersRepository.reserveCompletion(jobId);
            activeCompletions.add(jobId);
            return job;
        });
        if (!job) return;
        const staging = path.join(runsDir, `.runner-upload-${job.id}-${completion.leaseId}`);
        let bytes = 0;
        let storedBytes = 0;
        try {
            const scrub = await projectSecretScrubber(job.projectId);
            const safeCompletion = { ...completion, processFailure: completion.processFailure === null ? null : scrub(completion.processFailure),
                results: completion.results.map((result) => ({ ...result, failReason: result.failReason === null ? null : scrub(result.failReason),
                    failedStep: result.failedStep === null ? null : scrub(result.failedStep) })) };
            await fs.rm(staging, { recursive: true, force: true });
            await fs.mkdir(staging, { mode: 0o700 });
            const root = await fs.realpath(runsDir);
            if (await fs.realpath(staging) !== path.join(root, path.basename(staging))) throw new HTTPException(400, { message: "Invalid runner artifact directory" });
            for (const result of completion.results) {
                const paths = new Set<string>();
                let replayBytes: number | null = null;
                let replayUnavailable: string | undefined;
                for (const artifact of result.artifacts) {
                    if (!runnerArtifactPathSchema.safeParse(artifact.path).success) throw new HTTPException(400, { message: "Invalid runner artifact path" });
                    if (paths.has(artifact.path)) throw new HTTPException(400, { message: "Artifact paths must be unique for each run" });
                    paths.add(artifact.path);
                    // The server keeps the immutable Spec snapshot prepared before dispatch.
                    if (artifact.path === "spec.ts" || artifact.path === "spec.yml") continue;
                    let content: Buffer = Buffer.from(artifact.content, "base64");
                    bytes += content.length;
                    if (bytes > RUNNER_ARTIFACT_UPLOAD_LIMIT_BYTES || content.length > 32 * 1024 * 1024) throw new HTTPException(413, { message: "Runner artifacts exceed the upload limit" });
                    if (artifact.path === REPLAY_FILE) {
                        if (content.length > MAX_REPLAY_BYTES) throw new HTTPException(413, { message: "Runner replay exceeds the compressed limit" });
                        const events = await decodeReplay(content);
                        if (!events) throw new HTTPException(400, { message: "Invalid runner replay recording" });
                        const safe = await encodeReplay(scrubJson(events, scrub));
                        if (!safe) { replayUnavailable = "Replay was omitted because it exceeded recording limits."; continue; }
                        content = safe;
                        replayBytes = content.length;
                    } else if (artifact.path === "evidence.json") {
                        try { content = Buffer.from(JSON.stringify(scrubJson(JSON.parse(content.toString("utf8")), scrub))); }
                        catch { throw new HTTPException(400, { message: "Invalid runner evidence manifest" }); }
                    }
                    storedBytes += content.length;
                    if (storedBytes > RUNNER_ARTIFACT_UPLOAD_LIMIT_BYTES || content.length > 32 * 1024 * 1024) throw new HTTPException(413, { message: "Runner artifacts exceed the upload limit" });
                    const file = path.join(staging, result.runId, artifact.path);
                    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
                    await fs.writeFile(file, content, { mode: 0o600, flag: "wx" });
                }
                if (replayBytes !== null || replayUnavailable) {
                    const manifestFile = path.join(staging, result.runId, "evidence.json");
                    const text = await fs.readFile(manifestFile, "utf8").catch(() => null);
                    let manifest: Record<string, unknown>;
                    try { manifest = JSON.parse(text ?? "null"); } catch { throw new HTTPException(400, { message: "Invalid runner replay evidence manifest" }); }
                    if (!manifest || Array.isArray(manifest) || typeof manifest !== "object") throw new HTTPException(400, { message: "Invalid runner replay evidence manifest" });
                    manifest.replay = replayBytes === null ? null : { file: REPLAY_FILE, bytes: replayBytes };
                    if (replayUnavailable) manifest.replayUnavailable = replayUnavailable;
                    else delete manifest.replayUnavailable;
                    const updated = JSON.stringify(manifest);
                    storedBytes += Buffer.byteLength(updated) - Buffer.byteLength(text!);
                    if (storedBytes > RUNNER_ARTIFACT_UPLOAD_LIMIT_BYTES || Buffer.byteLength(updated) > 32 * 1024 * 1024) throw new HTTPException(413, { message: "Runner artifacts exceed the upload limit" });
                    await fs.writeFile(manifestFile, updated, { mode: 0o600 });
                }
            }
            for (const result of completion.results) {
                const target = path.join(runsDir, result.runId);
                await fs.mkdir(target, { recursive: true });
                const [root, actual] = await Promise.all([fs.realpath(runsDir), fs.realpath(target)]);
                if (actual !== path.join(root, result.runId)) throw new HTTPException(400, { message: "Invalid runner artifact directory" });
                await fs.rm(path.join(target, "evidence"), { recursive: true, force: true });
                await fs.rm(path.join(target, "evidence.json"), { force: true });
                for (const artifact of result.artifacts) {
                    if (artifact.path === "spec.ts" || artifact.path === "spec.yml") continue;
                    const source = path.join(staging, result.runId, artifact.path);
                    if (artifact.path === REPLAY_FILE && !await fs.lstat(source).catch(() => null)) continue;
                    const destination = path.join(target, artifact.path);
                    await fs.mkdir(path.dirname(destination), { recursive: true });
                    await fs.rename(source, destination);
                }
            }
            const { finishRunnerBatch } = await import("../runner/batch");
            await finishRunnerBatch(job.batchId, safeCompletion);
            await runnersRepository.complete(job.id);
        } catch (error) {
            await withQueueLock("queue", () => runnersRepository.restoreLease(job.id, completion.leaseId));
            throw error;
        } finally {
            activeCompletions.delete(jobId);
            await fs.rm(staging, { recursive: true, force: true });
        }
    });
}

export async function revokeRunnerToken(id: string): Promise<boolean> {
    const revoked = await withQueueLock("queue", () => runnersRepository.revoke(id));
    const { closeRunnerTunnels } = await import("../tunnel/registry");
    closeRunnerTunnels(id);
    events.emit("work");
    return revoked;
}

export async function rotateRunnerToken(id: string) {
    const issued = issuePrefixedToken("sb_runner_");
    const runner = await withQueueLock("queue", () => runnersRepository.rotate(id, issued.hash));
    if (!runner) throw new HTTPException(404, { message: "Runner not found" });
    const { closeRunnerTunnels } = await import("../tunnel/registry");
    closeRunnerTunnels(id);
    events.emit("work");
    return { token: issued.token, runner: publicRunner(runner) };
}

export async function cancelRunnerBatch(batchId: string): Promise<boolean> {
    const job = (await runnersRepository.pending()).find((row) => row.batchId === batchId);
    if (!job) return false;
    return jobLocks.run(job.id, () => withQueueLock("queue", () => runnersRepository.cancelBatch(batchId)));
}

async function failRunnerJob(job: RunnerJob, reason: string, failedAttempt = false): Promise<void> {
    const { finishRunnerBatch, failBrokenRunnerBatch } = await import("../runner/batch");
    await runnersRepository.recordFailure(job.id, reason, failedAttempt);
    try {
        await finishRunnerBatch(job.batchId, { leaseId: job.leaseId ?? crypto.randomUUID(), durationMs: Math.max(0, Date.now() - Date.parse(job.createdAt)), processFailure: reason,
            results: job.payload.specs.map((spec) => ({ runId: spec.runId, status: "error", durationMs: null, failReason: reason, failedStep: null, errorCode: "infrastructure", artifacts: [] })) });
    } catch (error) {
        const failure = `${reason} Runner work could not be finalized because its batch or Spec snapshot is unavailable.`;
        logger.error("could not finalize runner work", { jobId: job.id, batchId: job.batchId, error });
        await runnersRepository.recordFailure(job.id, failure);
        await failBrokenRunnerBatch(job, failure).catch((error: unknown) => logger.error("could not recover runner batch", { jobId: job.id, error }));
    } finally {
        await runnersRepository.complete(job.id, true);
    }
}

function failureReason(job: RunnerJob): string | null {
    if (runnerJobDeadline(job) <= Date.now()) return job.status === "queued"
        ? `Runner work expired after waiting ${Math.round(runnerQueueTimeoutMs() / 1000)}s for a runner${job.group ? ` in group ${job.group}` : ""}.${job.lastFailure ? ` ${job.lastFailure}` : ""}`
        : `Runner execution expired after ${Math.round((job.payload.timeoutMs + RUNNER_EXECUTION_GRACE_MS) / 1000)}s. No runner completed this work.${job.lastFailure ? ` ${job.lastFailure}` : ""}`;
    if (job.status === "queued" && job.attempts >= MAX_RUNNER_ATTEMPTS) return `Runner work stopped after ${MAX_RUNNER_ATTEMPTS} attempts.${job.lastFailure ? ` ${job.lastFailure}` : " Runners repeatedly disconnected before completion."}`;
    return null;
}

export function maintainRunnerQueue(): Promise<void> {
    if (maintenance) return maintenance;
    maintenance = (async () => {
        await withQueueLock("queue", () => runnersRepository.reclaim(new Date().toISOString(), [...activeCompletions]));
        const jobs = (await runnersRepository.pending()).filter((job) => !activeCompletions.has(job.id) && !jobLocks.has(job.id) && failureReason(job));
        const results = await Promise.allSettled(jobs.map((job) => jobLocks.run(job.id, async () => {
            const current = await withQueueLock("queue", async () => {
                const row = await runnersRepository.job(job.id);
                if (!row || row.status === "completed" || !failureReason(row)) return null;
                await runnersRepository.reserveCompletion(row.id);
                return row;
            });
            if (current) await failRunnerJob(current, failureReason(current)!);
        })));
        for (let index = 0; index < results.length; index++) {
            const result = results[index];
            if (result.status !== "rejected") continue;
            const job = jobs[index];
            logger.error("runner maintenance could not finish work", { jobId: job.id, error: result.reason });
            await runnersRepository.recordFailure(job.id, "Runner work could not be finalized during queue maintenance.")
                .then(() => runnersRepository.complete(job.id, true))
                .catch((error: unknown) => logger.error("could not retire runner work", { jobId: job.id, error }));
        }
        events.emit("work");
    })().finally(() => { maintenance = undefined; });
    return maintenance;
}

export async function recoverRunnerCompletions(): Promise<void> {
    await withQueueLock("queue", () => runnersRepository.reclaim(new Date().toISOString(), [...activeCompletions], true));
    await maintainRunnerQueue();
}

export function startRunnerLeaseMonitor(): void {
    if (monitor) return;
    monitor = setInterval(() => {
        void maintainRunnerQueue()
            .catch((error: unknown) => logger.error("could not reclaim runner leases", { error }));
    }, 1000);
    monitor.unref();
}

export function stopRunnerLeaseMonitor(): void {
    if (monitor) clearInterval(monitor);
    monitor = undefined;
}
