import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../infra/db/client";
import { inboxItems, jobs, runs } from "../../infra/db/schema";
import { logger } from "../../infra/logger";
import { settingsRepository } from "../../infra/repositories/settings";
import { removeInactiveBrowserData } from "../browser/sessions";
import { writeProtectedFile } from "../credentials/files";
import { runBatchesDir, runsDir, storageRoot } from "../paths";
import { getRunBatch } from "../runner/batch";
import { areSpecsLocked, withSpecLock } from "../specs/lifecycle";
import { withFileQueue } from "./file-queue";
import type { RetentionCleanup, RetentionSettings } from "./schemas";

const DAY_MS = 86_400_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let timer: NodeJS.Timeout | undefined;
let processing: Promise<RetentionCleanup> | null = null;

async function entries(directory: string) {
    return fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
    });
}

async function protectedRuns(): Promise<Set<string>> {
    const [decisions, activeJobs] = await Promise.all([
        db.select().from(inboxItems).where(eq(inboxItems.status, "pending")),
        db.select().from(jobs).where(inArray(jobs.status, ["queued", "running", "paused", "blocked", "stalled"])),
    ]);
    const ids = new Set(activeJobs.flatMap((job) => job.runId ? [job.runId] : []));
    const decisionJobs = new Set(decisions.map((item) => item.jobId));
    if (decisionJobs.size) {
        for (const job of await db.select().from(jobs).where(inArray(jobs.id, [...decisionJobs]))) if (job.runId) ids.add(job.runId);
    }
    for (const item of decisions) {
        const references = JSON.stringify(item.payload).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
        for (const id of references) ids.add(id);
    }
    return ids;
}

async function removeVideos(directory: string, cutoff: number): Promise<number> {
    let removed = 0;
    for (const entry of await entries(directory)) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) removed += await removeVideos(file, cutoff);
        else if (entry.isFile() && entry.name.endsWith(".webm") && (await fs.stat(file)).mtimeMs < cutoff) {
            await fs.rm(file); removed++;
        }
    }
    if (removed && path.basename(directory) === "report") {
        // Playwright embeds attachment links in its report archive. Expire the report
        // together with its video rather than leaving a downloadable broken report.
        await fs.rm(directory, { recursive: true, force: true });
    } else if (removed) {
        const manifestPath = path.join(directory, "evidence.json");
        const source = await fs.readFile(manifestPath, "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
        });
        if (source) {
            const manifest = JSON.parse(source) as { video?: string | null };
            if (manifest.video) {
                const file = path.resolve(directory, manifest.video);
                const exists = file.startsWith(`${path.resolve(directory)}${path.sep}`) && await fs.lstat(file).then((stat) => stat.isFile(), () => false);
                if (!exists) await writeProtectedFile(manifestPath, JSON.stringify({ ...manifest, video: null }));
            }
        }
    }
    return removed;
}

async function pruneMetrics(file: string, cutoff: number): Promise<number> {
    return withFileQueue(file, async () => {
        const text = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return "";
            throw error;
        });
        let removed = 0;
        const kept = text.split("\n").filter((line) => {
            if (!line) return false;
            try {
                const row = JSON.parse(line) as { at?: string; startedAt?: string };
                if (Date.parse(row.at ?? row.startedAt ?? "") < cutoff) { removed++; return false; }
            } catch {}
            return true;
        });
        if (removed) await writeProtectedFile(file, kept.length ? `${kept.join("\n")}\n` : "");
        return removed;
    });
}

