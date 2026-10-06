import { z } from "zod";
import { chatsRepository } from "../../infra/repositories/chats";
import { jobsRepository } from "../../infra/repositories/jobs";
import { projectContextsRepository } from "../../infra/repositories/project-contexts";
import { runsRepository } from "../../infra/repositories/runs";
import { specsRepository } from "../../infra/repositories/specs";
import { getRunBatch } from "../runner/batch";
import { loadProjectState, projectPresentation } from "../jobs/presentation";
import { getActiveChatSession } from "./chat-registry";
import { getPendingCredentialRequest } from "./credential-requests";
import { extractText, openSession, toolStepsOf } from "./session-store";

type Anchor = string | null | undefined;
const artifactSchema = z.object({ id: z.string().uuid().optional(), inboxId: z.string().uuid().optional(),
    runId: z.string().uuid().optional(), specId: z.string().uuid().optional(), evidence: z.record(z.string(), z.unknown()).optional() });
const resultTools = new Set(["propose_spec_batch", "start_background_task", "run_spec", "create_spec", "update_spec", "scan_page"]);
const taskVerbs: Record<string, string> = { coverage: "Find coverage for", explore: "Explore", triage: "Investigate", failure_triage: "Investigate",
    regenerate: "Repair", run_specs: "Run", generate_spec: "Create", review: "Review" };

async function artifactsForChat(chatId: string) {
    const manager = getActiveChatSession(chatId)?.sessionManager ?? await openSession(chatId);
    const artifacts: { id: string; toolName: string; toolCallId: string; createdAt: string; afterMessageId: Anchor; value: z.infer<typeof artifactSchema> }[] = [];
    const abandonedBatchIds = new Set<string>();
    if (!manager) return { artifacts, abandonedBatchIds };
    const branch = manager.getBranch();
    const activeIds = new Set(branch.map((entry) => entry.id));
    for (const entry of manager.getEntries()) {
        if (activeIds.has(entry.id) || entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "propose_spec_batch" || entry.message.isError) continue;
        try {
            const parsed = artifactSchema.safeParse(JSON.parse(extractText(entry.message)));
            if (parsed.success && parsed.data.inboxId) abandonedBatchIds.add(parsed.data.inboxId);
        } catch {}
    }
    const steps = toolStepsOf(manager);
    const calls = new Map<string, (typeof steps)[number] | undefined>();
    for (const entry of branch) {
        if (entry.type === "message" && entry.message.role === "assistant") {
            for (const part of entry.message.content) if (part.type === "toolCall") calls.set(part.id, steps.find((step) => step.id === `${entry.id}:${part.id}`));
        }
        if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError || !resultTools.has(entry.message.toolName)) continue;
        try {
            const parsed = artifactSchema.safeParse(JSON.parse(extractText(entry.message)));
            if (!parsed.success) continue;
            const step = calls.get(entry.message.toolCallId);
            artifacts.push({ id: entry.id, toolName: entry.message.toolName, toolCallId: entry.message.toolCallId,
                createdAt: entry.timestamp, afterMessageId: step?.afterMessageId, value: parsed.data });
        } catch {}
    }
    for (const artifact of artifacts) if (artifact.toolName === "propose_spec_batch" && artifact.value.inboxId) abandonedBatchIds.delete(artifact.value.inboxId);
    return { artifacts, abandonedBatchIds };
}

function taskStatus(status: string, paused: boolean): "queued" | "working" | "needs_answer" | "paused" | "completed" | "failed" | "stopped" {
    if (status === "blocked") return "needs_answer";
    if (["queued", "pending", "running", "stalled"].includes(status) && paused || status === "paused") return "paused";
    if (["pending", "queued", "stalled"].includes(status)) return "queued";
    if (status === "running") return "working";
    if (status === "completed") return "completed";
    if (status === "failed") return "failed";
    return "stopped";
}

function scanNote(id: string, evidence: Record<string, unknown>, createdAt: string, afterMessageId: Anchor, clean: (value: string) => string) {
    const scan = evidence.scan as { title?: string; accessibility?: { total?: number }; links?: { result?: string }[] } | undefined;
    const consoleErrors = Array.isArray(evidence.consoleErrors) ? evidence.consoleErrors.length : 0;
    const networkFailures = Array.isArray(evidence.networkFailures) ? evidence.networkFailures.length : 0;
    const brokenLinks = scan?.links?.filter((link) => ["broken", "unreachable"].includes(link.result ?? "")).length ?? 0;
    return { id, title: clean(scan?.title ? `Page scan: ${scan.title}` : "Page scan"),
        body: `${consoleErrors} console errors, ${networkFailures} failed requests, ${brokenLinks} broken or unreachable links and ${scan?.accessibility?.total ?? 0} accessibility findings.`,
        technicalDetails: clean(JSON.stringify(evidence, null, 2)), createdAt, updatedAt: createdAt, afterMessageId };
}

