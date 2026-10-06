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
import { createJobSchema, jobLimitsSchema } from "./schemas";
import { AGENT_RULES_VERSION, createJobPolicy } from "./policy";
import { isInfrastructureFailure } from "./presentation-errors";
import { retryInfrastructure, stallJob } from "./retry";
import { canRunAgentJob, isAgentPaused } from "./pause";
import { projectsRepository } from "../../infra/repositories/projects";
import { withActor } from "../accounts/audit";

const active = new Map<string, Promise<void>>();
const resumeInstructions = "The human paused this investigation. When resumed, read the previous messages, suggestions and current browser state before continuing the original goal. Do not repeat completed actions or change the expected behavior.";
let polling = false;
let stopped = false;
let timer: ReturnType<typeof setInterval> | undefined;

export async function enqueueJob(projectId: string, input: unknown = {}, id?: string): Promise<Job> {
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
    const job = await jobsRepository.create({ ...parsed, id, pendingMessage, projectId, chatId: chat.id });
    if (await isAgentPaused(projectId)) await jobsRepository.transition(job.id, "queued", "paused");
    await jobsRepository.log(job.id, "queued", parsed.trigger);
    void drainJobs();
    return (await jobsRepository.get(job.id))!;
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
            if (selected?.specId && selected.runId && selected.status !== "running") {
                await jobsRepository.transition(job.id, "running", "completed", { systemError: null, stopReason: null, retryAt: null });
            } else if (!last || isInfrastructureFailure(last) || /couldn't respond|No LLM model|not authenticated|turn failed/.test(last)) {
                await retryInfrastructure(job, last || "The agent service could not complete its response.");
            } else if (selected?.status === "running") {
                await jobsRepository.transition(job.id, "running", "queued", { retryAt: new Date(Date.now() + 15_000).toISOString(),
                    pendingMessage: "The selected draft's first run is still running. Use run_spec to inspect its saved result. Do not create another Spec or start another run." });
            } else if (selected) {
                await stallJob(job, selected.specId ? "The draft was saved, but its first result is missing." : "The selected Spec has no saved runnable draft.");
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
        for (const row of await jobsRepository.queued()) {
            if (active.size >= limit || stopped) break;
            if (active.has(row.id)) continue;
            if (await isAgentPaused(row.projectId)) { await jobsRepository.transition(row.id, "queued", "paused"); continue; }
            if (!await canRunAgentJob(row) || await cancelStaleTriage(row)) continue;
            if (row.retryAt && Date.parse(row.retryAt) > Date.now()) continue;
            const siblings = await jobsRepository.list(row.projectId);
            if (siblings.some((job) => job.status === "running" || active.has(job.id))) continue;
            const job = await jobsRepository.claim(row.id);
            if (!job) continue;
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
    void drainJobs();
}

/**
 * A question asked under older agent rules may no longer apply (for example, permission to perform a Spec's own
 * steps). Close it as outdated and let the job re-check under the current rules; it asks again only if still blocked.
 */
async function reviewOutdatedQuestions(): Promise<void> {
    for (const project of await projectsRepository.listProjects()) {
        if (await isAgentPaused(project.id)) continue;
        for (const item of await jobsRepository.inbox(project.id)) {
            if (item.kind !== "question" || item.status !== "pending" || Number(item.payload.rulesVersion ?? 1) >= AGENT_RULES_VERSION) continue;
            const job = await jobsRepository.get(item.jobId);
            if (job?.status !== "blocked" || !["regenerate", "failure_triage", "generate_spec"].includes(job.kind)) continue;
            const allowance = jobLimitsSchema.parse({});
            const resumed = await jobsRepository.transition(job.id, "blocked", "queued", {
                limits: { maxActions: job.actionsUsed + allowance.maxActions, wallTimeMs: job.elapsedMs + allowance.wallTimeMs },
                safetyRetries: 0, stopReason: null, retryAt: null,
                pendingMessage: `Specbook updated its rules after you asked "${item.title}". The steps written in a Spec are now authorized, and saved credential profiles can be used to sign in. Your question was closed without a human answer. Re-check whether it still applies under these rules and continue the original goal; ask again only if you are still blocked. Inspect list_inbox before repeating work.`,
            });
            if (!resumed) continue;
            await jobsRepository.updateItem(item.id, { status: "dismissed", payload: { ...item.payload, outdatedRules: true } });
            await jobsRepository.log(job.id, "resumed", "The question was asked under older agent rules and was reviewed automatically.");
        }
    }
}

export async function startJobWorker(): Promise<void> {
    await jobsRepository.recover();
    // Internal service failures belong to automatic recovery, including earlier unanswered reports.
    for (const project of await (await import("../../infra/repositories/projects")).projectsRepository.listProjects()) {
        if (!await isAgentPaused(project.id)) for (const job of await jobsRepository.list(project.id)) {
            if (job.status === "paused") await jobsRepository.transition(job.id, "paused", "queued");
        }
        for (const item of await jobsRepository.inbox(project.id)) {
            if (item.kind !== "question" || item.status !== "pending" || !isInfrastructureFailure(`${item.title}\n${item.body}`)) continue;
            const job = await jobsRepository.get(item.jobId);
            if (job?.status !== "blocked") continue;
            await retryInfrastructure(job, `${item.title}\n${item.body}`);
            await jobsRepository.updateItem(item.id, { status: "dismissed", payload: { ...item.payload, internalRecovery: true } });
        }
    }
    await reviewOutdatedQuestions();
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
