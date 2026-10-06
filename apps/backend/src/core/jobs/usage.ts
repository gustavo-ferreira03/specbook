import type { Job } from "../../infra/repositories/jobs";

export function allocationFor(kind: string) {
    return {
        maxTokens: kind === "planner" ? 40_000 : ["regenerate", "failure_triage", "triage"].includes(kind) ? 150_000 : 100_000,
        wallTimeMs: kind === "planner" ? 120_000 : 600_000,
        maxActions: kind === "planner" ? 8 : 80,
    };
}

export function dailyUsageFor(job: Job, date = new Date().toISOString().slice(0, 10)) {
    if (job.dailyUsage?.date === date) return job.dailyUsage;
    if (!job.dailyUsage && job.updatedAt.slice(0, 10) === date) return { date, tokens: job.tokensUsed, wallTimeMs: job.elapsedMs };
    return { date, tokens: 0, wallTimeMs: 0 };
}
