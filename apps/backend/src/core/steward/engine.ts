import fs from "node:fs/promises";
import path from "node:path";
import { applyTrustedFixes } from "./approval";
import { runsRepository } from "../../infra/repositories/runs";
import { areSpecsLocked } from "../specs/lifecycle";
import { jobsRepository } from "../../infra/repositories/jobs";
import { projectsRepository } from "../../infra/repositories/projects";
import { projectContextsRepository } from "../../infra/repositories/project-contexts";
import { specsRepository } from "../../infra/repositories/specs";
import { stewardRepository, type Intent, type ProjectSignal } from "../../infra/repositories/steward";
import { logger } from "../../infra/logger";
import { createProjectScrubber } from "../credentials/scrub";
import { createChat } from "../chat/session-store";
import { enqueueJob } from "../jobs/worker";
import { jobLimitsSchema } from "../jobs/schemas";
import { canRunAgentJob, isAgentPaused } from "../jobs/pause";
import { currentFailure, StaleTriageError } from "../jobs/triage";
import { runsDir } from "../paths";
import { markdownHashOf } from "../repo/writer";
import { retryStalledJob } from "../jobs/retry";
import { getRunBatch, startSpecBatch } from "../runner/batch";
import { collectProjectSignals, fingerprint, runSignalForIntent, runTriggerForIntent } from "./signals";
import { stewardIntentSchema, type StewardIntent } from "./schemas";

const locks = new Map<string, Promise<unknown>>();
let stopped = false;
let timer: ReturnType<typeof setInterval> | undefined;
let processing = false;
class IntentDeferred extends Error {}

export async function withProjectLock<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = locks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    locks.set(id, current);
    try { return await current; } finally { if (locks.get(id) === current) locks.delete(id); }
}

