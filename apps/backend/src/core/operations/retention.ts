import fs from "node:fs/promises";
import path from "node:path";

import { readEvidenceManifest } from "@specbook/runtime/evidence";
import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "../../infra/db/client";
import { inboxItems, jobs, runs } from "../../infra/db/schema";
import { logger } from "../../infra/logger";
import { settingsRepository } from "../../infra/repositories/settings";
import { removeInactiveBrowserData } from "../browser/sessions";
import { writeProtectedFile } from "../credentials/files";
import { ACTIVE_JOB_STATUSES } from "../jobs/shared";
import { runBatchesDir, runsDir, storageRoot } from "../paths";
import { getRunBatch } from "../runner/batch";
import { areSpecsLocked, withSpecLock } from "../specs/lifecycle";
import { withFileQueue } from "./file-queue";
import type { RetentionCleanup, RetentionSettings } from "./schemas";

const entries = async function entries(directory: string) {
  return await fs
    .readdir(directory, { withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
};

const protectedRuns = async function protectedRuns(): Promise<Set<string>> {
  const [decisions, activeJobs] = await Promise.all([
    db.select().from(inboxItems).where(eq(inboxItems.status, "pending")),
    db
      .select()
      .from(jobs)
      .where(inArray(jobs.status, [...ACTIVE_JOB_STATUSES])),
  ]);
  const ids = new Set(
    activeJobs.flatMap((job) => (job.runId ? [job.runId] : []))
  );
  const decisionJobs = new Set(decisions.map((item) => item.jobId));
  if (decisionJobs.size) {
    for (const job of await db
      .select()
      .from(jobs)
      .where(inArray(jobs.id, [...decisionJobs]))) {
      if (job.runId) {
        ids.add(job.runId);
      }
    }
  }
  for (const item of decisions) {
    const references =
      JSON.stringify(item.payload).match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu
      ) ?? [];
    for (const id of references) {
      ids.add(id);
    }
  }
  return ids;
};

const removeVideos = async function removeVideos(
  directory: string,
  cutoff: number
): Promise<number> {
  let removed = 0;
  for (const entry of await entries(directory)) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
      removed += await removeVideos(file, cutoff);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".webm") &&
      // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
      (await (async () => {
        const awaitedValue2511 = await fs.stat(file);
        return awaitedValue2511.mtimeMs;
      })()) < cutoff
    ) {
      // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
      await fs.rm(file);
      removed += 1;
    }
  }
  if (removed && path.basename(directory) === "report") {
    await fs.rm(directory, { recursive: true, force: true });
  } else if (removed) {
    const manifestPath = path.join(directory, "evidence.json");
    const manifest = await readEvidenceManifest(directory);
    if (manifest.video) {
      const file = path.resolve(directory, manifest.video);
      const exists =
        file.startsWith(`${path.resolve(directory)}${path.sep}`) &&
        // oxlint-disable-next-line promise/prefer-catch -- Only handle rejection of the original operation; errors in the success handler must still propagate.
        (await fs.lstat(file).then(
          (stat) => stat.isFile(),
          () => false
        ));
      if (!exists) {
        await writeProtectedFile(
          manifestPath,
          JSON.stringify({ ...manifest, video: null })
        );
      }
    }
  }
  return removed;
};

const pruneMetrics = async function pruneMetrics(
  file: string,
  cutoff: number
): Promise<number> {
  return await withFileQueue(file, async () => {
    const text = await fs
      .readFile(file, "utf-8")
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          return "";
        }
        throw error;
      });
    let removed = 0;
    const kept = text.split("\n").filter((line) => {
      if (!line) {
        return false;
      }
      try {
        const row = JSON.parse(line) as { at?: string; startedAt?: string };
        if (Date.parse(row.at ?? row.startedAt ?? "") < cutoff) {
          removed += 1;
          return false;
        }
      } catch {
        /* Cleanup is best effort after the operation has completed or failed. */
      }
      return true;
    });
    if (removed) {
      await writeProtectedFile(file, kept.length ? `${kept.join("\n")}\n` : "");
    }
    return removed;
  });
};

