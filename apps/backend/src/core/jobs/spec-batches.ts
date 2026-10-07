import crypto from "node:crypto";
import { featuresRepository } from "../../infra/repositories/features";
import { jobsRepository, type InboxItem, type Job } from "../../infra/repositories/jobs";
import { runsRepository } from "../../infra/repositories/runs";
import { specsRepository } from "../../infra/repositories/specs";
import { projectsRepository } from "../../infra/repositories/projects";
import { projectContextsRepository } from "../../infra/repositories/project-contexts";
import { chatsRepository } from "../../infra/repositories/chats";
import { createChat } from "../chat/session-store";
import { createProjectScrubber } from "../credentials/scrub";
import { createFeatureInRepo, createSpecInRepo, readSpecFiles, updateSpecInRepo, validateSpec } from "../repo/writer";
import { executeSpec } from "../runner/run";
import { sanitizeTechnicalDetails } from "./presentation-errors";
import { isAgentPaused } from "./pause";
import { finishedAt } from "./shared";
import { jobLimitsSchema, newSpecProposalSchema, specBatchProposalSchema, type specCandidateSchema } from "./schemas";
import type { z } from "zod";
import type { RunEnvironment } from "../../infra/db/schema";

type Candidate = z.infer<typeof specCandidateSchema> & {
    id: string;
    selected?: boolean;
    jobId?: string;
    specId?: string;
    runId?: string;
    resolvedFeatureId?: string;
    error?: string;
};
interface SpecBatch {
    candidates: Candidate[];
    sourceChatId: string;
    contextRevisionId?: string;
    selectedAt?: string;
}
const batchLocks = new Map<string, Promise<unknown>>();

async function withBatchLock<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = batchLocks.get(id) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(work);
    batchLocks.set(id, pending);
    try { return await pending; } finally { if (batchLocks.get(id) === pending) batchLocks.delete(id); }
}

function batchOf(item: InboxItem): SpecBatch {
    if (item.kind !== "spec_batch") throw new Error("This suggestion is not a list of Specs.");
    const batch = item.payload.specBatch as SpecBatch | undefined;
    if (!batch?.candidates?.length) throw new Error("This list of Specs is incomplete. Request a new suggestion in chat.");
    return batch;
}

function stableId(value: string): string {
    const hex = crypto.createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
    hex[12] = "5";
    hex[16] = "8";
    const result = hex.join("");
    return `${result.slice(0, 8)}-${result.slice(8, 12)}-${result.slice(12, 16)}-${result.slice(16, 20)}-${result.slice(20)}`;
}

export async function proposeSpecBatch(projectId: string, chatId: string, input: unknown, options: { contextRevisionId?: string } = {}) {
    const proposed = specBatchProposalSchema.parse(input);
    const chat = await chatsRepository.getChatRow(chatId);
    if (!chat || chat.projectId !== projectId) throw new Error("This conversation belongs to another project or no longer exists.");
    if (options.contextRevisionId) {
        const context = await projectContextsRepository.getProjectContextRevision(options.contextRevisionId);
        if (!context || context.projectId !== projectId || context.status !== "draft") throw new Error("This discovery context can no longer accept suggestions.");
    }
    const features = await featuresRepository.listFeatures(projectId);
    for (const candidate of proposed.candidates) {
        if (candidate.featureId && !features.some((feature) => feature.id === candidate.featureId)) throw new Error("A suggested feature belongs to another project or no longer exists.");
        if (candidate.featureId) candidate.feature = features.find((feature) => feature.id === candidate.featureId)!.title;
    }
    const scrub = createProjectScrubber(projectId);
    const clean = specBatchProposalSchema.parse(JSON.parse(await scrub(JSON.stringify(proposed))));
    const existingJob = await jobsRepository.forChat(chatId);
    const sourceChatId = existingJob?.sourceChatId ?? chatId;
    return withBatchLock(`chat:${chatId}`, async () => {
        const existing = (await jobsRepository.inbox(projectId)).find((item) => item.kind === "spec_batch" && item.status === "pending"
            && item.payload.sourceChatId === sourceChatId && JSON.stringify(item.payload.proposed) === JSON.stringify(clean));
        if (existing) return existing;
        let job = existingJob;
        if (job && job.projectId !== projectId) throw new Error("This conversation belongs to another project.");
        if (!job) {
            const internalChat = await createChat(projectId);
            job = await jobsRepository.create({ projectId, chatId: internalChat.id, sourceChatId: chatId, trigger: "chat", kind: "review", goal: "Choose Specs to add from this conversation.", limits: jobLimitsSchema.parse({}), status: "blocked" });
            await jobsRepository.transition(job.id, "blocked", "completed");
        }
        const batch: SpecBatch = { candidates: clean.candidates.map((candidate) => ({ ...candidate, id: crypto.randomUUID() })), sourceChatId, ...options };
        const item = await jobsRepository.addItem({ projectId, jobId: job.id, kind: "spec_batch", title: clean.title,
            body: "Choose the Specs you want. Specbook will create each selected Spec, validate it and run it once.",
            payload: { proposed: clean, specBatch: batch, sourceChatId, language: "en" } });
        await jobsRepository.log(job.id, "spec_batch:proposed", item.id);
        return item;
    });
}

