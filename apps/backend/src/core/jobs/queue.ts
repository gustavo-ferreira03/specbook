import { chatsRepository } from "../../infra/repositories/chats";
import { jobsRepository } from "../../infra/repositories/jobs";
import type { Job } from "../../infra/repositories/jobs";
import { createChat } from "../chat/session-store";
import { requireValue } from "../utils/require-value";
import { isAgentPaused } from "./pause";
import { createJobSchema } from "./schemas";
import { prepareTriageGoal } from "./triage";

export const setJobQueueWakeup = function setJobQueueWakeup(
  // oxlint-disable-next-line promise/prefer-await-to-callbacks -- This API requires an event or callback handler.
  callback: () => void
): void {
  wakeup = callback;
};

export const requestJobDrain = function requestJobDrain(): void {
  wakeup();
};

export const enqueueJob = async function enqueueJob(
  projectId: string,
  input: unknown = {},
  id?: string,
  optionsInput: { sourceChatId?: string | null } = {}
): Promise<Job> {
  let options = optionsInput;

  if (id) {
    const existing = await jobsRepository.get(id);
    if (existing) {
      return existing;
    }
  }
  if (options.sourceChatId) {
    const source = await chatsRepository.getChatRow(options.sourceChatId);
    if (source && source.projectId !== projectId) {
      throw new Error("The source conversation must belong to this project.");
    }
    if (!source) {
      options = { ...options, sourceChatId: null };
    }
  }
  const parsed = createJobSchema.parse(input);
  let pendingMessage = parsed.goal;
  if (parsed.kind === "failure_triage") {
    const inputValue = await prepareTriageGoal(projectId, parsed.runId);
    const existing = await jobsRepository.forRun(inputValue.runId);
    if (existing) {
      return existing;
    }
    parsed.specId = inputValue.specId;
    parsed.goal = inputValue.goal;
    pendingMessage = inputValue.message;
  }
  const chat = await createChat(projectId);
  const job = await jobsRepository.create({
    ...parsed,
    id,
    pendingMessage,
    projectId,
    chatId: chat.id,
    sourceChatId: options.sourceChatId,
  });
  if (await isAgentPaused(projectId)) {
    await jobsRepository.transition(job.id, "queued", "paused");
  }
  await jobsRepository.log(job.id, "queued", parsed.trigger);
  requestJobDrain();
  return requireValue(await jobsRepository.get(job.id));
};

let wakeup = () => {
  /* No action is needed until this callback is replaced or invoked by its owner. */
};
