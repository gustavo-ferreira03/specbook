import { jobBaseUrl } from "./environment";
import { prepareTriageGoal } from "./triage";
import { closeChatBrowser } from "../browser/sessions";
import { jobsRepository, type Job } from "../../infra/repositories/jobs";
import { logger } from "../../infra/logger";
import { abortChatTurn } from "../chat/chat-registry";
import { createChat, getChatMessages } from "../chat/session-store";
import { runChatTurn } from "../chat/turn-runner";
import { createProjectScrubber } from "../credentials/scrub";
import { createJobSchema } from "./schemas";
import { createJobPolicy } from "./policy";

const active = new Set<string>();
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
    await jobsRepository.log(job.id, "queued", parsed.trigger);
    void drainJobs();
    return job;
}

async function executeJob(job: Job): Promise<void> {
    const started = Date.now();
    const scrub = createProjectScrubber(job.projectId);
    const abort = () => {
        void abortChatTurn(job.chatId).catch(() => undefined);
        void closeChatBrowser(job.chatId).catch(() => undefined);
    };
    const remaining = job.budget.wallTimeMs - job.elapsedMs;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
        if (remaining <= 0 || job.tokensUsed >= job.budget.maxTokens || job.actionsUsed >= job.budget.maxActions) {
            await jobsRepository.update(job.id, { status: "budget_exceeded" });
        } else {
            deadline = setTimeout(() => {
                void jobsRepository.transition(job.id, "running", "budget_exceeded").then((updated) => { if (updated) abort(); }).catch((error) => logger.error("job deadline failed", { error }));
            }, remaining);
            await jobsRepository.log(job.id, "started");
            if ((await jobsRepository.get(job.id))?.status !== "running") return;
            await runChatTurn(job.chatId, job.pendingMessage, undefined, createJobPolicy(job, abort, await jobBaseUrl(job)));
        }
        if (stopped) return;
        const current = await jobsRepository.get(job.id);
        const messages = await getChatMessages(job.chatId);
        const last = messages?.filter((message) => message.role === "agent").at(-1)?.content;
        if (current?.status === "running") {
            const blocked = !last || /couldn't respond|No LLM model|not authenticated|turn failed|unavailable/.test(last ?? "");
            await jobsRepository.addItem({ jobId: job.id, projectId: job.projectId, kind: blocked ? "question" : "note",
                title: blocked ? "Job needs your input" : "Job result", body: await scrub(last || "The agent could not complete this turn. Check the provider settings and reply to resume.") });
            await jobsRepository.transition(job.id, "running", blocked ? "blocked" : "completed");
        } else if (current?.status === "budget_exceeded") {
            await jobsRepository.addItem({ jobId: job.id, projectId: job.projectId, kind: "note", title: "Job budget reached",
                body: "The job stopped at its configured budget. Review its proposals and activity log. The steward will consider follow-up work within the next available budget." });
        }
    } catch (error) {
        const current = await jobsRepository.get(job.id);
        if (stopped || current?.status === "cancelled" || current?.status === "budget_exceeded") return;
        await jobsRepository.log(job.id, "error", await scrub(String(error)));
        await jobsRepository.addItem({ jobId: job.id, projectId: job.projectId, kind: "question", title: "Job needs help", body: await scrub(String(error)) });
        await jobsRepository.update(job.id, { status: "blocked" });
    } finally {
        clearTimeout(deadline);
        await closeChatBrowser(job.chatId).catch(() => undefined);
        await jobsRepository.update(job.id, { elapsedMs: job.elapsedMs + Date.now() - started, startedAt: null });
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
            const siblings = await jobsRepository.list(row.projectId);
            if (siblings.some((job) => job.status === "running" || active.has(job.id))) continue;
            const job = await jobsRepository.claim(row.id);
            if (!job) continue;
            active.add(job.id);
            void executeJob(job).catch((error) => logger.error("job failed", { jobId: job.id, error }))
                .finally(() => { active.delete(job.id); void drainJobs(); });
        }
    } finally {
        polling = false;
    }
}

export async function startJobWorker(): Promise<void> {
    await jobsRepository.recover();
    stopped = false;
    timer = setInterval(() => void drainJobs().catch((error) => logger.error("job queue failed", { error })), 2000);
    timer.unref();
    await drainJobs();
}

export async function stopJobWorker(): Promise<void> {
    stopped = true;
    clearInterval(timer);
    for (const id of active) {
        const job = await jobsRepository.get(id);
        if (job) await Promise.allSettled([abortChatTurn(job.chatId), closeChatBrowser(job.chatId)]);
    }
}
