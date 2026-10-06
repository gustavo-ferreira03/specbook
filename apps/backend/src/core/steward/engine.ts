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
import { enqueueJob } from "../jobs/worker";
import { getRunBatch, startSpecBatch } from "../runner/batch";
import { collectProjectSignals, fingerprint } from "./signals";
import { stewardIntentSchema, type StewardIntent } from "./schemas";

const locks = new Map<string, Promise<unknown>>();
let stopped = false;
let timer: ReturnType<typeof setInterval> | undefined;
let processing = false;
const day = 86400_000;

async function withProjectLock<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = locks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    locks.set(id, current);
    try { return await current; } finally { if (locks.get(id) === current) locks.delete(id); }
}

export async function enqueueIntent(projectId: string, input: unknown, key: string): Promise<Intent> {
    if (!await projectsRepository.getProject(projectId)) throw new Error("Project not found");
    const intent = stewardIntentSchema.parse(input);
    const specs = await specsRepository.listSpecs(projectId);
    if (intent.specIds?.some((id) => !specs.some((spec) => spec.id === id))) throw new Error("Selected Specs must belong to this project");
    const context = await projectContextsRepository.getLatestConfirmedProjectContext(projectId);
    const targets = specs.filter((spec) => !intent.specIds?.length || intent.specIds.includes(spec.id)).map((spec) => [spec.id, spec.sourceHash, spec.markdownHash]).sort();
    const scrub = createProjectScrubber(projectId);
    intent.goal = await scrub(intent.goal);
    intent.reason = await scrub(intent.reason);
    return stewardRepository.addIntent({ projectId, key, intent, priority: intent.priority, reason: intent.reason,
        fingerprint: fingerprint({ kind: intent.kind, targets, context: context?.context, baseUrl: intent.baseUrl,
            runBlocker: key.startsWith("run-blocker:"),
            goal: ["coverage", "explore"].includes(intent.kind) && !key.startsWith("run-blocker:") ? intent.goal.replace(/\s+/g, " ").trim().toLowerCase() : undefined,
            regressionKey: key.startsWith("regression:") ? key : undefined,
            runKey: intent.kind === "run_specs" ? key : undefined }) });
}

export async function recordFailureSignal(projectId: string, runId: string, specId: string, title: string): Promise<void> {
    await stewardRepository.signal({ projectId, key: `failure:${runId}`, kind: "spec_failure", title: `“${title}” failed`,
        body: "Investigate the failed step and evidence to distinguish test drift, an application bug, or an environment problem.", payload: { runId, specIds: [specId] } });
}

async function handleSignal(signal: ProjectSignal, observe: boolean): Promise<void> {
    if (observe) { await stewardRepository.acknowledge(signal.id, "observed"); return; }
    const specIds = Array.isArray(signal.payload.specIds) ? signal.payload.specIds as string[] : undefined;
    const runId = typeof signal.payload.runId === "string" ? signal.payload.runId : undefined;
    const kinds: Record<string, StewardIntent["kind"]> = {
        spec_failure: "triage", invalid_spec: "regenerate", empty_project: "coverage", context_changed: "coverage",
        deployment_changed: "run_specs", deployment: "run_specs", spec_changed: "run_specs", stale_spec: "run_specs", app_unavailable: "explore",
    };
    if (signal.kind === "credentials_changed") {
        for (const item of await jobsRepository.inbox(signal.projectId)) {
            if (item.kind !== "question" || item.status !== "pending" || item.payload.waitingFor !== "credentials") continue;
            const job = await jobsRepository.get(item.jobId);
            if (job?.status !== "blocked" || !await jobsRepository.claimItem(item.id)) continue;
            try { await jobsRepository.answer(item, "Credential profiles changed. Check the available profiles and continue if the requested access is now available."); }
            catch { await jobsRepository.updateItem(item.id, { status: "pending" }); }
        }
    } else if (kinds[signal.kind]) {
        await enqueueIntent(signal.projectId, {
            kind: kinds[signal.kind], goal: signal.body, reason: signal.title, specIds, runId, baseUrl: typeof signal.payload.url === "string" ? signal.payload.url : undefined,
            priority: signal.kind === "spec_failure" ? 100 : signal.kind === "invalid_spec" ? 80 : 40,
        }, `signal:${signal.id}`);
    }
    await stewardRepository.acknowledge(signal.id, "handled");
}