// oxlint-disable-next-line complexity -- Keep the retention decision tree together so state transitions and error ordering remain explicit.
const clean = async function clean(
  settings: RetentionSettings,
  now: number
): Promise<RetentionCleanup> {
  const result: RetentionCleanup = {
    completedAt: new Date(now).toISOString(),
    removedRuns: 0,
    removedVideos: 0,
    removedBatches: 0,
    removedMetrics: 0,
    removedBrowserProfiles: 0,
  };
  const rows = await db
    .select()
    .from(runs)
    .orderBy(desc(runs.startedAt), desc(runs.id));
  const batches = [];
  for (const entry of await entries(runBatchesDir)) {
    if (entry.isDirectory() && uuid.test(entry.name)) {
      // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
      const batch = await getRunBatch(entry.name);
      if (batch) {
        batches.push(batch);
      }
    }
  }
  const protectedIds = await protectedRuns();
  const perSpec = new Map<string, number>();
  const kept = new Set<string>();
  for (const run of rows) {
    const count = (perSpec.get(run.specId) ?? 0) + 1;
    perSpec.set(run.specId, count);
    if (
      count <= settings.runsPerSpec ||
      Date.parse(run.startedAt) >= now - settings.runDays * DAY_MS ||
      run.status === "running" ||
      run.automationPending ||
      protectedIds.has(run.id)
    ) {
      kept.add(run.id);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const run of rows) {
      if (run.retryOf && (kept.has(run.id) || kept.has(run.retryOf))) {
        if (!kept.has(run.id) || !kept.has(run.retryOf)) {
          changed = true;
        }
        kept.add(run.id);
        kept.add(run.retryOf);
      }
    }
    for (const batch of batches) {
      if (
        batch.status === "running" ||
        Date.parse(batch.startedAt) >= now - settings.batchDays * DAY_MS ||
        batch.specs.some((spec) => kept.has(spec.runId))
      ) {
        for (const spec of batch.specs) {
          if (!kept.has(spec.runId)) {
            kept.add(spec.runId);
            changed = true;
          }
        }
      }
    }
  }
  for (const run of rows) {
    if (areSpecsLocked([run.specId])) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
    await withSpecLock(run.specId, async () => {
      const currentProtection = await protectedRuns();
      if (
        currentProtection.has(run.id) ||
        run.status === "running" ||
        run.automationPending
      ) {
        return;
      }
      const directory = path.join(runsDir, run.id);
      if (kept.has(run.id)) {
        result.removedVideos += await removeVideos(
          directory,
          now - settings.videoDays * DAY_MS
        );
      } else {
        await db
          .delete(runs)
          .where(and(eq(runs.id, run.id), eq(runs.status, run.status)));
        await fs.rm(directory, { recursive: true, force: true });
        result.removedRuns += 1;
      }
    });
  }
  const remaining = new Set(
    await (async () => {
      const awaitedValue6965 = await db.select({ id: runs.id }).from(runs);
      return awaitedValue6965.map((run) => run.id);
    })()
  );
  for (const batch of batches) {
    if (
      batch.status === "running" ||
      batch.specs.some((spec) => areSpecsLocked([spec.specId]))
    ) {
      continue;
    }
    const directory = path.join(runBatchesDir, batch.id);
    if (
      Date.parse(batch.startedAt) < now - settings.batchDays * DAY_MS &&
      batch.specs.every((spec) => !remaining.has(spec.runId))
    ) {
      // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
      await fs.rm(directory, { recursive: true, force: true });
      result.removedBatches += 1;
    } else if (batch.specs.every((spec) => !protectedIds.has(spec.runId))) {
      // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
      result.removedVideos += await removeVideos(
        directory,
        now - settings.videoDays * DAY_MS
      );
    }
  }
  for (const name of ["chat-turns.jsonl", "agent-events.jsonl"]) {
    // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
    result.removedMetrics += await pruneMetrics(
      path.join(storageRoot, "metrics", name),
      now - settings.metricDays * DAY_MS
    );
  }
  for (const entry of await entries(
    path.join(storageRoot, "chat", "browser")
  )) {
    if (
      entry.isDirectory() &&
      uuid.test(entry.name) &&
      // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
      (await removeInactiveBrowserData(
        entry.name,
        now - settings.browserProfileDays * DAY_MS
      ))
    ) {
      result.removedBrowserProfiles += 1;
    }
  }
  await settingsRepository.recordRetentionCleanup(result);
  return result;
};

export const cleanupRetention = function cleanupRetention(
  now = Date.now()
): Promise<RetentionCleanup> {
  return (processing ??= settingsRepository
    .getRetention()
    .then(({ settings }) => clean(settings, now))
    .finally(() => {
      processing = null;
    }));
};

export const startRetentionMonitor = function startRetentionMonitor(): void {
  if (process.env.SPECBOOK_RETENTION_ENABLED === "false" || timer) {
    return;
  }
  timer = setInterval(
    () =>
      // oxlint-disable-next-line promise/prefer-await-to-callbacks -- This API requires an event or callback handler.
      cleanupRetention().catch((error) =>
        logger.warn("retention cleanup failed", { error })
      ),
    60 * 60_000
  );
  timer.unref();
};

export const stopRetentionMonitor =
  async function stopRetentionMonitor(): Promise<void> {
    clearInterval(timer);
    timer = undefined;
    await processing?.catch(() => {
      /* No action is needed until this callback is replaced or invoked by its owner. */
    });
  };

const DAY_MS = 86_400_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
let timer: NodeJS.Timeout | undefined;
let processing: Promise<RetentionCleanup> | null = null;
