import { settingsRepository } from "../../infra/repositories/settings";
import { stewardRepository } from "../../infra/repositories/steward";
import type { Job } from "../../infra/repositories/jobs";
import { runTriggerForIntent } from "../steward/signals";

export async function isAgentPaused(projectId: string): Promise<boolean> {
    const [globallyPaused, project] = await Promise.all([settingsRepository.getAgentPaused(), stewardRepository.get(projectId)]);
    return globallyPaused || project.paused;
}

export async function canRunAgentJob(job: Job): Promise<boolean> {
    const [globallyPaused, project] = await Promise.all([settingsRepository.getAgentPaused(), stewardRepository.get(job.projectId)]);
    if (globallyPaused || project.paused) return false;
    if (project.autonomy !== "observe" || ["manual", "chat"].includes(job.trigger)) return true;
    const intents = await stewardRepository.intents(job.projectId);
    const linked = intents.find((intent) => intent.jobId === job.id || intent.id === job.id);
    return linked?.source === "user" || Boolean(linked?.intent.kind === "run_specs" && runTriggerForIntent(linked, intents, await stewardRepository.signals(job.projectId, null)) === "schedule");
}
