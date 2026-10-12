import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { HTTPException } from "hono/http-exception";
import { runnerPayloadSchema, type RunnerCompletion, type RunnerPayload } from "@specbook/runtime/runner-protocol";
import { runnersRepository, type RunnerJob, type RunnerToken } from "../../infra/repositories/runners";
import { runsDir } from "../paths";
import { createKeyedLock } from "../operations/keyed-lock";
import { logger } from "../../infra/logger";

const withQueueLock = createKeyedLock().run;
const events = new EventEmitter();
events.setMaxListeners(0);
let monitor: NodeJS.Timeout | undefined;

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

function waitForWork(signal: AbortSignal, milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
        const finish = () => { clearTimeout(timer); events.off("work", finish); signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, milliseconds);
        events.once("work", finish);
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
    });
}

export async function claimRunnerWork(runner: RunnerToken, signal: AbortSignal): Promise<RunnerJob | null> {
    const deadline = Date.now() + 25_000;
    while (!signal.aborted) {
        const job = await withQueueLock("queue", async () => {
            const current = await runnersRepository.get(runner.id);
            if (!current) throw new HTTPException(401, { message: "Runner token was revoked" });
            return runnersRepository.claim(current, runnerLeaseMs());
        });
        if (job) return job;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await waitForWork(signal, Math.min(1000, remaining));
    }
    await runnersRepository.touch(runner.id);
    return null;
}

function leaseMatches(job: RunnerJob | null, runnerId: string, leaseId: string): job is RunnerJob {
    return Boolean(job && job.runnerId === runnerId && job.leaseId === leaseId);
}

function requireLease(job: RunnerJob | null, runnerId: string, leaseId: string): RunnerJob {
    if (!leaseMatches(job, runnerId, leaseId) || job.status !== "leased" || !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= Date.now()) {
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

export async function releaseRunnerWork(jobId: string, runnerId: string, leaseId: string): Promise<void> {
    await withQueueLock("queue", async () => {
        if (!await runnersRepository.get(runnerId)) throw new HTTPException(401, { message: "Runner token was revoked" });
        requireLease(await runnersRepository.job(jobId), runnerId, leaseId);
        await runnersRepository.release(jobId, leaseId, runnerId);
    });
    events.emit("work");
}

export async function completeRunnerWork(jobId: string, runnerId: string, completion: RunnerCompletion): Promise<void> {
    await withQueueLock("queue", async () => {
        if (!await runnersRepository.get(runnerId)) throw new HTTPException(401, { message: "Runner token was revoked" });
        const row = await runnersRepository.job(jobId);
        if (leaseMatches(row, runnerId, completion.leaseId) && row.status === "completed") return;
        const job = requireLease(row, runnerId, completion.leaseId);
        const expected = new Set(job.payload.specs.map((spec) => spec.runId));
        const reported = new Set(completion.results.map((result) => result.runId));
        if (reported.size !== completion.results.length || expected.size !== reported.size || [...reported].some((id) => !expected.has(id))) {
            throw new HTTPException(400, { message: "Report one result for each Spec in the runner work" });
        }
        const staging = path.join(runsDir, `.runner-upload-${job.id}-${completion.leaseId}`);
        let bytes = 0;
        try {
            await fs.rm(staging, { recursive: true, force: true });
            for (const result of completion.results) {
                const paths = new Set<string>();
                for (const artifact of result.artifacts) {
                    if (paths.has(artifact.path)) throw new HTTPException(400, { message: "Artifact paths must be unique for each run" });
                    paths.add(artifact.path);
                    // The server keeps the immutable Spec snapshot prepared before dispatch.
                    if (artifact.path === "spec.ts" || artifact.path === "spec.yml") continue;
                    const content = Buffer.from(artifact.content, "base64");
                    bytes += content.length;
                    if (bytes > 64 * 1024 * 1024) throw new HTTPException(413, { message: "Runner artifacts exceed the upload limit" });
                    const file = path.join(staging, result.runId, artifact.path);
                    await fs.mkdir(path.dirname(file), { recursive: true });
                    await fs.writeFile(file, content);
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
                    const destination = path.join(target, artifact.path);
                    await fs.mkdir(path.dirname(destination), { recursive: true });
                    await fs.rename(path.join(staging, result.runId, artifact.path), destination);
                }
            }
            const { finishRunnerBatch } = await import("../runner/batch");
            await finishRunnerBatch(job.batchId, completion);
            await runnersRepository.complete(job.id);
        } finally {
            await fs.rm(staging, { recursive: true, force: true });
        }
    });
}

export async function revokeRunnerToken(id: string): Promise<boolean> {
    const revoked = await withQueueLock("queue", () => runnersRepository.revoke(id));
    events.emit("work");
    return revoked;
}

export async function cancelRunnerBatch(batchId: string): Promise<boolean> {
    return withQueueLock("queue", () => runnersRepository.cancelBatch(batchId));
}

export function startRunnerLeaseMonitor(): void {
    if (monitor) return;
    monitor = setInterval(() => {
        void withQueueLock("queue", () => runnersRepository.reclaim()).then(() => events.emit("work"))
            .catch((error: unknown) => logger.error("could not reclaim runner leases", { error }));
    }, 1000);
    monitor.unref();
}

export function stopRunnerLeaseMonitor(): void {
    if (monitor) clearInterval(monitor);
    monitor = undefined;
}