export async function chatResults(chatId: string) {
    const chat = await chatsRepository.getChatRow(chatId);
    if (!chat) return null;
    const [state, rawItems, { artifacts, abandonedBatchIds }, revision] = await Promise.all([
        loadProjectState(chat.projectId), jobsRepository.inbox(chat.projectId), artifactsForChat(chatId),
        chat.contextRevisionId ? projectContextsRepository.getProjectContextRevision(chat.contextRevisionId) : null,
    ]);
    const allItems = rawItems.filter((item) => {
        if (item.kind !== "spec_batch" || !abandonedBatchIds.has(item.id)) return true;
        const batch = item.payload.specBatch as { candidates?: { selected?: boolean }[] } | undefined;
        return batch?.candidates?.some((candidate) => candidate.selected) ?? false;
    });
    const itemAnchors = new Map<string, Anchor>();
    const intentAnchors = new Map<string, Anchor>();
    const runAnchors = new Map<string, Anchor>();
    const specArtifacts = new Map<string, (typeof artifacts)[number]>();
    const toolAnchors = new Map(artifacts.map((artifact) => [artifact.toolCallId, artifact.afterMessageId]));
    for (const artifact of artifacts) {
        if (artifact.value.inboxId) itemAnchors.set(artifact.value.inboxId, artifact.afterMessageId);
        if (artifact.toolName === "start_background_task" && artifact.value.id) intentAnchors.set(artifact.value.id, artifact.afterMessageId);
        if (artifact.value.runId) runAnchors.set(artifact.value.runId, artifact.afterMessageId);
        if (artifact.value.specId && ["create_spec", "update_spec"].includes(artifact.toolName)) specArtifacts.set(artifact.value.specId, artifact);
    }
    const belongs = (payload: Record<string, unknown>) => payload.sourceChatId === chatId || payload.discussionChatId === chatId;
    const intents = state.intents.filter((intent) => intent.sourceChatId === chatId || intent.key.startsWith(`chat:${chatId}:`));
    for (const intent of intents) {
        if (!intentAnchors.has(intent.id)) intentAnchors.set(intent.id, toolAnchors.get(intent.key.slice(`chat:${chatId}:`.length)));
    }
    const jobIds = new Set(state.jobs.filter((job) => job.sourceChatId === chatId || job.chatId === chatId).map((job) => job.id));
    for (const intent of intents) if (intent.jobId) jobIds.add(intent.jobId);
    for (const item of allItems.filter((item) => belongs(item.payload) || itemAnchors.has(item.id))) jobIds.add(item.jobId);
    const jobAnchors = new Map<string, Anchor>();
    for (const intent of intents) if (intent.jobId) jobAnchors.set(intent.jobId, intentAnchors.get(intent.id));
    for (const item of allItems.filter((item) => belongs(item.payload) || jobIds.has(item.jobId))) {
        const anchor = itemAnchors.has(item.id) ? itemAnchors.get(item.id) : jobAnchors.get(item.jobId);
        if (item.kind === "spec_batch") {
            const batch = item.payload.specBatch as { candidates?: { jobId?: string }[] } | undefined;
            for (const candidate of batch?.candidates ?? []) if (candidate.jobId) { jobIds.add(candidate.jobId); jobAnchors.set(candidate.jobId, anchor); }
        }
        if (typeof item.payload.regressionIntentId === "string") {
            const intent = state.intents.find((intent) => intent.id === item.payload.regressionIntentId);
            if (intent && !intents.some((row) => row.id === intent.id)) intents.push(intent);
            if (intent) { intentAnchors.set(intent.id, anchor); if (intent.jobId) { jobIds.add(intent.jobId); jobAnchors.set(intent.jobId, anchor); } }
        }
    }
    const jobs = state.jobs.filter((job) => jobIds.has(job.id));
    const inbox = allItems.filter((item) => belongs(item.payload) || jobIds.has(item.jobId));
    const anchorForItem = (item: (typeof inbox)[number]) => itemAnchors.has(item.id) ? itemAnchors.get(item.id) : jobAnchors.get(item.jobId);
    const presentation = await projectPresentation(chat.projectId, { ...state, jobs, intents, signals: [] }, { inbox });
    const items = presentation.items.map((item) => ({ ...item, afterMessageId: anchorForItem(item) }));
    const notes = inbox.filter((item) => item.kind === "note" && item.payload.retiredByScope !== true).map((item) => ({
        id: item.id, title: state.clean(item.title), body: state.clean(item.body), technicalDetails: undefined as string | undefined, createdAt: item.createdAt, updatedAt: item.updatedAt, afterMessageId: anchorForItem(item),
    }));
    for (const artifact of artifacts) if (artifact.toolName === "scan_page" && artifact.value.evidence) notes.push(scanNote(artifact.id, artifact.value.evidence, artifact.createdAt, artifact.afterMessageId, state.clean));
    const actions = await jobsRepository.actionsByJob(jobs.map((job) => job.id));
    for (const job of jobs) for (const action of actions.get(job.id) ?? []) if (action.action === "page_scan") {
        try { notes.push(scanNote(`scan:${action.id}`, JSON.parse(action.detail), action.createdAt, jobAnchors.get(job.id), state.clean)); } catch {}
    }
    const paused = presentation.summary.paused || presentation.summary.globallyPaused;
    const taskTitle = (kind: string, goal: string, specId?: string | null) => {
        const spec = specId ? state.specs.find((spec) => spec.id === specId) : null;
        return state.clean(spec ? `${taskVerbs[kind] ?? "Review"} “${spec.title}”` : goal.split("\n")[0]!).replace(/\s+/g, " ").trim().slice(0, 160);
    };
    const tasks: { id: string; kind: string; title: string; status: ReturnType<typeof taskStatus>; summary: string; batchId?: string;
        createdAt: string; updatedAt: string; afterMessageId?: Anchor }[] = intents.map((intent) => {
        const job = jobs.find((job) => job.id === intent.jobId);
        const bug = items.find((item) => item.kind === "bug_report" && item.payload.regressionIntentId === intent.id);
        return { id: intent.id, kind: intent.intent.kind, title: bug ? `Create a regression Spec for “${bug.presentation.title}”` : taskTitle(intent.intent.kind, intent.intent.goal, job?.specId ?? (intent.intent.specIds?.length === 1 ? intent.intent.specIds[0] : undefined)),
            status: taskStatus(job?.status ?? intent.status, paused), summary: state.clean(intent.status === "failed" || intent.status === "ignored" ? intent.reason : intent.intent.reason),
            batchId: intent.batchId ?? undefined, createdAt: intent.createdAt, updatedAt: job?.updatedAt ?? intent.updatedAt, afterMessageId: intentAnchors.get(intent.id) };
    });
    for (const job of jobs.filter((job) => job.kind !== "review" && !intents.some((intent) => intent.jobId === job.id))) {
        const candidate = inbox.filter((item) => item.kind === "spec_batch").flatMap((item) =>
            (item.payload.specBatch as { candidates?: { jobId?: string; title?: string }[] } | undefined)?.candidates ?? []).find((candidate) => candidate.jobId === job.id);
        tasks.push({ id: job.id, kind: job.kind, title: candidate?.title ? state.clean(`Create “${candidate.title}”`) : taskTitle(job.kind, job.goal, job.specId),
            status: taskStatus(job.status, paused), summary: job.stopReason ? state.clean(job.stopReason) : "", batchId: undefined,
            createdAt: job.createdAt, updatedAt: job.updatedAt, afterMessageId: jobAnchors.get(job.id) });
    }
    const batchIds = new Map<string, string>();
    for (const intent of intents) if (intent.batchId) {
        const batch = await getRunBatch(intent.batchId);
        if (batch?.projectId !== chat.projectId) continue;
        for (const spec of batch.specs) { runAnchors.set(spec.runId, intentAnchors.get(intent.id)); batchIds.set(spec.runId, batch.id); }
    }
    for (const job of jobs) if (job.runId) runAnchors.set(job.runId, jobAnchors.get(job.id));
    for (const item of items.filter((item) => item.kind === "spec_batch")) {
        const batch = item.payload.specBatch as { candidates?: { runId?: string }[] } | undefined;
        for (const candidate of batch?.candidates ?? []) if (candidate.runId) runAnchors.set(candidate.runId, item.afterMessageId);
    }
    const runs = (await Promise.all([...runAnchors].map(async ([id, afterMessageId]) => {
        const run = await runsRepository.getRun(id);
        const spec = run ? await specsRepository.getSpec(run.specId) : null;
        if (!run || spec?.projectId !== chat.projectId) return null;
        return { id: run.id, specId: spec.id, title: spec.title, status: run.status, durationMs: run.durationMs,
            failReason: run.failReason ? state.clean(run.failReason) : null, flaky: run.flaky, startedAt: run.startedAt,
            batchId: batchIds.get(run.id), evidenceUrl: `/runs/${run.id}/evidence`, afterMessageId };
    }))).filter((run) => run !== null).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const specs = (await Promise.all([...specArtifacts].map(async ([id, artifact]) => {
        const spec = await specsRepository.getSpec(id);
        return spec?.projectId === chat.projectId ? { id: spec.id, title: spec.title, status: spec.status,
            toolName: artifact.toolName, createdAt: artifact.createdAt, afterMessageId: artifact.afterMessageId } : null;
    }))).filter((spec) => spec !== null);
    const credentialRequests = [chatId, ...jobs.map((job) => job.chatId)].flatMap((id) => {
        const request = getPendingCredentialRequest(id);
        return request?.projectId === chat.projectId ? [{ chatId: id, request, afterMessageId: jobAnchors.get(jobs.find((job) => job.chatId === id)?.id ?? "") }] : [];
    });
    return { items, tasks, notes, runs, specs, credentialRequests, contextRevision: revision?.projectId === chat.projectId ? revision : null };
}