async function enqueueSelected(item: InboxItem): Promise<void> {
    const { enqueueJob } = await import("./worker");
    for (const candidate of batchOf(item).candidates.filter((candidate) => candidate.selected)) {
        await enqueueJob(item.projectId, { kind: "generate_spec", trigger: "chat",
            goal: `Create only the selected Spec “${candidate.title}”. Goal: ${candidate.goal}\nWhy: ${candidate.why}\nFeature: ${candidate.feature}${candidate.apiDocsUrl ? `\nRead the API documentation at ${candidate.apiDocsUrl}; do not invent request fields.` : ""}\nInspect the application as needed, write matching readable steps and deterministic TypeScript, and call create_spec. It saves the Spec and runs it once. If the run fails because the Spec is wrong (a locator, a wait, a wrong assumption about the app), inspect the live page again and call create_spec with the corrected Spec; it can be revised until its first pass, at most 3 runs. Ask through Inbox when blocked. Do not create unrelated Specs or edit existing behavior.` }, candidate.jobId, { sourceChatId: batchOf(item).sourceChatId });
    }
}

export async function selectSpecBatch(item: InboxItem, candidateIds: string[]): Promise<InboxItem> {
    return withBatchLock(item.id, async () => {
        const current = await jobsRepository.item(item.id);
        if (!current) throw new Error("This suggestion no longer exists.");
        const batch = batchOf(current);
        if (batch.contextRevisionId) {
            const context = await projectContextsRepository.getProjectContextRevision(batch.contextRevisionId);
            if (context?.status !== "confirmed") throw new Error("Review and confirm the discovery context before adding these Specs.");
        }
        const selected = new Set(candidateIds);
        if (!selected.size || selected.size !== candidateIds.length || candidateIds.some((id) => !batch.candidates.some((candidate) => candidate.id === id))) {
            throw new Error("Choose at least one Spec from this list without duplicates.");
        }
        if (current.status === "approved") {
            if (batch.candidates.some((candidate) => Boolean(candidate.selected) !== selected.has(candidate.id))) throw new Error("This list has already been selected.");
            await enqueueSelected(current);
            return current;
        }
        if (!await jobsRepository.claimItem(current.id)) throw new Error("This list has already been reviewed.");
        const candidates = batch.candidates.map((candidate) => selected.has(candidate.id) ? { ...candidate, selected: true,
            jobId: stableId(`spec-batch-job:${item.id}:${candidate.id}`), specId: stableId(`spec-batch-spec:${item.id}:${candidate.id}`) } : candidate);
        await jobsRepository.updateItem(current.id, { status: "approved", payload: { ...current.payload, specBatch: { ...batch, candidates, selectedAt: new Date().toISOString() } } });
        await jobsRepository.log(current.jobId, "spec_batch:selected", JSON.stringify({ itemId: current.id, candidateIds }));
        const approved = (await jobsRepository.item(current.id))!;
        await enqueueSelected(approved);
        return approved;
    });
}

