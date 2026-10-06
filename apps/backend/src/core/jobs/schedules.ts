import { z } from "zod";
import { logger } from "../../infra/logger";
import { projectsRepository } from "../../infra/repositories/projects";
import { runsRepository } from "../../infra/repositories/runs";
import { schedulesRepository, type ProjectAutomation } from "../../infra/repositories/schedules";
import { specsRepository } from "../../infra/repositories/specs";
import { NetworkTargetError, resolveTarget } from "../network/targets";
import { postWebhook } from "../network/webhook";
import { decryptSecret } from "../credentials/crypto";
import { projectSecretScrubber } from "../credentials/scrub";
import { getRunBatch, startSpecBatch, type RunBatch } from "../runner/batch";
import { areSpecsLocked } from "../specs/lifecycle";
import { recordScheduledPrerequisite } from "../steward/engine";
import { isAgentPaused } from "./pause";

interface CronField {
    values: Set<number>;
    wildcard: boolean;
}

function cronField(source: string, min: number, max: number, sunday = false): CronField {
    const values = new Set<number>();
    for (const part of source.split(",")) {
        const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
        if (!match) throw new Error("Use numbers, *, comma lists, ranges and /steps in cron fields");
        const step = Number(match[2] ?? 1);
        if (!Number.isSafeInteger(step) || step < 1 || step > max - min + 1) throw new Error("Invalid cron step");
        const range = match[1] === "*" ? [min, max] : match[1]!.split("-").map(Number);
        const start = range[0]!;
        const end = range[1] ?? (match[2] ? max : start);
        if (start < min || end > max || start > end) throw new Error(`Cron values must be between ${min} and ${max}`);
        for (let value = start; value <= end; value += step) values.add(sunday && value === 7 ? 0 : value);
    }
    return { values, wildcard: source.includes("*") };
}

/** Five numeric cron fields, evaluated in UTC. Missed occurrences are coalesced by the monitor. */
export function nextCronAt(cron: string, after = new Date()): string {
    if (cron.length > 120) throw new Error("Cron expression is too long");
    const fields = cron.trim().split(/\s+/);
    if (fields.length !== 5) throw new Error("Cron needs five fields: minute hour day month weekday (UTC)");
    const [minute, hour, day, month, weekday] = [
        cronField(fields[0]!, 0, 59), cronField(fields[1]!, 0, 23), cronField(fields[2]!, 1, 31),
        cronField(fields[3]!, 1, 12), cronField(fields[4]!, 0, 7, true),
    ] as const;
    const next = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
    const end = next.getUTCFullYear() + 8;
    while (next.getUTCFullYear() < end) {
        const dayMatches = day.values.has(next.getUTCDate());
        const weekdayMatches = weekday.values.has(next.getUTCDay());
        const dateMatches = day.wildcard || weekday.wildcard ? dayMatches && weekdayMatches : dayMatches || weekdayMatches;
        if (!month.values.has(next.getUTCMonth() + 1) || !dateMatches) {
            next.setUTCDate(next.getUTCDate() + 1);
            next.setUTCHours(0, 0, 0, 0);
        } else if (!hour.values.has(next.getUTCHours())) {
            next.setUTCHours(next.getUTCHours() + 1, 0, 0, 0);
        } else if (!minute.values.has(next.getUTCMinutes())) {
            next.setUTCMinutes(next.getUTCMinutes() + 1, 0, 0);
        } else {
            return next.toISOString();
        }
    }
    throw new Error("Cron has no matching date in the next eight years");
}

const cronSchema = z.string().trim().min(1).max(120).superRefine((value, context) => {
    try { nextCronAt(value); } catch (error) {
        context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid cron" });
    }
});
const webhookSchema = z.string().trim().max(4000).url().refine((value) => {
    try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash;
    } catch { return false; }
}, "Use an HTTP(S) webhook URL without username, password or fragment");

export const automationSettingsSchema = z.object({
    cron: cronSchema.nullable().optional(),
    specIds: z.array(z.string().uuid()).max(1000).optional(),
    healFailures: z.boolean().optional(),
    webhookUrl: webhookSchema.nullable().optional(),
    allowPrivateWebhook: z.boolean().optional(),
}).strict();

