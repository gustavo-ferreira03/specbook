import { errorCodeOf, isInfrastructureCode } from "../errors";
import { payloadOf, verificationOf } from "./schemas";
import { processProjectSteward } from "../steward/engine";
import { discoverPendingProjectContexts } from "../chat/discovery";
import { setJobQueueWakeup } from "./queue";
import { INSPECT_INSTRUCTION, provesExpectedResult, reviewNextStep } from "../runner/evidence-review";
import { selectedSpecInstructions, selectedSpecResult, recoverSpecBatches } from "./spec-batches";
import { jobEnvironment } from "./environment";
import { cancelStaleTriage } from "./triage";
import { closeChatBrowser } from "../browser/sessions";
import { jobsRepository, type Job } from "../../infra/repositories/jobs";
import { logger } from "../../infra/logger";
import { abortChatTurn } from "../chat/chat-registry";
import { getChatMessages } from "../chat/session-store";
import { runChatTurn, type TurnOutcome } from "../chat/turn-runner";
import { createProjectScrubber } from "../credentials/scrub";
import { AGENT_RULES_VERSION, createJobPolicy } from "./policy";
import { isInfrastructureFailure } from "./presentation-errors";
import { retryInfrastructure, stallJob } from "./retry";
import { canRunAgentJob, isAgentPaused } from "./pause";
import { projectsRepository } from "../../infra/repositories/projects";
import { withActor } from "../accounts/audit";

const active = new Map<string, Promise<void>>();
const resumeInstructions = "The human paused this investigation. When resumed, read the previous messages, suggestions and current browser state before continuing the original goal. Do not repeat completed actions or change the expected behavior.";
let polling = false;
let rerunRequested = false;
let stopped = false;
let timer: ReturnType<typeof setInterval> | undefined;

const MAX_NUDGES = 2;
async function unfinishedWork(job: Job, selected: Awaited<ReturnType<typeof selectedSpecResult>> | null): Promise<string | null> {
    if ((await jobsRepository.actions(job.id)).filter((action) => action.action === "unfinished").length >= MAX_NUDGES) return null;
    if (selected?.specId && selected.attemptsLeft > 0 && (selected.status === "failed" || selected.status === "passed" && !provesExpectedResult(selected.evidenceReview))) {
        return `The selected Spec ${selected.status === "failed" ? "still fails" : "passes but does not prove its expected result"}. Do not stop or ask. ${reviewNextStep(selected.evidenceReview) ?? INSPECT_INSTRUCTION} Then call create_spec again with the corrected Spec.`;
    }
    if (!(job.kind === "regenerate" || job.kind === "failure_triage" && job.classification === "test_drift")) return null;
    const items = await jobsRepository.itemsForJob(job.id);
    if (items.some((item) => item.kind === "bug_report")) return null;
    const proven = items.some((item) => {
        const verification = verificationOf(item);
        return item.kind === "spec_fix" && verification?.status === "passed" && provesExpectedResult(verification.review);
    });
    return proven ? null : `The Spec is not repaired yet: no proposed fix passed and proved the expected result. ${INSPECT_INSTRUCTION} Then call update_spec with the corrected spec.ts. Do not ask for permission.`;
}

export async function concludeJobTurn(job: Job, turn: TurnOutcome | undefined): Promise<void> {
    const scrub = createProjectScrubber(job.projectId);
    const current = await jobsRepository.get(job.id);
    const messages = await getChatMessages(job.chatId);
    const last = messages?.filter((message) => message.role === "agent").at(-1)?.content;
    if (current?.status === "running") {
        const selected = job.kind === "generate_spec" ? await selectedSpecResult(job) : null;
        const unfinished = await unfinishedWork(current, selected);
        if (turn?.status === "busy") {
            await jobsRepository.transition(job.id, "running", "queued", { retryAt: new Date(Date.now() + 2000).toISOString() });
        } else if (unfinished) {
            await jobsRepository.log(job.id, "unfinished", unfinished);
            await jobsRepository.transition(job.id, "running", "queued", { retryAt: new Date().toISOString(), pendingMessage: unfinished });
        } else if (selected?.specId && selected.runId && selected.status !== "running") {
            await jobsRepository.transition(job.id, "running", "completed", { systemError: null, errorCode: null, stopReason: null, retryAt: null });
        } else if (!last || turn?.errorCode && isInfrastructureCode(turn.errorCode)) {
            await retryInfrastructure(job, turn?.message ?? last ?? "The agent service could not complete its response.", turn?.errorCode ?? "infrastructure");
        } else if (selected?.status === "running") {
            await jobsRepository.transition(job.id, "running", "queued", { retryAt: new Date(Date.now() + 15_000).toISOString(),
                pendingMessage: "The selected Spec's first run is still running. Use run_spec to inspect its saved result. Do not create another Spec or start another run." });
        } else if (selected) {
            await stallJob(job, selected.specId ? "The Spec was saved, but its first result is missing." : "The selected Spec has not been saved.");
        } else {
            const body = await scrub(last ?? "");
            const completed = await jobsRepository.transition(job.id, "running", "completed", { systemError: null, errorCode: null, stopReason: null, retryAt: null });
            if (completed) await jobsRepository.addItem({ jobId: job.id, projectId: job.projectId, kind: "note", title: "Investigation finished", body, payload: { language: "en" } });
        }
    }
}

