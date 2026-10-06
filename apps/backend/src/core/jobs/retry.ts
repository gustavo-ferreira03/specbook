import { jobsRepository, type Job } from "../../infra/repositories/jobs";
import { createProjectScrubber } from "../credentials/scrub";

export async function retryInfrastructure(job: Job, error: string): Promise<void> {
    const current = await jobsRepository.get(job.id);
    if (!current || !["running", "blocked"].includes(current.status)) return;
    const message = await createProjectScrubber(job.projectId)(error);
    const attempts = current.infrastructureRetries + 1;
    await jobsRepository.update(job.id, {
        status: "queued", infrastructureRetries: attempts, systemError: message,
        retryAt: new Date(Date.now() + Math.min(300_000, 15_000 * 2 ** Math.min(attempts - 1, 5))).toISOString(),
        pendingMessage: "Specbook encountered an internal service problem and is retrying. Check the current state before repeating actions. This is not a question for the human; do not put browser, server or AI-provider failures in the Inbox.",
    });
    await jobsRepository.log(job.id, "service_retry", message);
}