export function dailyBudget(jobs: Awaited<ReturnType<typeof jobsRepository.list>>, at = Date.now()) {
    const date = new Date(at).toISOString().slice(0, 10);
    let tokens = 0;
    let wallTimeMs = 0;
    for (const job of jobs) {
        const reserved = ["queued", "running", "blocked"].includes(job.status);
        if (!reserved && job.updatedAt.slice(0, 10) !== date) continue;
        tokens += reserved ? Math.max(job.budget.maxTokens, job.tokensUsed) : job.tokensUsed;
        wallTimeMs += reserved ? Math.max(job.budget.wallTimeMs, job.elapsedMs) : job.elapsedMs;
    }
    return { tokens: Math.max(0, 300_000 - tokens), wallTimeMs: Math.max(0, 1800_000 - wallTimeMs) };
}

async function dispatchIntent(row: Intent): Promise<void> {
    const projectJobs = await jobsRepository.list(row.projectId);
    const existing = await jobsRepository.get(row.id);
    if (existing) { await stewardRepository.updateIntent(row.id, { status: "running", jobId: existing.id }); return; }
    if (projectJobs.some((job) => ["queued", "running"].includes(job.status))) return;
    const siblings = await stewardRepository.intents(row.projectId);
    if (siblings.some((other) => other.id !== row.id && other.status === "running" && other.batchId)) return;
    const inbox = await jobsRepository.inbox(row.projectId);
    const previous = siblings.filter((other) => other.id !== row.id && other.fingerprint === row.fingerprint && (other.jobId || other.batchId));
    const rejected = previous.some((other) => inbox.some((item) => item.jobId === other.jobId && item.status === "rejected"));
    if (rejected || previous.some((other) => projectJobs.some((job) => job.id === other.jobId && ["queued", "running", "blocked"].includes(job.status))) || previous.some((other) => Date.now() - Date.parse(other.updatedAt) < 6 * 3600_000)) {
        await stewardRepository.updateIntent(row.id, { status: "ignored", reason: rejected ? "A human rejected this proposal for the current Spec/context version." : "Equivalent work is already active or was handled recently." });
        return;
    }
    if (row.intent.kind === "run_specs") {
        const specs = (await specsRepository.listSpecs(row.projectId)).filter((spec) => spec.status !== "invalid" && (!row.intent.specIds?.length || row.intent.specIds.includes(spec.id)));
        if (!specs.length) { await stewardRepository.updateIntent(row.id, { status: "ignored", reason: "No runnable Specs yet." }); return; }
        if (areSpecsLocked(specs.map((spec) => spec.id)) || await runsRepository.hasRunningRuns(specs.map((spec) => spec.id))) return;
        // A bounded number of batches prevents a rapidly changing deploy fingerprint from flooding the runner.
        if (siblings.filter((item) => item.batchId && Date.now() - Date.parse(item.createdAt) < day).length >= 12) return;
        await startSpecBatch(row.projectId, specs.map((spec) => spec.id), row.intent.reason, {
            baseUrl: row.intent.baseUrl,
            onPrepared: async (batch) => { await stewardRepository.updateIntent(row.id, { status: "running", batchId: batch.id }); },
        });
        return;
    }
    const remaining = dailyBudget(projectJobs);
    if (remaining.tokens < 1000 || remaining.wallTimeMs < 1000) return;
    const kind = row.intent.kind === "triage" ? "failure_triage" : row.intent.kind;
    const context = await projectContextsRepository.getLatestConfirmedProjectContext(row.projectId);
    const specs = await specsRepository.listSpecs(row.projectId);
    const decisions = inbox.filter((item) => ["approved", "rejected", "dismissed"].includes(item.status)).slice(0, 12).map((item) => ({ title: item.title, status: item.status }));
    const goal = kind === "planner"
        ? `Review this compact project digest and submit prioritized intents with propose_intents. Do not execute the planned work in this turn.\n${JSON.stringify({ context: context?.context, specs: specs.map((spec) => ({ id: spec.id, title: spec.title, status: spec.status })), decisions, recentWork: projectJobs.slice(0, 8).map((job) => ({ goal: job.goal.slice(0, 200), status: job.status, classification: job.classification })) }).slice(0, 10000)}`
        : `${row.intent.goal}\nReason: ${row.intent.reason}\n${row.intent.specIds?.length ? `Selected Specs: ${row.intent.specIds.join(", ")}.` : ""}\n${kind === "regenerate" ? "Repair only spec.ts to implement the existing spec.yml. Never change the behavior contract. Verify the proposal before requesting approval." : kind === "explore" ? "Investigate the stated problem, inspect available access, and ask through the Inbox when a prerequisite needs human help. Keep this investigation focused on its goal." : "Compare confirmed areas, roles and rules to the existing Specs before proposing additional coverage. Investigate in the browser and ask when blocked."}\nRecent human decisions: ${JSON.stringify(decisions)}`;
    const job = await enqueueJob(row.projectId, { kind, goal: goal.slice(0, 12000), trigger: row.intent.kind === "triage" ? "spec_failure" : "steward",
        specId: row.intent.specIds?.[0], runId: row.intent.runId,
        budget: { maxTokens: Math.min(kind === "planner" ? 20_000 : 100_000, remaining.tokens), wallTimeMs: Math.min(kind === "planner" ? 120_000 : 600_000, remaining.wallTimeMs), maxActions: kind === "planner" ? 8 : 80 },
    }, row.id);
    await stewardRepository.updateIntent(row.id, { status: "running", jobId: job.id });
}

