import { jobsRepository, type Job } from "../../infra/repositories/jobs";
import { createProjectScrubber } from "../credentials/scrub";
import { specsRepository } from "../../infra/repositories/specs";
import { isAgentPaused } from "./pause";
import { sanitizeTechnicalDetails } from "./presentation-errors";

export const MAX_SAFETY_RETRIES = 2;

async function askAboutStalledWork(job: Job): Promise<void> {
    const existing = (await jobsRepository.inbox(job.projectId)).some((item) => item.jobId === job.id && item.kind === "question" && ["pending", "applying"].includes(item.status));
    if (existing) return;
    let spec = job.specId ? await specsRepository.getSpec(job.specId) : null;
    const source = job.kind === "generate_spec" ? (await jobsRepository.inbox(job.projectId)).find((item) => item.kind === "spec_batch"
        && (item.payload.specBatch as { candidates?: { jobId?: string }[] } | undefined)?.candidates?.some((candidate) => candidate.jobId === job.id)) : null;
    const candidate = (source?.payload.specBatch as { candidates?: { jobId?: string; specId?: string; title?: string }[] } | undefined)?.candidates?.find((candidate) => candidate.jobId === job.id);
    if (!spec && candidate?.specId) spec = await specsRepository.getSpec(candidate.specId);
    const name = spec?.title ?? candidate?.title;
    const scrub = createProjectScrubber(job.projectId);
    await jobsRepository.addItem({ jobId: job.id, projectId: job.projectId, kind: "question",
        title: await scrub(`I couldn’t finish ${name ? `the Spec “${name}”` : "this investigation"}. Look at it together?`),
        body: sanitizeTechnicalDetails(await scrub(`${job.stopReason ?? "The investigation has not reached a confirmed result."}\nI tried another approach but still could not confirm the expected result. Your explanation of the flow can help me continue.`)),
        payload: { waitingFor: "investigation", language: "en", specId: spec?.id ?? job.specId, runId: job.runId, ...(source ? { sourceItemId: source.id } : {}) } });
}

export async function stallJob(job: Job, fallback: string): Promise<void> {
    const current = await jobsRepository.get(job.id);
    if (current?.status !== "running") return;
    const candidates = (await jobsRepository.inbox(job.projectId)).filter((item) => item.jobId === job.id);
    const failure = candidates.map((item) => (item.payload.verification as { failReason?: string } | undefined)?.failReason).find(Boolean);
    const actions = await jobsRepository.actions(job.id);
    const lastError = [...actions].reverse().find((action) => action.action.endsWith(":error"))?.detail;
    const stopReason = await createProjectScrubber(job.projectId)(failure ?? lastError ?? fallback);
    const retryAt = current.safetyRetries < MAX_SAFETY_RETRIES ? new Date(Date.now() + 60_000 * 2 ** current.safetyRetries).toISOString() : null;
    const changed = await jobsRepository.transition(job.id, "running", "stalled", { stopReason, retryAt });
    if (changed) await jobsRepository.log(job.id, "stalled", stopReason);
}

export async function retryStalledJob(job: Job): Promise<void> {
    const current = await jobsRepository.get(job.id);
    if (!current || current.startedAt || await isAgentPaused(job.projectId)) return;
    if (current.status === "blocked" && current.safetyRetries >= MAX_SAFETY_RETRIES && current.stopReason && !current.systemError) {
        await askAboutStalledWork(current);
        return;
    }
    if (current.status !== "stalled") return;
    if (current.systemError) { await retryInfrastructure(current, current.systemError); return; }
    if (current.safetyRetries >= MAX_SAFETY_RETRIES) {
        const blocked = await jobsRepository.transition(job.id, "stalled", "blocked", { retryAt: null });
        if (blocked) await askAboutStalledWork(blocked);
        return;
    }
    if (current.retryAt && Date.parse(current.retryAt) > Date.now()) return;
    const changed = await jobsRepository.requeue(current, "stalled", {
        safetyRetries: current.safetyRetries + 1, stopReason: current.stopReason,
        pendingMessage: `Continue the unfinished investigation using a different approach. The previous attempt stopped because: ${current.stopReason ?? "it did not reach a confirmed result"}. First read the existing suggestions, failed verification and browser state. Explain what you will change in the approach before using tools. Do not repeat the same locator, timing change or browser action without new evidence. Keep spec.yml unchanged. Ask a specific question if access, missing information or a human decision is the actual blocker.`,
    });
    if (changed) await jobsRepository.log(job.id, "different_approach", `Attempt ${current.safetyRetries + 1}: ${current.stopReason ?? "No confirmed result"}`);
}

export async function retryInfrastructure(job: Job, error: string): Promise<void> {
    const current = await jobsRepository.get(job.id);
    if (!current || !["running", "blocked", "stalled"].includes(current.status)) return;
    const message = await createProjectScrubber(job.projectId)(error);
    const attempts = current.infrastructureRetries + 1;
    const activeMs = current.startedAt ? Math.max(0, Date.now() - Date.parse(current.startedAt)) : 0;
    const changed = await jobsRepository.requeue(current, current.status, {
        infrastructureRetries: attempts, systemError: message, safetyRetries: current.safetyRetries, stopReason: current.stopReason,
        retryAt: new Date(Date.now() + Math.min(300_000, 15_000 * 2 ** Math.min(attempts - 1, 5))).toISOString(),
        pendingMessage: "Specbook encountered an internal service problem and is retrying. Check the current state before repeating actions. This is not a question for the human; do not put browser, server or AI-provider failures in the Inbox.",
    }, { to: await isAgentPaused(job.projectId) ? "paused" : "queued", activeMs });
    if (changed) await jobsRepository.log(job.id, "service_retry", message);
}