async function executeJob(job: Job): Promise<void> {
    const started = Date.now();
    const heartbeat = setInterval(() => void jobsRepository.heartbeat(job.id, job.startedAt!)
        .catch((error) => logger.error("job heartbeat failed", { jobId: job.id, error })), 5000);
    heartbeat.unref();
    const scrub = createProjectScrubber(job.projectId);
    const abort = () => {
        void abortChatTurn(job.chatId).catch(() => undefined);
        void closeChatBrowser(job.chatId).catch(() => undefined);
    };
    const remaining = job.limits.wallTimeMs - job.elapsedMs;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let turn: Awaited<ReturnType<typeof runChatTurn>> | undefined;
    try {
        if (await isAgentPaused(job.projectId)) {
            await jobsRepository.transition(job.id, "running", "paused");
            return;
        }
        if (await cancelStaleTriage(job)) return;
        if (!await canRunAgentJob(job)) { await jobsRepository.transition(job.id, "running", "queued", { startedAt: null, heartbeatAt: null }); return; }
        if (remaining <= 0 || job.actionsUsed >= job.limits.maxActions) {
            if (job.systemError) await retryInfrastructure(job, job.systemError, job.errorCode ?? "infrastructure");
            else await stallJob(job, "The investigation did not reach a confirmed result.");
        } else {
            deadline = setTimeout(() => {
                void stallJob(job, "The investigation did not reach a confirmed result.").then(abort).catch((error) => logger.error("job deadline failed", { error }));
            }, remaining);
            await jobsRepository.log(job.id, "started");
            if ((await jobsRepository.get(job.id))?.status !== "running") return;
            const environment = await jobEnvironment(job);
            turn = await runChatTurn(job.chatId, job.kind === "generate_spec" ? await selectedSpecInstructions(job) : job.pendingMessage, undefined, createJobPolicy(job, abort, environment.baseUrl, environment));
        }
        if (stopped) return;
        await concludeJobTurn(job, turn);
    } catch (error) {
        const current = await jobsRepository.get(job.id);
        if (stopped || current?.status !== "running") return;
        await jobsRepository.log(job.id, "error", await scrub(String(error)));
        const code = errorCodeOf(error);
        if (code && !isInfrastructureCode(code)) await stallJob(job, String(error), code);
        else await retryInfrastructure(job, String(error), code ?? "infrastructure");
    } finally {
        clearTimeout(deadline);
        await closeChatBrowser(job.chatId).catch(() => undefined);
        clearInterval(heartbeat);
        await jobsRepository.finishExecution(job.id, job.startedAt!, Math.max(0, Date.now() - started));
        await jobsRepository.log(job.id, "stopped", (await jobsRepository.get(job.id))?.status ?? "unknown");
    }
}

export async function drainJobs(): Promise<void> {
    if (stopped) return;
    if (polling) { rerunRequested = true; return; }
    polling = true;
    try {
        const configured = Number(process.env.SPECBOOK_MAX_CONCURRENT_JOBS ?? process.env.SPECBOOK_MAX_CONCURRENT_RUNS ?? 2);
        const limit = Number.isInteger(configured) && configured > 0 ? configured : 2;
        const busyProjects = await jobsRepository.busyProjects([...active.keys()]);
        for (const row of await jobsRepository.queued()) {
            if (active.size >= limit || stopped) break;
            if (active.has(row.id)) continue;
            if (await isAgentPaused(row.projectId)) { await jobsRepository.transition(row.id, "queued", "paused"); continue; }
            if (!await canRunAgentJob(row) || await cancelStaleTriage(row)) continue;
            if (row.retryAt && Date.parse(row.retryAt) > Date.now()) continue;
            if (busyProjects.has(row.projectId)) continue;
            const job = await jobsRepository.claim(row.id);
            if (!job) continue;
            busyProjects.add(job.projectId);
            if (await isAgentPaused(job.projectId)) { await jobsRepository.transition(job.id, "running", "paused", { startedAt: null, heartbeatAt: null }); continue; }
            const execution = withActor({ id: job.id, name: "Specbook", kind: "agent" }, () => executeJob(job)).catch((error) => logger.error("job failed", { jobId: job.id, error }))
                .finally(() => { active.delete(job.id); void drainJobs(); });
            active.set(job.id, execution);
        }
    } finally {
        polling = false;
        if (rerunRequested && !stopped) { rerunRequested = false; void drainJobs(); }
    }
}