export async function processProjectSteward(projectId: string, collect = true): Promise<void> {
    await withProjectLock(projectId, async () => {
        const project = await projectsRepository.getProject(projectId);
        if (!project) return;
        const settings = await stewardRepository.get(projectId);
        if (collect) await stewardRepository.update(projectId, { observation: await collectProjectSignals(project, settings.observation) });
        for (const signal of await stewardRepository.pendingSignals(projectId)) await handleSignal(signal, settings.autonomy === "observe");
        const intents = await stewardRepository.intents(projectId);
        for (const intent of intents.filter((intent) => intent.status === "running")) {
            const job = intent.jobId ? await jobsRepository.get(intent.jobId) : null;
            const batch = intent.batchId ? await getRunBatch(intent.batchId) : null;
            if (job && ["completed", "cancelled", "budget_exceeded"].includes(job.status)) {
                if (intent.key.startsWith("run-blocker:")) {
                    const original = intents.find((item) => item.id === intent.key.slice("run-blocker:".length));
                    if (original?.intent.kind === "run_specs") {
                        if (original.status === "pending") await stewardRepository.updateIntent(original.id, { status: "failed", reason: "Run preparation was handed to an investigation." });
                        if (job.status === "completed") await enqueueIntent(projectId, original.intent, `resume-run:${original.id}:${intent.id}`);
                    }
                }
                await stewardRepository.updateIntent(intent.id, { status: job.status === "completed" ? "completed" : "failed" });
            } else if (batch && batch.status !== "running") await stewardRepository.updateIntent(intent.id, { status: batch.status === "passed" ? "completed" : "failed" });
        }
        if (settings.autonomy === "observe") return;
        if (settings.autonomy === "act") await applyTrustedFixes(projectId);
        if (!settings.lastPlannerAt || Date.now() - Date.parse(settings.lastPlannerAt) >= day) {
            await enqueueIntent(projectId, { kind: "planner", goal: "Review project coverage and choose useful next investigations.", reason: "Daily review of coverage and recent human decisions.", priority: 10 }, `planner:${new Date().toISOString().slice(0, 10)}`);
            await stewardRepository.update(projectId, { lastPlannerAt: new Date().toISOString() });
        }
        const pending = (await stewardRepository.intents(projectId)).filter((intent) => intent.status === "pending");
        for (const intent of pending) {
            if (stopped) break;
            try { await dispatchIntent(intent); }
            catch (error) {
                const scrub = createProjectScrubber(projectId);
                const reason = await scrub(String(error));
                if (intent.intent.kind === "run_specs") {
                    await enqueueIntent(projectId, {
                        kind: "explore", specIds: intent.intent.specIds, baseUrl: intent.intent.baseUrl, priority: 90,
                        reason: "The requested Specs need help before they can run.",
                        goal: `Investigate why this run could not start: ${reason.slice(0, 1500)}. Original goal: ${intent.intent.goal.slice(0, 3000)}. Check the available credential profiles and other prerequisites. If access or a human decision is needed, request it through the Inbox and remain blocked until it is resolved. Do not change spec.yml. Once the prerequisite is restored, finish this investigation; the steward will retry the original run.`,
                    }, `run-blocker:${intent.id}`);
                }
                await stewardRepository.updateIntent(intent.id, { status: "failed", reason });
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
