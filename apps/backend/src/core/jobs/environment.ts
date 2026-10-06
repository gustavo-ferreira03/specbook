import { runsRepository } from "../../infra/repositories/runs";
import { stewardRepository } from "../../infra/repositories/steward";
import type { Job } from "../../infra/repositories/jobs";

/** A preview investigation must keep using the environment that triggered it. */
export async function jobBaseUrl(job: Job): Promise<string | undefined> {
    const run = job.runId ? await runsRepository.getRun(job.runId) : null;
    if (run?.baseUrl) return run.baseUrl;
    const intent = (await stewardRepository.intents(job.projectId)).find((row) => row.id === job.id || row.jobId === job.id);
    return intent?.intent.baseUrl;
}