const locks = new Map<string, Promise<unknown>>();
let processing = false;
let stopped = false;
let timer: ReturnType<typeof setInterval> | undefined;
const deliveries = new Set<AbortController>();

async function withAutomationLock<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = locks.get(projectId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    locks.set(projectId, current);
    try { return await current; } finally {
        if (locks.get(projectId) === current) locks.delete(projectId);
    }
}

export function publicAutomation(projectId: string, row: ProjectAutomation | null) {
    return {
        projectId, cron: row?.cron ?? null, specIds: row?.specIds ?? [], healFailures: row?.healFailures ?? true,
        allowPrivateWebhook: row?.allowPrivateWebhook ?? false,
        webhookConfigured: !!row?.webhookUrl, webhookHost: row?.webhookUrl ? new URL(row.webhookUrl).host : null,
        nextRunAt: row?.nextRunAt ?? null, lastBatchId: row?.lastBatchId ?? null,
        lastBatchStatus: row?.lastBatchStatus ?? null, lastError: row?.lastError ?? null, updatedAt: row?.updatedAt ?? null,
    };
}

export async function updateAutomation(projectId: string, input: unknown) {
    const patch = automationSettingsSchema.parse(input);
    return withAutomationLock(projectId, async () => {
        if (!await projectsRepository.getProject(projectId)) throw new Error("Project not found");
        if (patch.specIds) {
            const available = new Set((await specsRepository.listSpecs(projectId)).map((spec) => spec.id));
            if (patch.specIds.some((id) => !available.has(id))) throw new Error("Every selected Spec must belong to this project");
        }
        const previous = await schedulesRepository.get(projectId);
        const cron = patch.cron === undefined ? previous?.cron ?? null : patch.cron;
        const webhookUrl = patch.webhookUrl === undefined ? previous?.webhookUrl ?? null : patch.webhookUrl;
        const allowPrivateWebhook = patch.allowPrivateWebhook ?? previous?.allowPrivateWebhook ?? false;
        if (webhookUrl && (patch.webhookUrl !== undefined || patch.allowPrivateWebhook !== undefined)) await resolveTarget(webhookUrl, allowPrivateWebhook);
        const row = await schedulesRepository.save(projectId, {
            cron, specIds: patch.specIds ? [...new Set(patch.specIds)] : previous?.specIds ?? [],
            healFailures: patch.healFailures ?? previous?.healFailures ?? true,
            webhookUrl, allowPrivateWebhook,
            nextRunAt: cron ? cron !== previous?.cron || !previous?.nextRunAt ? nextCronAt(cron) : previous.nextRunAt : null,
        });
        if (patch.webhookUrl !== undefined && patch.webhookUrl !== previous?.webhookUrl) await schedulesRepository.cancelPendingNotifications(projectId);
        return publicAutomation(projectId, row);
    });
}

async function recordBatch(automation: ProjectAutomation, batch: RunBatch): Promise<void> {
    let notification: { webhookUrl: string; payload: Record<string, unknown> } | null = null;
    if (automation.webhookUrl) {
        const project = await projectsRepository.getProject(automation.projectId);
        if (!project) return;
        const scrub = await projectSecretScrubber(project.id);
        const name = scrub(project.name).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        notification = { webhookUrl: automation.webhookUrl, payload: {
            text: `Specbook: ${name} — scheduled run ${batch.status} (${batch.specs.length} Specs)`,
            event: "run_batch.status_changed", eventId: `${batch.id}:${batch.status}`,
            projectId: project.id, batchId: batch.id, status: batch.status, total: batch.specs.length,
            passed: batch.specs.filter((spec) => spec.status === "passed").length,
            failed: batch.specs.filter((spec) => spec.status === "failed").length,
            errors: batch.specs.filter((spec) => spec.status === "error").length,
        } };
    }
    await schedulesRepository.recordBatch(automation.projectId, batch.id, batch.status, notification);
}

export async function recordScheduledBatch(batch: RunBatch): Promise<void> {
    const automation = await schedulesRepository.get(batch.projectId);
    if (automation) await recordBatch(automation, batch);
}