export async function recoverSpecBatches(): Promise<void> {
    for (const project of await projectsRepository.listProjects()) {
        for (const item of await jobsRepository.inbox(project.id)) {
            if (item.kind === "spec_batch" && item.status === "approved") await enqueueSelected(item);
        }
    }
}

async function selectedCandidate(job: Job) {
    for (const item of await jobsRepository.inbox(job.projectId)) {
        if (item.kind !== "spec_batch" || item.status !== "approved") continue;
        const candidate = batchOf(item).candidates.find((candidate) => candidate.selected && candidate.jobId === job.id);
        if (candidate) return { item, candidate };
    }
    throw new Error("The human has not selected a Spec for this request.");
}

async function updateCandidate(itemId: string, candidateId: string, patch: Partial<Candidate>) {
    await withBatchLock(itemId, async () => {
        const item = await jobsRepository.item(itemId);
        if (!item) throw new Error("The selected list no longer exists.");
        const batch = batchOf(item);
        await jobsRepository.updateItem(itemId, { payload: { ...item.payload, specBatch: { ...batch,
            candidates: batch.candidates.map((candidate) => candidate.id === candidateId ? { ...candidate, ...patch } : candidate) } } });
    });
}

export async function selectedSpecInstructions(job: Job): Promise<string> {
    const { item, candidate } = await selectedCandidate(job);
    const features = await featuresRepository.listFeatures(job.projectId);
    let feature = features.find((feature) => feature.id === (candidate.resolvedFeatureId ?? candidate.featureId));
    feature ??= features.find((feature) => feature.title.trim().toLowerCase() === candidate.feature.trim().toLowerCase());
    if (!feature) feature = await createFeatureInRepo(job.projectId, null, candidate.feature, "", {
        commitMessage: `spec-batch:${item.id}:${candidate.id} organize selected Spec`,
        checkPolicy: async () => {
            if ((await jobsRepository.get(job.id))?.status !== "running" || await isAgentPaused(job.projectId)) throw new Error("The user paused this request.");
        },
    });
    await updateCandidate(item.id, candidate.id, { resolvedFeatureId: feature.id });
    return `${job.pendingMessage}\nSelected Spec reference: ${item.id}/${candidate.id}. Use featureId ${feature.id} and title ${JSON.stringify(candidate.title)} for create_spec. The selection authorizes this new Spec only. Existing spec.yml contracts remain unchanged. create_spec validates the files, saves the Spec and runs it once automatically; inspect its result rather than running again. If this Spec already exists, use run_spec to retrieve the first result. Use inbox_report to ask for prerequisites.`;
}

export async function selectedSpecResult(job: Job) {
    const { candidate } = await selectedCandidate(job);
    const spec = candidate.specId ? await specsRepository.getSpec(candidate.specId) : null;
    const run = candidate.runId ? await runsRepository.getRun(candidate.runId) : spec ? (await runsRepository.listRuns(spec.id, { limit: 1 }))[0] : null;
    return { specId: spec?.id, runId: run?.id, status: run?.status ?? "not_started", failReason: run?.failReason ?? candidate.error ?? null };
}

const MAX_DRAFT_RUNS = 3;