async function clean(settings: RetentionSettings, now: number): Promise<RetentionCleanup> {
    const result: RetentionCleanup = { completedAt: new Date(now).toISOString(), removedRuns: 0, removedVideos: 0, removedBatches: 0, removedMetrics: 0, removedBrowserProfiles: 0 };
    const rows = await db.select().from(runs).orderBy(desc(runs.startedAt), desc(runs.id));
    const batches = [];
    for (const entry of await entries(runBatchesDir)) {
        if (entry.isDirectory() && uuid.test(entry.name)) {
            const batch = await getRunBatch(entry.name);
            if (batch) batches.push(batch);
        }
    }
    const protectedIds = await protectedRuns();
    const perSpec = new Map<string, number>();
    const kept = new Set<string>();
    for (const run of rows) {
        const count = (perSpec.get(run.specId) ?? 0) + 1;
        perSpec.set(run.specId, count);
        if (count <= settings.runsPerSpec || Date.parse(run.startedAt) >= now - settings.runDays * DAY_MS
            || run.status === "running" || run.automationPending || protectedIds.has(run.id)) kept.add(run.id);
    }
    // Keep retry pairs and complete retained batches, so CI can still calculate
    // quality gates from their original attempts rather than missing run records.
    let changed = true;
    while (changed) {
        changed = false;
        for (const run of rows) if (run.retryOf && (kept.has(run.id) || kept.has(run.retryOf))) {
            if (!kept.has(run.id) || !kept.has(run.retryOf)) changed = true;
            kept.add(run.id); kept.add(run.retryOf);
        }
        for (const batch of batches) if (batch.status === "running" || Date.parse(batch.startedAt) >= now - settings.batchDays * DAY_MS || batch.specs.some((spec) => kept.has(spec.runId))) {
            for (const spec of batch.specs) if (!kept.has(spec.runId)) { kept.add(spec.runId); changed = true; }
        }
    }
    for (const run of rows) {
        if (areSpecsLocked([run.specId])) continue;
        await withSpecLock(run.specId, async () => {
            const currentProtection = await protectedRuns();
            if (currentProtection.has(run.id) || run.status === "running" || run.automationPending) return;
            const directory = path.join(runsDir, run.id);
            if (!kept.has(run.id)) {
                await db.delete(runs).where(and(eq(runs.id, run.id), eq(runs.status, run.status)));
                await fs.rm(directory, { recursive: true, force: true });
                result.removedRuns++;
            } else result.removedVideos += await removeVideos(directory, now - settings.videoDays * DAY_MS);
        });
    }
    const remaining = new Set((await db.select({ id: runs.id }).from(runs)).map((run) => run.id));
    for (const batch of batches) {
        if (batch.status === "running" || batch.specs.some((spec) => areSpecsLocked([spec.specId]))) continue;
        const directory = path.join(runBatchesDir, batch.id);
        if (Date.parse(batch.startedAt) < now - settings.batchDays * DAY_MS && batch.specs.every((spec) => !remaining.has(spec.runId))) {
            await fs.rm(directory, { recursive: true, force: true }); result.removedBatches++;
        } else if (batch.specs.every((spec) => !protectedIds.has(spec.runId))) result.removedVideos += await removeVideos(directory, now - settings.videoDays * DAY_MS);
    }
    for (const name of ["chat-turns.jsonl", "agent-events.jsonl"]) result.removedMetrics += await pruneMetrics(path.join(storageRoot, "metrics", name), now - settings.metricDays * DAY_MS);
    for (const entry of await entries(path.join(storageRoot, "chat", "browser"))) {
        if (entry.isDirectory() && uuid.test(entry.name) && await removeInactiveBrowserData(entry.name, now - settings.browserProfileDays * DAY_MS)) result.removedBrowserProfiles++;
    }
    await settingsRepository.recordRetentionCleanup(result);
    return result;
}

export function cleanupRetention(now = Date.now()): Promise<RetentionCleanup> {
    return processing ??= settingsRepository.getRetention().then(({ settings }) => clean(settings, now)).finally(() => { processing = null; });
}

export function startRetentionMonitor(): void {
    if (process.env.SPECBOOK_RETENTION_ENABLED === "false" || timer) return;
    timer = setInterval(() => void cleanupRetention().catch((error) => logger.warn("retention cleanup failed", { error })), 60 * 60_000);
    timer.unref();
}

export async function stopRetentionMonitor(): Promise<void> {
    clearInterval(timer); timer = undefined;
    await processing?.catch(() => undefined);
}
