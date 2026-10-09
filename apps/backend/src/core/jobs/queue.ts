import { jobsRepository, type Job } from "../../infra/repositories/jobs";
import { chatsRepository } from "../../infra/repositories/chats";
import { createChat } from "../chat/session-store";
import { prepareTriageGoal } from "./triage";
import { createJobSchema } from "./schemas";
import { isAgentPaused } from "./pause";

let wakeup = () => {};

export function setJobQueueWakeup(callback: () => void): void { wakeup = callback; }
export function requestJobDrain(): void { wakeup(); }

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
    requestJobDrain();
    return (await jobsRepository.get(job.id))!;
}