export async function createSelectedSpec(job: Job, input: unknown, options: { signal?: AbortSignal; checkPolicy?: () => Promise<void>; baseUrl?: string; environment?: RunEnvironment } = {}) {
    const proposed = newSpecProposalSchema.parse(input);
    const { item, candidate } = await selectedCandidate(job);
    if (proposed.title !== candidate.title || proposed.featureId !== candidate.resolvedFeatureId) throw new Error("Create only the selected Spec with its assigned title and feature.");
    const validation = validateSpec(proposed.testSource, proposed.humanSpec);
    if (!validation.ok) throw new Error(validation.error);
    await options.checkPolicy?.();
    let spec = await specsRepository.getSpec(candidate.specId!);
    let revised = false;
    if (!spec) {
        ({ spec } = await createSpecInRepo({ ...proposed, projectId: job.projectId, id: candidate.specId },
            { commitMessage: `spec-batch:${item.id}:${candidate.id} create "${candidate.title}"`, checkPolicy: options.checkPolicy }));
    } else if (spec.projectId === job.projectId) {
        // Until its first pass the new Spec is a draft: revising it cannot weaken anything that worked.
        const runs = await runsRepository.listRuns(spec.id, { limit: MAX_DRAFT_RUNS });
        const current = await readSpecFiles(spec);
        const changed = current.testSource !== proposed.testSource || JSON.stringify(current.humanSpec) !== JSON.stringify(proposed.humanSpec);
        if (changed && !runs.some((run) => run.status === "passed")) {
            if (runs.length >= MAX_DRAFT_RUNS) throw new Error(`This Spec did not pass after ${MAX_DRAFT_RUNS} runs. Stop revising it and report what failed and what you suspect.`);
            ({ spec } = await updateSpecInRepo(spec, { description: proposed.description, humanSpec: proposed.humanSpec, testSource: proposed.testSource }, { checkPolicy: options.checkPolicy }));
            revised = true;
        }
    }
    if (spec.projectId !== job.projectId) throw new Error("This selected Spec belongs to another project.");
    await jobsRepository.update(job.id, { specId: spec.id });
    await options.checkPolicy?.();
    const existing = (await runsRepository.listRuns(spec.id, { limit: 1 }))[0];
    if (existing && existing.status !== "running" && !revised) {
        await updateCandidate(item.id, candidate.id, { runId: existing.id });
        return selectedSpecResult(job);
    }
    try {
        const run = await executeSpec(spec.id, { signal: options.signal, baseUrl: options.baseUrl, environment: options.environment, automate: false, healOnFailure: false });
        await updateCandidate(item.id, candidate.id, { runId: run.id, error: undefined });
        await jobsRepository.log(job.id, "spec_batch:created", `${item.id}:${candidate.id}:${spec.id}:${run.status}`);
        return selectedSpecResult(job);
    } catch (error) {
        const scrub = createProjectScrubber(job.projectId);
        const message = sanitizeTechnicalDetails(await scrub(error instanceof Error ? error.message : String(error)));
        await updateCandidate(item.id, candidate.id, { error: message });
        throw error;
    }
}

export async function presentSpecBatch(item: InboxItem) {
    const batch = batchOf(item);
    const scrub = createProjectScrubber(item.projectId);
    const inbox = await jobsRepository.inbox(item.projectId);
    const candidates = await Promise.all(batch.candidates.map(async (candidate) => {
        const job = candidate.jobId ? await jobsRepository.get(candidate.jobId) : null;
        const spec = candidate.selected && candidate.specId ? await specsRepository.getSpec(candidate.specId) : null;
        const run = candidate.runId ? await runsRepository.getRun(candidate.runId) : spec ? (await runsRepository.listRuns(spec.id, { limit: 1 }))[0] : null;
        const question = job ? inbox.find((other) => other.jobId === job.id && other.kind === "question" && other.status === "pending") : null;
        const state = !candidate.selected ? "proposed" : run && run.status !== "running" ? run.status === "passed" ? "passed" : "failed"
            : job?.status === "blocked" ? "needs_answer" : job?.status === "running" || run?.status === "running" ? "generating"
            : ["completed", "cancelled"].includes(job?.status ?? "") || (job?.status === "stalled" && !job.retryAt) ? "stopped" : "queued";
        const error = run?.failReason ?? candidate.error ?? job?.stopReason;
        return { ...candidate, specId: spec?.id, runId: run?.id, state, questionId: question?.id,
            finishedAt: run && run.status !== "running" ? finishedAt(run) : undefined,
            error: error ? sanitizeTechnicalDetails(await scrub(error)) : undefined };
    }));
    const context = batch.contextRevisionId ? await projectContextsRepository.getProjectContextRevision(batch.contextRevisionId) : null;
    return { ...batch, candidates, contextStatus: context?.status, contextReviewRequired: Boolean(batch.contextRevisionId && context?.status !== "confirmed") };
}