export async function pauseAgentJobs(projectId?: string): Promise<void> {
    const projects = projectId ? [{ id: projectId }] : await projectsRepository.listProjects();
    const stopping: Promise<unknown>[] = [];
    for (const project of projects) for (const job of await jobsRepository.list(project.id)) {
        if (["queued", "running"].includes(job.status)) {
            const changed = await jobsRepository.transition(job.id, job.status, "paused", {
                pendingMessage: job.status === "running" && !job.pendingMessage.startsWith(resumeInstructions)
                    ? `${resumeInstructions}\n\n${job.pendingMessage}` : job.pendingMessage,
            });
            if (changed) await jobsRepository.log(job.id, "paused", "The human paused the agent.");
        }
        if (active.has(job.id)) {
            stopping.push(Promise.allSettled([abortChatTurn(job.chatId), closeChatBrowser(job.chatId)]).then(() => active.get(job.id)));
        }
    }
    await Promise.allSettled(stopping);
}

export async function resumeAgentJobs(projectId?: string): Promise<void> {
    const projects = projectId ? [{ id: projectId }] : await projectsRepository.listProjects();
    for (const project of projects) {
        if (await isAgentPaused(project.id)) continue;
        for (const job of await jobsRepository.list(project.id)) {
            if (job.status === "paused" && await jobsRepository.transition(job.id, "paused", "queued")) await jobsRepository.log(job.id, "resumed", "The human resumed the agent.");
        }
    }
    for (const project of projects) if (!await isAgentPaused(project.id)) await processProjectSteward(project.id, false);
    discoverPendingProjectContexts();
    void drainJobs();
}

async function recoverProject(projectId: string): Promise<void> {
    const paused = await isAgentPaused(projectId);
    if (!paused) for (const job of await jobsRepository.list(projectId)) {
        if (job.status === "paused") await jobsRepository.transition(job.id, "paused", "queued");
    }
    const questions = await jobsRepository.itemsByKind(projectId, "question", ["pending"]);
    const infrastructure = new Set(questions.filter((item) => isInfrastructureFailure(`${item.title}\n${item.body}`, payloadOf(item).errorCode)));
    for (const item of infrastructure) {
        const job = await jobsRepository.get(item.jobId);
        if (job?.status !== "blocked") continue;
        await retryInfrastructure(job, `${item.title}\n${item.body}`, payloadOf(item).errorCode ?? job.errorCode ?? "infrastructure");
        await jobsRepository.updateItem(item.id, { status: "dismissed", payload: { ...item.payload, internalRecovery: true } });
    }
    if (paused) return;
    for (const item of questions) {
        if (infrastructure.has(item) || Number(payloadOf(item).rulesVersion ?? 1) >= AGENT_RULES_VERSION) continue;
        const job = await jobsRepository.get(item.jobId);
        if (job?.status !== "blocked" || !["regenerate", "failure_triage", "generate_spec"].includes(job.kind)) continue;
        const resumed = await jobsRepository.requeue(job, "blocked", {
            pendingMessage: `Specbook updated its rules after you asked "${item.title}". The steps written in a Spec are now authorized, and saved credential profiles can be used to sign in. Your question was closed without a human answer. Re-check whether it still applies under these rules and continue the original goal; ask again only if you are still blocked. Inspect list_inbox before repeating work.`,
        });
        if (!resumed) continue;
        await jobsRepository.updateItem(item.id, { status: "dismissed", payload: { ...item.payload, outdatedRules: true } });
        await jobsRepository.log(job.id, "resumed", "The question was asked under older agent rules and was reviewed automatically.");
    }
}

export async function startJobWorker(): Promise<void> {
    await jobsRepository.recover();
    for (const project of await projectsRepository.listProjects()) await recoverProject(project.id);
    stopped = false;
    await recoverSpecBatches();
    timer = setInterval(() => void drainJobs().catch((error) => logger.error("job queue failed", { error })), 2000);
    timer.unref();
    await drainJobs();
}

export async function stopJobWorker(): Promise<void> {
    stopped = true;
    clearInterval(timer);
    for (const id of active.keys()) {
        const job = await jobsRepository.get(id);
        if (job) await Promise.allSettled([abortChatTurn(job.chatId), closeChatBrowser(job.chatId)]);
    }
}

export { enqueueJob } from "./queue";

setJobQueueWakeup(() => void drainJobs().catch((error) => logger.error("job queue failed", { error })));
