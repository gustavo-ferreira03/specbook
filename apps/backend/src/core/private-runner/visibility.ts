import { eq, inArray } from "drizzle-orm";
import type { RunnerQueueEntry } from "@specbook/runtime/runner-protocol";
import { db } from "../../infra/db/client";
import { environments, projects, runs } from "../../infra/db/schema";
import { runnersRepository } from "../../infra/repositories/runners";
import type { Run } from "../../infra/repositories/runs";
import { hasTunnel, pendingTunnelRunIds, tunnelQueueEntries } from "../tunnel/registry";
import { maintainRunnerQueue } from "./queue";

export async function runnerQueueSnapshot() {
    await maintainRunnerQueue();
    const [configured, jobs, runners, instances] = await Promise.all([
        db.select({ environment: environments, projectName: projects.name }).from(environments)
            .innerJoin(projects, eq(projects.id, environments.projectId)),
        runnersRepository.pending(),
        runnersRepository.list(),
        runnersRepository.instances(),
    ]);
    const tunnelRunIds = new Set(pendingTunnelRunIds());
    const runIds = [...jobs.flatMap((job) => job.payload.specs.map((spec) => spec.runId)), ...tunnelRunIds];
    const pendingRuns = runIds.length ? await db.select({ id: runs.id, environment: runs.environment }).from(runs).where(inArray(runs.id, runIds)) : [];
    const byRun = new Map(pendingRuns.map((run) => [run.id, run.environment]));
    const entries = new Map<string, RunnerQueueEntry>();
    const keyOf = (projectId: string, environmentId: string, group: string | null) => JSON.stringify([projectId, environmentId, group]);
    for (const { environment, projectName } of configured) {
        if (environment.executor === "server") continue;
        entries.set(keyOf(environment.projectId, environment.id, environment.runnerGroup), {
            projectId: environment.projectId, projectName, environmentId: environment.id, environmentName: environment.name,
            group: environment.runnerGroup, executor: environment.executor, queued: 0, oldestQueuedAt: null, oldestWaitMs: 0,
            onlineRunners: environment.executor === "tunnel" && hasTunnel(environment.id) ? 1 : 0, busyRunners: 0, reason: null,
        });
    }
    const batchQueues = new Map<string, RunnerQueueEntry>();
    const runQueues = new Map<string, RunnerQueueEntry>();
    for (const job of jobs) {
        if (job.status !== "queued") continue;
        const environment = byRun.get(job.payload.specs[0].runId);
        if (!environment) continue;
        const key = keyOf(job.projectId, environment.id, job.group);
        let entry = entries.get(key);
        if (!entry) {
            entry = { projectId: job.projectId, projectName: configured.find((row) => row.environment.projectId === job.projectId)?.projectName ?? "Project",
                environmentId: environment.id, environmentName: environment.name, group: job.group, executor: "runner", queued: 0,
                oldestQueuedAt: null, oldestWaitMs: 0, onlineRunners: 0, busyRunners: 0, reason: null };
            entries.set(key, entry);
        }
        entry.queued += job.payload.specs.length;
        if (!entry.oldestQueuedAt || job.createdAt < entry.oldestQueuedAt) entry.oldestQueuedAt = job.createdAt;
        batchQueues.set(job.batchId, entry);
        for (const spec of job.payload.specs) runQueues.set(spec.runId, entry);
    }
    for (const entry of entries.values()) {
        if (entry.executor === "tunnel") continue;
        const online = instances.filter((instance) => instance.mode === "runner" && !instance.disconnectedAt && Date.now() - Date.parse(instance.lastSeenAt) < 90_000
            && runners.some((runner) => runner.id === instance.runnerId && runner.group === entry.group
                && (!runner.projectIds || runner.projectIds.includes(entry.projectId))));
        entry.onlineRunners = online.length;
        entry.busyRunners = online.filter((instance) => jobs.filter((job) => (job.status === "leased" || job.status === "completing") && job.runnerInstanceId === instance.id).length >= instance.concurrency).length;
        entry.oldestWaitMs = entry.oldestQueuedAt ? Math.max(0, Date.now() - Date.parse(entry.oldestQueuedAt)) : 0;
        if (entry.queued) {
            entry.reason = !online.length ? `No runner online${entry.group ? ` in group ${entry.group}` : ""}.`
                : entry.busyRunners === online.length ? "All runners busy." : "Waiting for a runner to claim work.";
            const retry = jobs.find((job) => job.status === "queued" && job.projectId === entry.projectId && job.group === entry.group
                && byRun.get(job.payload.specs[0].runId)?.id === entry.environmentId && job.lastFailure);
            if (retry) entry.reason = `${retry.lastFailure} ${entry.reason}`;
        }
    }
    for (const queue of await tunnelQueueEntries()) {
        entries.set(keyOf(queue.projectId, queue.environmentId, queue.group), queue);
        for (const id of tunnelRunIds) if (byRun.get(id)?.id === queue.environmentId) runQueues.set(id, queue);
    }
    return { queues: [...entries.values()], batchQueues, runQueues };
}

export async function visibleRuns<T extends Run>(runs: T[]): Promise<(T & { queue: RunnerQueueEntry | null })[]> {
    if (!runs.some((run) => run.status === "running" && run.environment?.executor !== "server")) return runs.map((run) => ({ ...run, queue: null }));
    const { runQueues } = await runnerQueueSnapshot();
    return runs.map((run) => ({ ...run, queue: run.status === "running" ? runQueues.get(run.id) ?? null : null }));
}