async function intentFingerprint(projectId: string, intent: StewardIntent, source: "user" | "event", key: string): Promise<string> {
    const specs = await specsRepository.listSpecs(projectId);
    const run = intent.kind === "triage" && intent.runId ? await runsRepository.getRun(intent.runId) : null;
    if (run) {
        const spec = specs.find((spec) => spec.id === run.specId);
        if (!spec || intent.specIds?.some((id) => id !== spec.id)) throw new Error("The failed run must belong to the selected Spec in this project");
        const yaml = await fs.readFile(path.join(runsDir, run.id, "spec.yml"), "utf8").catch(() => null);
        const evidence = await fs.readFile(path.join(runsDir, run.id, "evidence.json"), "utf8").then((value) => JSON.parse(value) as { failedStep?: string }).catch(() => ({} as { failedStep?: string }));
        const reason = run.failReason ?? "";
        const failureKind = run.status === "error" || /net::|ECONN|ENOTFOUND|connection refused|session expired/i.test(reason) ? "environment"
            : /expect\(|AssertionError|Expected:|Received:|to[A-Z]\w+/.test(reason) ? "assertion"
              : /locator|TimeoutError|waiting for|strict mode/i.test(reason) ? "locator" : "failed";
        const project = await projectsRepository.getProject(projectId);
        return fingerprint({ kind: "triage", specId: spec.id, sourceHash: run.sourceHash,
            markdownHash: yaml === null ? null : markdownHashOf(yaml),
            failureKind, failedStep: evidence.failedStep ?? null, baseUrl: run.baseUrl ?? intent.baseUrl ?? project?.baseUrl });
    }
    const context = await projectContextsRepository.getLatestConfirmedProjectContext(projectId);
    const targets = specs.filter((spec) => !intent.specIds?.length || intent.specIds.includes(spec.id)).map((spec) => [spec.id, spec.sourceHash, spec.markdownHash]).sort();
    return fingerprint({ kind: intent.kind, targets, context: context?.context, baseUrl: intent.baseUrl,
        goal: source === "user" ? intent.goal.replace(/\s+/g, " ").trim().toLowerCase() : undefined,
        regressionKey: key.startsWith("regression:") ? key : undefined });
}

export async function enqueueIntent(projectId: string, input: unknown, key: string, source: "user" | "event" = "event"): Promise<Intent> {
    if (!await projectsRepository.getProject(projectId)) throw new Error("Project not found");
    const intent = stewardIntentSchema.parse(input);
    if (source !== "user" && ["coverage", "explore"].includes(intent.kind)) throw new Error("Coverage and exploration require an explicit human request");
    const specs = await specsRepository.listSpecs(projectId);
    if (intent.specIds?.some((id) => !specs.some((spec) => spec.id === id))) throw new Error("Selected Specs must belong to this project");
    const scrub = createProjectScrubber(projectId);
    intent.goal = await scrub(intent.goal);
    intent.reason = await scrub(intent.reason);
    return stewardRepository.addIntent({ projectId, key, source, intent, priority: intent.priority, reason: intent.reason,
        fingerprint: await intentFingerprint(projectId, intent, source, key) });
}

export async function recordFailureSignal(projectId: string, runId: string, specId: string, title: string, originalRunId = runId): Promise<void> {
    await stewardRepository.signal({ projectId, key: `failure:${originalRunId}`, kind: "spec_failure", title: `“${title}” failed`,
        body: "Investigate the failed step and evidence to distinguish test drift, an application bug, or an environment problem.", payload: { runId, originalRunId, specIds: [specId] } });
}

async function isCurrentSignal(signal: ProjectSignal): Promise<boolean> {
    if (signal.kind === "spec_failure") return !!await currentFailure(signal.projectId, typeof signal.payload.runId === "string" ? signal.payload.runId : undefined);
    if (signal.kind === "spec_changed") {
        const specId = Array.isArray(signal.payload.specIds) ? signal.payload.specIds[0] : null;
        const spec = typeof specId === "string" ? await specsRepository.getSpec(specId) : null;
        const observation = (await stewardRepository.get(signal.projectId)).observation;
        return !!spec && spec.projectId === signal.projectId && spec.status !== "invalid"
            && spec.sourceHash === signal.payload.sourceHash && spec.markdownHash === signal.payload.markdownHash
            && signal.payload.generation !== undefined && observation.specGenerations?.[spec.id] === signal.payload.generation;
    }
    if (signal.kind === "deployment_changed") {
        const deployment = (await stewardRepository.get(signal.projectId)).observation.deployment;
        return !!deployment && deployment.baseUrl === signal.payload.baseUrl && deployment.fingerprint === signal.payload.fingerprint && deployment.generation === signal.payload.generation;
    }
    if (signal.kind === "deployment") {
        const latest = (await stewardRepository.signals(signal.projectId, null)).find((other) => other.kind === "deployment"
            && other.payload.environment === signal.payload.environment);
        return latest?.id === signal.id;
    }
    return true;
}

/** Re-enabling automation evaluates present failures and changes, never the observation backlog. */
export async function resumeCurrentSignals(projectId: string): Promise<void> {
    await withProjectLock(projectId, async () => {
        for (const signal of await stewardRepository.signals(projectId, null)) {
            if (signal.status !== "observed") continue;
            const applicable = ["spec_changed", "deployment_changed", "deployment"].includes(signal.kind) && await isCurrentSignal(signal);
            await stewardRepository.acknowledge(signal.id, applicable ? "pending" : "handled");
        }
        const specs = await specsRepository.listSpecs(projectId);
        for (const spec of specs) {
            const run = (await runsRepository.listRuns(spec.id, { limit: 1 }))[0];
            if (!run || run.automationPending || !await currentFailure(projectId, run.id)) continue;
            const original = run.retryOf ? await runsRepository.getRun(run.retryOf) : run;
            if (!original?.healOnFailure) continue;
            await recordFailureSignal(projectId, run.id, spec.id, spec.title, original.id);
            const signal = (await stewardRepository.signals(projectId, null)).find((row) => row.key === `failure:${original.id}`);
            if (signal) await stewardRepository.acknowledge(signal.id, "pending");
        }
    });
}

async function handleSignal(signal: ProjectSignal, observe: boolean): Promise<void> {
    if (await isAgentPaused(signal.projectId)) return;
    if (observe && !["credentials_changed", "schedule"].includes(signal.kind)) { await stewardRepository.acknowledge(signal.id, "observed"); return; }
    if (!await isCurrentSignal(signal)) { await stewardRepository.acknowledge(signal.id, "handled"); return; }
    const specIds = Array.isArray(signal.payload.specIds) ? signal.payload.specIds as string[] : undefined;
    const runId = typeof signal.payload.runId === "string" ? signal.payload.runId : undefined;
    const kinds: Record<string, StewardIntent["kind"]> = {
        spec_failure: "triage",
        deployment_changed: "run_specs", deployment: "run_specs", spec_changed: "run_specs", schedule: "run_specs",
    };
    if (signal.kind === "credentials_changed") {
        for (const item of await jobsRepository.inbox(signal.projectId)) {
            if (await isAgentPaused(signal.projectId)) return;
            if (item.kind !== "question" || item.status !== "pending" || item.payload.waitingFor !== "credentials") continue;
            const job = await jobsRepository.get(item.jobId);
            if (job?.status !== "blocked" || !await canRunAgentJob(job) || !await jobsRepository.claimItem(item.id)) continue;
            try { await jobsRepository.answer(item, "Credential profiles changed. Check the available profiles and continue if the requested access is now available."); }
            catch { await jobsRepository.updateItem(item.id, { status: "pending" }); }
        }
    } else if (kinds[signal.kind]) {
        await enqueueIntent(signal.projectId, {
            kind: kinds[signal.kind], goal: signal.body, reason: signal.title, specIds, runId, baseUrl: typeof signal.payload.url === "string" ? signal.payload.url : undefined,
            priority: signal.kind === "spec_failure" ? 100 : signal.kind === "invalid_spec" ? 80 : 40,
        }, `signal:${signal.id}`);
    }
    await stewardRepository.acknowledge(signal.id, observe ? "observed" : "handled");
}

async function askForRunPrerequisite(row: Intent, reason: string): Promise<void> {
    let job = await jobsRepository.get(row.id);
    if (!job) {
        const chat = await createChat(row.projectId);
        job = await jobsRepository.create({ id: row.id, projectId: row.projectId, chatId: chat.id, kind: "review", status: "blocked", stopReason: reason,
            trigger: row.source === "user" ? "manual" : "steward", goal: row.intent.goal, specId: row.intent.specIds?.[0], limits: jobLimitsSchema.parse({}) });
    }
    await jobsRepository.transition(job.id, "queued", "blocked", { stopReason: reason });
    const existing = (await jobsRepository.inbox(row.projectId)).some((item) => item.jobId === job!.id && item.payload.runIntentId === row.id);
    if (!existing) {
        const credentials = /credential|password|session|sign.?in|authentication/i.test(reason);
        const edits = /uncommitted|repository.*dirty/i.test(reason);
        await jobsRepository.addItem({ projectId: row.projectId, jobId: job.id, kind: "question",
            title: credentials ? "Can you provide access to run these checks?" : edits ? "Can you save or discard the pending edits before running these checks?" : "Can you resolve this prerequisite so the checks can run?",
            body: `${credentials ? "Add the missing sign-in details in Settings → Credentials, then answer here. Do not paste passwords in your answer." : edits ? "Save or discard the pending edits in the project repository, then answer here to retry." : "The requested checks could not start. Resolve the prerequisite described below, then answer here to retry."}\n\n${reason}`,
            payload: { runIntentId: row.id, waitingFor: credentials ? "credentials" : "run_prerequisite", language: "en", specId: job.specId } });
    }
    await stewardRepository.updateIntent(row.id, { status: "running", jobId: job.id, reason });
}

export async function recordScheduledPrerequisite(projectId: string, specIds: string[], dueAt: string, reason: string, healFailures: boolean): Promise<void> {
    await withProjectLock(projectId, async () => {
        if (await isAgentPaused(projectId)) return;
        const [intents, signals, jobs] = await Promise.all([stewardRepository.intents(projectId), stewardRepository.signals(projectId, null), jobsRepository.list(projectId)]);
        const selection = JSON.stringify([...specIds].sort());
        const existing = intents.find((intent) => intent.intent.kind === "run_specs" && runTriggerForIntent(intent, intents, signals) === "schedule"
            && JSON.stringify([...(intent.intent.specIds ?? [])].sort()) === selection
            && jobs.some((job) => job.id === intent.jobId && job.status === "blocked" && job.stopReason === reason));
        if (existing) { await askForRunPrerequisite(existing, reason); return; }
        const key = `schedule:${dueAt}`;
        await stewardRepository.signal({ projectId, key, kind: "schedule", title: "A scheduled run needs a prerequisite", body: reason, payload: { specIds, healFailures } });
        const signal = (await stewardRepository.signals(projectId, null)).find((row) => row.key === key)!;
        const intent = stewardIntentSchema.parse({ kind: "run_specs", specIds, priority: 70,
            goal: "Run the checks selected for this scheduled occurrence after its prerequisite is resolved.", reason: "Scheduled run" });
        // The saved schedule can refer to a deleted check. Keep that selection so a retry cannot silently run a different set.
        const row = await stewardRepository.addIntent({ projectId, key: `signal:${signal.id}`, source: "event", intent, priority: intent.priority, reason: intent.reason,
            fingerprint: fingerprint({ projectId, key, specIds }) });
        await stewardRepository.acknowledge(signal.id, "handled");
        await askForRunPrerequisite(row, reason);
    });
}

async function dispatchIntent(row: Intent): Promise<void> {
    if (await isAgentPaused(row.projectId)) return;
    if (row.intent.kind === "regenerate" && row.source !== "user") {
        await stewardRepository.updateIntent(row.id, { status: "ignored", reason: "Regeneration requires a human request." });
        return;
    }
    const relatedIntents = await stewardRepository.intents(row.projectId);
    const signals = await stewardRepository.signals(row.projectId, null);
    const runTrigger = runTriggerForIntent(row, relatedIntents, signals);
    if ((await stewardRepository.get(row.projectId)).autonomy === "observe" && row.source !== "user" && !(row.intent.kind === "run_specs" && runTrigger === "schedule")) return;
    if (row.intent.kind === "triage" && !await currentFailure(row.projectId, row.intent.runId)) {
        await stewardRepository.updateIntent(row.id, { status: "ignored", reason: "The failure was superseded by a newer check or Spec change." });
        return;
    }
    const signal = runSignalForIntent(row, relatedIntents, signals);
    if (row.source === "event" && signal && !await isCurrentSignal(signal)) {
        await stewardRepository.updateIntent(row.id, { status: "ignored", reason: "A newer project state superseded this event." });
        return;
    }
    const projectJobs = await jobsRepository.list(row.projectId);
    const existing = await jobsRepository.get(row.id);
    if (existing) {
        if (row.intent.kind === "run_specs" && existing.status === "blocked" && existing.stopReason) await askForRunPrerequisite(row, existing.stopReason);
        else await stewardRepository.updateIntent(row.id, { status: "running", jobId: existing.id });
        return;
    }
    for (const job of projectJobs.filter((job) => ["queued", "running"].includes(job.status))) if (await canRunAgentJob(job)) return;
    const siblings = await stewardRepository.intents(row.projectId);
    if (siblings.some((other) => other.id !== row.id && other.status === "running" && other.batchId)) return;
    const inbox = await jobsRepository.inbox(row.projectId);
    const currentSubject = row.intent.kind === "triage" ? await intentFingerprint(row.projectId, row.intent, row.source, row.key) : row.fingerprint;
    const previous: Intent[] = [];
    for (const other of siblings) {
        if (other.id === row.id || !(other.jobId || other.batchId)) continue;
        const subject = other.intent.kind === "triage" ? await intentFingerprint(other.projectId, other.intent, other.source, other.key).catch(() => null) : other.fingerprint;
        if (subject === currentSubject) previous.push(other);
    }
    const rejected = previous.some((other) => inbox.some((item) => item.jobId === other.jobId && (item.status === "rejected" || item.payload.ignoredCheck === true)));
    if ((row.source === "event" && row.intent.kind !== "run_specs" && rejected)
        || previous.some((other) => projectJobs.some((job) => job.id === other.jobId && ["queued", "running", "paused", "blocked", "stalled"].includes(job.status)))
        || (row.source === "event" && row.intent.kind !== "run_specs" && previous.some((other) => Date.now() - Date.parse(other.updatedAt) < 6 * 3600_000))) {
        await stewardRepository.updateIntent(row.id, { status: "ignored", reason: rejected ? "A human rejected this proposal for the current Spec/context version." : "Equivalent work is already active or was handled recently." });
        return;
    }
    if (row.intent.kind === "run_specs") {
        const selected = (await specsRepository.listSpecs(row.projectId)).filter((spec) => !row.intent.specIds?.length || row.intent.specIds.includes(spec.id));
        if (row.intent.specIds?.length && (selected.length !== row.intent.specIds.length || selected.some((spec) => spec.status === "invalid"))) throw new Error("Some selected checks are missing or invalid. Restore or update those checks before retrying this selection.");
        const specs = selected.filter((spec) => spec.status !== "invalid");
        if (!specs.length) { await stewardRepository.updateIntent(row.id, { status: "ignored", reason: "No runnable Specs yet." }); return; }
        if (areSpecsLocked(specs.map((spec) => spec.id)) || await runsRepository.hasRunningRuns(specs.map((spec) => spec.id))) return;
        if (await isAgentPaused(row.projectId)) return;
        await startSpecBatch(row.projectId, specs.map((spec) => spec.id), row.intent.reason, {
            baseUrl: row.intent.baseUrl,
            trigger: runTrigger,
            healFailures: runSignalForIntent(row, relatedIntents, signals)?.payload.healFailures !== false,
            onPrepared: async (batch) => {
                if (stopped || await isAgentPaused(row.projectId) || (row.source === "event" && runTrigger !== "schedule" && (await stewardRepository.get(row.projectId)).autonomy === "observe")) throw new IntentDeferred("Automatic execution was deferred before the checks started");
                if (runTrigger === "schedule") await (await import("../jobs/schedules")).recordScheduledBatch(batch);
                await stewardRepository.updateIntent(row.id, { status: "running", batchId: batch.id });
            },
        });
        return;
    }
    const kind = row.intent.kind === "triage" ? "failure_triage" : row.intent.kind;
    const decisions = inbox.filter((item) => ["approved", "rejected", "dismissed"].includes(item.status)).slice(0, 12).map((item) => ({ title: item.title, status: item.status }));
    const goal = `${row.intent.goal}\nReason: ${row.intent.reason}\n${row.intent.specIds?.length ? `Selected Specs: ${row.intent.specIds.join(", ")}.` : ""}\n${kind === "regenerate" ? "Repair only spec.ts to implement the existing spec.yml. Never change the behavior contract. Verify the proposal before requesting approval." : kind === "explore" ? "Explore only the area requested by the human. Inspect available access and ask through the Inbox when a prerequisite needs human help." : kind === "coverage" ? "Compare confirmed areas, roles and rules to the existing Specs and propose additional coverage only for the requested scope. Ask when blocked." : "Investigate the failed check and classify its cause without changing expected behavior."}\nRecent human decisions: ${JSON.stringify(decisions)}`;
    const job = await enqueueJob(row.projectId, { kind, goal: goal.slice(0, 12000), trigger: row.source === "user" ? "manual" : row.intent.kind === "triage" ? "spec_failure" : "steward",
        specId: row.intent.specIds?.[0], runId: row.intent.runId,
        limits: jobLimitsSchema.parse({}),
    }, row.id);
    await stewardRepository.updateIntent(row.id, { status: "running", jobId: job.id });
}

export async function processProjectSteward(projectId: string, collect = true): Promise<void> {
    await withProjectLock(projectId, async () => {
        const project = await projectsRepository.getProject(projectId);
        if (!project) return;
        const settings = await stewardRepository.get(projectId);
        if (await isAgentPaused(projectId)) return;
        const projectJobs = await jobsRepository.list(projectId);
        for (const blocked of projectJobs.filter((job) => job.status === "blocked" && job.safetyRetries > 0)) if (await canRunAgentJob(blocked)) await retryStalledJob(blocked);
        const runnable = await Promise.all(projectJobs.filter((job) => ["queued", "running"].includes(job.status)).map(canRunAgentJob));
        if (!runnable.some(Boolean)) {
            for (const stalled of projectJobs.filter((job) => job.status === "stalled")) if (await canRunAgentJob(stalled)) await retryStalledJob(stalled);
        }
        if (collect) await stewardRepository.update(projectId, { observation: await collectProjectSignals(project, settings.observation) });
        for (const signal of await stewardRepository.pendingSignals(projectId)) await handleSignal(signal, settings.autonomy === "observe");
        const intents = await stewardRepository.intents(projectId);
        for (const intent of intents.filter((intent) => intent.status === "running")) {
            const job = intent.jobId ? await jobsRepository.get(intent.jobId) : null;
            const batch = intent.batchId ? await getRunBatch(intent.batchId) : null;
            if (intent.intent.kind === "run_specs" && job?.status === "blocked" && job.stopReason) await askForRunPrerequisite(intent, job.stopReason);
            if (job && ["completed", "cancelled"].includes(job.status)) {
                if (intent.intent.kind === "run_specs" && job.status === "completed") {
                    const answered = (await jobsRepository.inbox(projectId)).find((item) => item.jobId === job.id && item.payload.runIntentId === intent.id && item.status === "answered");
                    if (answered) await enqueueIntent(projectId, intent.intent, `resume-run:${intent.id}:${answered.id}`, intent.source);
                }
                await stewardRepository.updateIntent(intent.id, { status: job.status === "completed" ? "completed" : "failed" });
            } else if (batch && batch.status !== "running") await stewardRepository.updateIntent(intent.id, { status: batch.status === "passed" ? "completed" : "failed" });
        }
        if (await isAgentPaused(projectId)) return;
        if (settings.autonomy === "act") await applyTrustedFixes(projectId);
        const pending = (await stewardRepository.intents(projectId)).filter((intent) => intent.status === "pending");
        for (const intent of pending) {
            if (stopped || await isAgentPaused(projectId)) break;
            try { await dispatchIntent(intent); }
            catch (error) {
                if (error instanceof IntentDeferred) continue;
                if (error instanceof StaleTriageError) {
                    await stewardRepository.updateIntent(intent.id, { status: "ignored", reason: error.message });
                    continue;
                }
                const scrub = createProjectScrubber(projectId);
                const reason = await scrub(String(error));
                if (intent.intent.kind === "run_specs") {
                    await askForRunPrerequisite(intent, reason);
                } else await stewardRepository.updateIntent(intent.id, { status: "failed", reason });
                logger.warn("steward intent failed", { projectId, intentId: intent.id, error });
            }
        }
    });
}

export async function processStewards(): Promise<void> {
    if (processing || stopped) return;
    processing = true;
    try {
        for (const project of await projectsRepository.listProjects()) {
            if (stopped) break;
            await processProjectSteward(project.id).catch((error) => logger.warn("project steward failed", { projectId: project.id, error }));
        }
    } finally { processing = false; }
}

export function startSteward(): void {
    stopped = false;
    timer = setInterval(() => void processStewards(), 30_000);
    timer.unref();
    void processStewards();
}
export function stopSteward(): void { stopped = true; clearInterval(timer); }
