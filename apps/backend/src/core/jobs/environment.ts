import { runsRepository } from "../../infra/repositories/runs";
import { stewardRepository } from "../../infra/repositories/steward";
import type { Job } from "../../infra/repositories/jobs";

export async function jobBaseUrl(job: Job): Promise<string | undefined> {
    const run = job.runId ? await runsRepository.getRun(job.runId) : null;
    if (run?.baseUrl) return run.baseUrl;
    const intent = (await stewardRepository.intents(job.projectId)).find((row) => row.id === job.id || row.jobId === job.id);
    return intent?.intent.baseUrl;
}

export async function jobEnvironment(job: Job) {
    const run = job.runId ? await runsRepository.getRun(job.runId) : null;
    if (run?.environment) return run.environment;
    const intent = (await stewardRepository.intents(job.projectId)).find((row) => row.id === job.id || row.jobId === job.id);
    const { resolveRunEnvironment } = await import("../environments");
    return resolveRunEnvironment(job.projectId, intent?.intent.environment, run?.baseUrl ?? intent?.intent.baseUrl);
}
