import { z } from "zod";
import { jobsRepository, type InboxItem } from "../../infra/repositories/jobs";
import { specsRepository } from "../../infra/repositories/specs";
import { stewardRepository } from "../../infra/repositories/steward";
import { createChat } from "../chat/session-store";
import { jobLimitsSchema } from "../jobs/schemas";
import { markdownHashOf, sourceHashOf } from "../repo/writer";

const selectionSchema = z.array(z.object({ id: z.string().uuid(), sourceHash: z.string(), markdownHash: z.string() })).min(1);

async function queueRegeneration(item: InboxItem): Promise<void> {
    const selected = selectionSchema.parse(item.payload.regenerationSpecs);
    const { enqueueIntent } = await import("./engine");
    for (const target of selected) {
        const spec = await specsRepository.getSpec(target.id);
        if (!spec || spec.projectId !== item.projectId || spec.status !== "invalid"
            || spec.sourceHash !== target.sourceHash || spec.markdownHash !== target.markdownHash) continue;
        await enqueueIntent(item.projectId, { kind: "regenerate", specIds: [spec.id], priority: 80,
            goal: `Regenerate the implementation of “${spec.title}” from its existing behavior contract. Propose and verify the replacement without changing spec.yml.`,
            reason: "You requested regeneration of these checks.",
        }, `regeneration:${item.id}:${spec.id}`, "user");
    }
    await jobsRepository.transition(item.jobId, "blocked", "completed");
    await jobsRepository.updateItem(item.id, { status: "answered", answer: "Regenerate the selected checks and submit verified changes for review." });
}

/** Called under the project lock; indexing alone must never launch an LLM repair. */
export async function syncRegenerationDecision(projectId: string): Promise<void> {
    const [specs, intents, jobs, inbox] = await Promise.all([specsRepository.listSpecs(projectId), stewardRepository.intents(projectId), jobsRepository.list(projectId), jobsRepository.inbox(projectId)]);
    for (const intent of intents.filter((row) => row.source === "event" && row.intent.kind === "regenerate" && ["pending", "running"].includes(row.status))) {
        await stewardRepository.updateIntent(intent.id, { status: "ignored", reason: "Regenerating invalid checks requires a human request." });
    }
    for (const job of jobs.filter((job) => job.kind === "regenerate" && !["manual", "chat"].includes(job.trigger)
        && !intents.some((row) => row.source === "user" && (row.jobId === job.id || row.id === job.id)))) {
        if (["queued", "running", "paused", "blocked", "stalled"].includes(job.status)) await jobsRepository.transition(job.id, job.status, "cancelled");
        for (const item of inbox.filter((item) => item.jobId === job.id && item.kind === "question" && ["pending", "applying"].includes(item.status))) {
            await jobsRepository.updateItem(item.id, { status: "dismissed", payload: { ...item.payload, retiredByScope: true } });
        }
    }
    const recovering = inbox.filter((item) => item.payload.regenerationAccepted === true && ["pending", "applying"].includes(item.status));
    for (const item of recovering) await queueRegeneration(item);
    const currentIntents = recovering.length ? await stewardRepository.intents(projectId) : intents;
    const currentInbox = recovering.length ? await jobsRepository.inbox(projectId) : inbox;
    const requested = new Set(currentIntents.filter((row) => row.source === "user" && row.intent.kind === "regenerate" && (row.status === "pending"
        || row.status === "running" && jobs.some((job) => job.id === (row.jobId ?? row.id) && ["queued", "running", "paused", "blocked", "stalled"].includes(job.status))))
        .flatMap((row) => row.intent.specIds ?? []));
    const decisions = currentInbox.filter((item) => Array.isArray(item.payload.regenerationSpecs));
    const declined = decisions.filter((item) => item.status === "dismissed" && !item.payload.retiredByScope && !item.payload.regenerationAccepted)
        .flatMap((item) => selectionSchema.safeParse(item.payload.regenerationSpecs).data ?? []);
    const targets = specs.filter((spec) => spec.status === "invalid" && !requested.has(spec.id)
        && !declined.some((target) => target.id === spec.id && target.sourceHash === spec.sourceHash && target.markdownHash === spec.markdownHash)
        && !currentInbox.some((item) => {
            if (item.kind !== "spec_fix" || !["pending", "applying"].includes(item.status)) return false;
            const params = item.payload.params as { specId?: string } | undefined;
            const before = item.payload.before as { yaml?: string; testSource?: string | null } | undefined;
            const verification = item.payload.verification as { status?: string } | undefined;
            return params?.specId === spec.id && typeof before?.yaml === "string"
                && markdownHashOf(before.yaml) === spec.markdownHash
                && (before.testSource === null ? "" : typeof before.testSource === "string" ? sourceHashOf(before.testSource) : null) === spec.sourceHash
                && (!item.payload.requiresVerification || verification?.status === "passed");
        }));
    const selection = targets.map((spec) => ({ id: spec.id, sourceHash: spec.sourceHash, markdownHash: spec.markdownHash })).sort((a, b) => a.id.localeCompare(b.id));
    const key = JSON.stringify(selection);
    for (const item of decisions.filter((item) => ["pending", "applying"].includes(item.status) && JSON.stringify(item.payload.regenerationSpecs) !== key)) {
        await jobsRepository.updateItem(item.id, { status: "dismissed", payload: { ...item.payload, retiredByScope: true } });
        await jobsRepository.transition(item.jobId, "blocked", "completed");
    }
    if (!targets.length || decisions.some((item) => !item.payload.retiredByScope && JSON.stringify(item.payload.regenerationSpecs) === key)) return;
    const older = targets.every((spec) => /missing spec\.ts/i.test(spec.invalidReason ?? ""));
    const title = older ? `${targets.length} ${targets.length === 1 ? "check was" : "checks were"} created by an older version. Regenerate?`
        : `${targets.length} ${targets.length === 1 ? "check cannot" : "checks cannot"} run. Regenerate?`;
    const chat = await createChat(projectId);
    const job = await jobsRepository.create({ projectId, chatId: chat.id, trigger: "steward", kind: "review", status: "blocked", goal: title, limits: jobLimitsSchema.parse({}) });
    await jobsRepository.addItem({ projectId, jobId: job.id, kind: "question", title,
        body: "Regeneration will rebuild the executable checks from their saved steps and expected results. Each change will be tested and proposed for your review; the behavior contract stays unchanged.",
        payload: { regenerationSpecs: selection, checkTitles: targets.map((spec) => spec.title), language: "en" } });
}

export async function acceptRegeneration(item: InboxItem): Promise<void> {
    const selected = selectionSchema.parse(item.payload.regenerationSpecs);
    for (const target of selected) {
        const spec = await specsRepository.getSpec(target.id);
        if (!spec || spec.projectId !== item.projectId || spec.status !== "invalid" || spec.sourceHash !== target.sourceHash || spec.markdownHash !== target.markdownHash) {
            throw new Error("The selected checks changed. Refresh Overview before requesting regeneration.");
        }
    }
    const accepted = { ...item, payload: { ...item.payload, regenerationAccepted: true } };
    await jobsRepository.updateItem(item.id, { payload: accepted.payload });
    await queueRegeneration(accepted);
}
