import type { Job } from "../../infra/repositories/jobs";
import { runsRepository } from "../../infra/repositories/runs";
import { stewardRepository } from "../../infra/repositories/steward";
import { resolveRunEnvironment } from "../environments";

export const jobBaseUrl = async function jobBaseUrl(
  job: Job
): Promise<string | undefined> {
  const run = job.runId ? await runsRepository.getRun(job.runId) : null;
  if (run?.baseUrl) {
    return run.baseUrl;
  }
  const intent = await (async () => {
    const awaitedValue487 = await stewardRepository.intents(job.projectId);
    return awaitedValue487.find(
      (row) => row.id === job.id || row.jobId === job.id
    );
  })();
  return intent?.intent.baseUrl;
};

export const jobEnvironment = async function jobEnvironment(job: Job) {
  const run = job.runId ? await runsRepository.getRun(job.runId) : null;
  if (run?.environment) {
    return run.environment;
  }
  const intent = await (async () => {
    const awaitedValue859 = await stewardRepository.intents(job.projectId);
    return awaitedValue859.find(
      (row) => row.id === job.id || row.jobId === job.id
    );
  })();
  return resolveRunEnvironment(
    job.projectId,
    intent?.intent.environment,
    run?.baseUrl ?? intent?.intent.baseUrl
  );
};