async function scheduleProject(projectId: string, at: Date): Promise<void> {
    await withAutomationLock(projectId, async () => {
        const automation = await schedulesRepository.get(projectId);
        if (!automation || stopped) return;
        if (automation.lastBatchId) {
            const batch = await getRunBatch(automation.lastBatchId);
            if (batch && batch.status !== automation.lastBatchStatus) await recordBatch(automation, batch);
            if (batch?.status === "running") return;
            if (!batch && automation.lastBatchStatus === "running") {
                await schedulesRepository.update(projectId, { lastBatchStatus: "error", lastError: "The scheduled batch is no longer available" });
            }
        }
        if (!automation.cron || !automation.nextRunAt || Date.parse(automation.nextRunAt) > at.getTime() || await isAgentPaused(projectId)) return;
        const available = await specsRepository.listSpecs(projectId);
        const selected = automation.specIds.length ? available.filter((spec) => automation.specIds.includes(spec.id)) : available;
        const runnable = selected.filter((spec) => spec.status !== "invalid");
        const ids = runnable.map((spec) => spec.id);
        if (areSpecsLocked(ids) || await runsRepository.hasRunningRuns(ids)) return;
        const nextRunAt = nextCronAt(automation.cron, at);
        if (!await schedulesRepository.claimDue(projectId, automation.nextRunAt, nextRunAt)) return;
        try {
            if (automation.specIds.length && runnable.length !== automation.specIds.length) {
                throw new Error("Some selected Specs are missing or invalid. Review the selected Specs before the next scheduled run.");
            }
            if (!ids.length) throw new Error("There are no runnable Specs. Add a Spec or resolve the invalid Specs before the next scheduled run.");
            await startSpecBatch(projectId, ids, "Scheduled run", {
                trigger: "schedule",
                healFailures: automation.healFailures,
                onPrepared: async (batch) => {
                    if (stopped || await isAgentPaused(projectId)) throw new Error("Scheduling stopped before execution");
                    await recordBatch(automation, batch);
                },
            });
        } catch (error) {
            if (stopped || !await projectsRepository.getProject(projectId)) return;
            const scrub = await projectSecretScrubber(projectId);
            const message = scrub(error instanceof Error ? error.message : String(error)).slice(0, 4000);
            await schedulesRepository.update(projectId, { lastError: message });
            await recordScheduledPrerequisite(projectId, automation.specIds.length ? automation.specIds : ids, automation.nextRunAt, message, automation.healFailures);
        }
    });
}

export async function deliverWebhookNotifications(at = new Date()): Promise<void> {
    const pending = await schedulesRepository.pendingNotifications(at.toISOString());
    await Promise.all(pending.map(async (row) => {
        if (stopped) return;
        const claimed = await schedulesRepository.claimNotification(row, at.toISOString());
        if (!claimed) return;
        const controller = new AbortController();
        deliveries.add(controller);
        const timeout = setTimeout(() => controller.abort(), 5000);
        let error: string | null = null;
        try {
            const automation = await schedulesRepository.get(claimed.projectId);
            const status = await postWebhook(decryptSecret(claimed.webhookUrl), claimed.payload, {
                allowPrivate: automation?.allowPrivateWebhook ?? false, signal: controller.signal,
            });
            if (status < 200 || status >= 300) error = `Webhook returned HTTP ${status}`;
        } catch (caught) {
            error = caught instanceof NetworkTargetError ? caught.message : "Webhook request failed or timed out";
        } finally {
            clearTimeout(timeout);
            deliveries.delete(controller);
        }
        await schedulesRepository.finishNotification(claimed, error, at.toISOString());
    }));
}

export async function processSchedules(at = new Date()): Promise<void> {
    if (processing || stopped) return;
    processing = true;
    try {
        for (const row of await schedulesRepository.list()) {
            if (stopped) break;
            await scheduleProject(row.projectId, at).catch((error) => logger.error("scheduled run failed", { projectId: row.projectId, error }));
        }
        await deliverWebhookNotifications(new Date(Math.max(at.getTime(), Date.now())));
    } finally {
        processing = false;
    }
}

export function startScheduleMonitor(): void {
    stopped = false;
    clearInterval(timer);
    timer = setInterval(() => void processSchedules().catch((error) => logger.error("schedule monitor failed", { error })), 5000);
    timer.unref();
    void processSchedules().catch((error) => logger.error("schedule monitor failed", { error }));
}

export function stopScheduleMonitor(): void {
    stopped = true;
    clearInterval(timer);
    for (const controller of deliveries) controller.abort();
}
