import { jobsRepository, type Job } from "../../infra/repositories/jobs";
import { stewardRepository } from "../../infra/repositories/steward";
import { dailyBudget, processProjectSteward, withProjectLock } from "../steward/engine";
import { allocationFor, dailyUsageFor } from "./usage";
import { drainJobs } from "./worker";

export async function resumeLimitedJob(job: Job): Promise<void> {
    const allocation = allocationFor(job.kind);
    const budget = { maxTokens: job.tokensUsed + allocation.maxTokens,
        wallTimeMs: job.elapsedMs + allocation.wallTimeMs, maxActions: job.actionsUsed + allocation.maxActions };
    await jobsRepository.update(job.id, { status: "queued", budget, dailyUsage: dailyUsageFor(job), retryAt: null,
        pendingMessage: "Continue the unfinished investigation. Read the previous suggestions and results first. Improve the most recent unsuccessful candidate instead of repeating the same work. Keep spec.yml unchanged unless the human approves a behavior change." });
    const intent = (await stewardRepository.intents(job.projectId)).find((item) => item.jobId === job.id);
    if (intent) await stewardRepository.updateIntent(intent.id, { status: "running" });
    await jobsRepository.log(job.id, "continued", "Another round is available; cumulative usage is retained.");
}

export async function continueProject(projectId: string): Promise<void> {
    await withProjectLock(projectId, async () => {
        const settings = await stewardRepository.get(projectId);
        if (settings.autonomy === "observe") throw new Error("Enable suggestions in Automation settings before continuing.");
        const jobs = await jobsRepository.list(projectId);
        if (jobs.some((job) => ["queued", "running"].includes(job.status))) throw new Error("A check is already queued or running. Wait for it to finish before continuing.");
        const limited = jobs.find((job) => job.status === "budget_exceeded");
        const next = (await stewardRepository.intents(projectId)).find((intent) => intent.status === "pending");
        if (!limited && !next) throw new Error("There is no paused work to continue.");
        const allocation = allocationFor(limited?.kind ?? next!.intent.kind);
        const remaining = dailyBudget(jobs, Date.now(), settings.extraUsage);
        const date = new Date().toISOString().slice(0, 10);
        const previous = settings.extraUsage?.date === date ? settings.extraUsage : { tokens: 0, wallTimeMs: 0 };
        await stewardRepository.update(projectId, { extraUsage: { date,
            tokens: previous.tokens + Math.max(0, allocation.maxTokens - remaining.tokens),
            wallTimeMs: previous.wallTimeMs + Math.max(0, allocation.wallTimeMs - remaining.wallTimeMs),
        } });
        if (limited) await resumeLimitedJob(limited);
    });
    await processProjectSteward(projectId, false);
    void drainJobs();
}
