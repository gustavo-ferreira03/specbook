import { INSPECT_INSTRUCTION, provesExpectedResult, reviewNextStep } from "../runner/evidence-review";
import type { ProposalVerification } from "./verification";
import { selectedSpecInstructions, selectedSpecResult, recoverSpecBatches } from "./spec-batches";
import { jobEnvironment } from "./environment";
import { cancelStaleTriage, prepareTriageGoal } from "./triage";
import { closeChatBrowser } from "../browser/sessions";
import { jobsRepository, type Job } from "../../infra/repositories/jobs";
import { logger } from "../../infra/logger";
import { abortChatTurn } from "../chat/chat-registry";
import { createChat, getChatMessages } from "../chat/session-store";
import { runChatTurn } from "../chat/turn-runner";
import { createProjectScrubber } from "../credentials/scrub";
import { createJobSchema } from "./schemas";
import { AGENT_RULES_VERSION, createJobPolicy } from "./policy";
import { isInfrastructureFailure } from "./presentation-errors";
import { retryInfrastructure, stallJob } from "./retry";
import { canRunAgentJob, isAgentPaused } from "./pause";
import { projectsRepository } from "../../infra/repositories/projects";
import { chatsRepository } from "../../infra/repositories/chats";
import { withActor } from "../accounts/audit";

const active = new Map<string, Promise<void>>();
const resumeInstructions = "The human paused this investigation. When resumed, read the previous messages, suggestions and current browser state before continuing the original goal. Do not repeat completed actions or change the expected behavior.";
let polling = false;
let stopped = false;
let timer: ReturnType<typeof setInterval> | undefined;

export async function enqueueJob(projectId: string, input: unknown = {}, id?: string, options: { sourceChatId?: string | null } = {}): Promise<Job> {
    if (options.sourceChatId) {
        const source = await chatsRepository.getChatRow(options.sourceChatId);
        if (!source || source.projectId !== projectId) throw new Error("The source conversation must belong to this project.");
    }
    if (id) {
        const existing = await jobsRepository.get(id);
        if (existing) return existing;
    }
    const parsed = createJobSchema.parse(input);
    let pendingMessage = parsed.goal;
    if (parsed.kind === "failure_triage") {
        const input = await prepareTriageGoal(projectId, parsed.runId);
        const existing = await jobsRepository.forRun(input.runId);
        if (existing) return existing;
        parsed.specId = input.specId;
        parsed.goal = input.goal;
        pendingMessage = input.message;
    }
    const chat = await createChat(projectId);
    const job = await jobsRepository.create({ ...parsed, id, pendingMessage, projectId, chatId: chat.id, sourceChatId: options.sourceChatId });
    if (await isAgentPaused(projectId)) await jobsRepository.transition(job.id, "queued", "paused");
    await jobsRepository.log(job.id, "queued", parsed.trigger);
    void drainJobs();
    return (await jobsRepository.get(job.id))!;
}

const MAX_NUDGES = 2;
/**
 * Work the agent stopped short of: a new draft that fails or does not prove its expected result, or a
 * repair (test drift or regeneration) that ended without a fix that passed and proves the expected result.
 */
async function unfinishedWork(job: Job, selected: Awaited<ReturnType<typeof selectedSpecResult>> | null): Promise<string | null> {
    if ((await jobsRepository.actions(job.id)).filter((action) => action.action === "unfinished").length >= MAX_NUDGES) return null;
    if (selected?.specId && selected.attemptsLeft > 0 && (selected.status === "failed" || selected.status === "passed" && !provesExpectedResult(selected.evidenceReview))) {
        return `The selected Spec ${selected.status === "failed" ? "still fails" : "passes but does not prove its expected result"}. Do not stop or ask. ${reviewNextStep(selected.evidenceReview) ?? INSPECT_INSTRUCTION} Then call create_spec again with the corrected Spec.`;
    }
    if (!(job.kind === "regenerate" || job.kind === "failure_triage" && job.classification === "test_drift")) return null;
    const items = (await jobsRepository.inbox(job.projectId)).filter((item) => item.jobId === job.id);
    if (items.some((item) => item.kind === "bug_report")) return null;
    const proven = items.some((item) => {
        const verification = item.payload.verification as ProposalVerification | undefined;
        return item.kind === "spec_fix" && verification?.status === "passed" && provesExpectedResult(verification.review);
    });
    return proven ? null : `The Spec is not repaired yet: no proposed fix passed and proved the expected result. ${INSPECT_INSTRUCTION} Then call update_spec with the corrected spec.ts. Do not ask for permission.`;
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
    try {
        if (await isAgentPaused(job.projectId)) {
            await jobsRepository.transition(job.id, "running", "paused");
            return;
        }
        if (await cancelStaleTriage(job)) return;
        if (!await canRunAgentJob(job)) { await jobsRepository.transition(job.id, "running", "queued", { startedAt: null, heartbeatAt: null }); return; }
        if (remaining <= 0 || job.actionsUsed >= job.limits.maxActions) {
            if (job.systemError) await retryInfrastructure(job, job.systemError);
            else await stallJob(job, "The investigation did not reach a confirmed result.");
        } else {
            deadline = setTimeout(() => {
                void stallJob(job, "The investigation did not reach a confirmed result.").then(abort).catch((error) => logger.error("job deadline failed", { error }));
            }, remaining);
            await jobsRepository.log(job.id, "started");
            if ((await jobsRepository.get(job.id))?.status !== "running") return;
            const environment = await jobEnvironment(job);
            await runChatTurn(job.chatId, job.kind === "generate_spec" ? await selectedSpecInstructions(job) : job.pendingMessage, undefined, createJobPolicy(job, abort, environment.baseUrl, environment));
        }
        if (stopped) return;
        const current = await jobsRepository.get(job.id);
        const messages = await getChatMessages(job.chatId);
        const last = messages?.filter((message) => message.role === "agent").at(-1)?.content;
        if (current?.status === "running") {
            const selected = job.kind === "generate_spec" ? await selectedSpecResult(job) : null;
            const unfinished = await unfinishedWork(current, selected);
            if (unfinished) {
                await jobsRepository.log(job.id, "unfinished", unfinished);
                await jobsRepository.transition(job.id, "running", "queued", { retryAt: new Date().toISOString(), pendingMessage: unfinished });
            } else if (selected?.specId && selected.runId && selected.status !== "running") {
                await jobsRepository.transition(job.id, "running", "completed", { systemError: null, stopReason: null, retryAt: null });
            } else if (!last || isInfrastructureFailure(last) || /couldn't respond|No LLM model|not authenticated|turn failed/.test(last)) {
                await retryInfrastructure(job, last || "The agent service could not complete its response.");
            } else if (selected?.status === "running") {
                await jobsRepository.transition(job.id, "running", "queued", { retryAt: new Date(Date.now() + 15_000).toISOString(),
                    pendingMessage: "The selected Spec's first run is still running. Use run_spec to inspect its saved result. Do not create another Spec or start another run." });
            } else if (selected) {
                await stallJob(job, selected.specId ? "The Spec was saved, but its first result is missing." : "The selected Spec has not been saved.");
            } else {
                const body = await scrub(last);
                const completed = await jobsRepository.transition(job.id, "running", "completed", { systemError: null, stopReason: null, retryAt: null });
                if (completed) await jobsRepository.addItem({ jobId: job.id, projectId: job.projectId, kind: "note", title: "Investigation finished", body, payload: { language: "en" } });
            }
        }
    } catch (error) {
        const current = await jobsRepository.get(job.id);
        if (stopped || current?.status !== "running") return;
        await jobsRepository.log(job.id, "error", await scrub(String(error)));
        await retryInfrastructure(job, String(error));
    } finally {
        clearTimeout(deadline);
        await closeChatBrowser(job.chatId).catch(() => undefined);
        clearInterval(heartbeat);
        await jobsRepository.finishExecution(job.id, job.startedAt!, Math.max(0, Date.now() - started));
        await jobsRepository.log(job.id, "stopped", (await jobsRepository.get(job.id))?.status ?? "unknown");
    }
}

export async function drainJobs(): Promise<void> {
    if (polling || stopped) return;
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
    const { processProjectSteward } = await import("../steward/engine");
    for (const project of projects) if (!await isAgentPaused(project.id)) await processProjectSteward(project.id, false);
    const { discoverPendingProjectContexts } = await import("../chat/discovery");
    discoverPendingProjectContexts();
    void drainJobs();
}

async function recoverProject(projectId: string): Promise<void> {
    const paused = await isAgentPaused(projectId);
    if (!paused) for (const job of await jobsRepository.list(projectId)) {
        if (job.status === "paused") await jobsRepository.transition(job.id, "paused", "queued");
    }
    const questions = (await jobsRepository.inbox(projectId)).filter((item) => item.kind === "question" && item.status === "pending");
    // Internal service failures belong to automatic recovery, including earlier unanswered reports.
    const infrastructure = new Set(questions.filter((item) => isInfrastructureFailure(`${item.title}\n${item.body}`)));
    for (const item of infrastructure) {
        const job = await jobsRepository.get(item.jobId);
        if (job?.status !== "blocked") continue;
        await retryInfrastructure(job, `${item.title}\n${item.body}`);
        await jobsRepository.updateItem(item.id, { status: "dismissed", payload: { ...item.payload, internalRecovery: true } });
    }
    if (paused) return;
    // A question asked under older agent rules may no longer apply (for example, permission to perform a Spec's own
    // steps). Close it as outdated and let the job re-check under the current rules; it asks again only if still blocked.
    for (const item of questions) {
        if (infrastructure.has(item) || Number(item.payload.rulesVersion ?? 1) >= AGENT_RULES_VERSION) continue;
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
