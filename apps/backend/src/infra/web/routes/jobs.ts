import { access } from "../access";
import { closeChatBrowser } from "../../../core/browser/sessions";
import { enqueueIntent } from "../../../core/steward/engine";
import fs from "node:fs/promises";
import path from "node:path";
import { proposalDirectory, type ProposalVerification } from "../../../core/jobs/verification";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { abortChatTurn, isChatBusy } from "../../../core/chat/chat-registry";
import { applyProposal } from "../../../core/jobs/proposals";
import { projectOverview } from "../../../core/jobs/overview";
import { createJobSchema, reviewSchema, selectSpecBatchSchema } from "../../../core/jobs/schemas";
import { presentSpecBatch, selectSpecBatch } from "../../../core/jobs/spec-batches";
import { drainJobs, enqueueJob } from "../../../core/jobs/worker";
import { ACTIVE_JOB_STATUSES } from "../../../core/jobs/shared";
import { jobsRepository, type InboxItem, type Job } from "../../repositories/jobs";
import { projectsRepository } from "../../repositories/projects";
import { chatsRepository } from "../../repositories/chats";
import { chatTitle, createChat, startChatTurn } from "../../../core/chat/session";
import { sanitizeTechnicalDetails } from "../../../core/jobs/presentation-errors";


async function projectJob(projectId: string, jobId: string) {
    const job = await jobsRepository.get(jobId);
    if (!job || job.projectId !== projectId) throw new HTTPException(404, { message: "Job not found" });
    return job;
}

async function projectItem(projectId: string, itemId: string, message = "Inbox item not found") {
    const item = await jobsRepository.item(itemId);
    if (!item || item.projectId !== projectId) throw new HTTPException(404, { message });
    return item;
}

async function sourceChatForItem(item: InboxItem): Promise<string | undefined> {
    const job = await jobsRepository.get(item.jobId);
    for (const id of [item.payload.discussionChatId, item.payload.sourceChatId, job?.sourceChatId]) {
        if (typeof id !== "string") continue;
        const chat = await chatsRepository.getChatRow(id);
        if (chat?.projectId === item.projectId) return chat.id;
    }
    return undefined;
}

async function cancelJob(job: Job, classification?: Job["classification"]): Promise<boolean> {
    if (!ACTIVE_JOB_STATUSES.includes(job.status)) return false;
    await jobsRepository.update(job.id, { status: "cancelled", ...(classification ? { classification } : {}) });
    if (isChatBusy(job.chatId)) await Promise.allSettled([abortChatTurn(job.chatId), closeChatBrowser(job.chatId)]);
    return true;
}

export function createJobsRouter(): Hono {
    const router = new Hono();
    router.get("/projects/:id/overview", access("viewer"), async (c) => {
        if (!await projectsRepository.getProject(c.req.param("id"))) throw new HTTPException(404, { message: "Project not found" });
        return c.json(await projectOverview(c.req.param("id")));
    });
    router.use("/projects/:id/jobs/*", async (c, next) => {
        if (!await projectsRepository.getProject(c.req.param("id")!)) throw new HTTPException(404, { message: "Project not found" });
        await next();
    });
    router.get("/projects/:id/jobs", access("viewer"), async (c) => c.json({ jobs: await jobsRepository.list(c.req.param("id")) }));
    router.post("/projects/:id/jobs", access("editor"), zValidator("json", createJobSchema), async (c) => {
        return c.json({ job: await enqueueJob(c.req.param("id"), c.req.valid("json")) }, 202);
    });
    router.get("/projects/:id/jobs/:jobId", access("viewer"), async (c) => {
        const job = await projectJob(c.req.param("id"), c.req.param("jobId"));
        return c.json({ job, actions: await jobsRepository.actions(job.id) });
    });
    router.post("/projects/:id/jobs/:jobId/cancel", access("editor"), async (c) => {
        const job = await projectJob(c.req.param("id"), c.req.param("jobId"));
        if (!await cancelJob(job)) throw new HTTPException(409, { message: "Job already stopped" });
        await jobsRepository.log(job.id, "cancelled", "Cancelled by human");
        return c.json({ ok: true });
    });
    router.get("/projects/:id/inbox/:itemId/evidence/:file{.+}", access("viewer"), async (c) => {
        const item = await projectItem(c.req.param("id"), c.req.param("itemId"));
        const verification = item.payload.verification as ProposalVerification | undefined;
        const file = c.req.param("file");
        if (!verification || !verification.screenshots.includes(file) || !/^evidence\/step-\d{2,3}\.png$/.test(file)) throw new HTTPException(404, { message: "Evidence not found" });
        const directory = proposalDirectory(item, verification.id);
        const target = path.join(directory, file);
        if (await fs.realpath(target) !== target) throw new HTTPException(400, { message: "Invalid artifact path" });
        return c.body(new Uint8Array(await fs.readFile(target)), 200, { "Content-Type": "image/png", "Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff" });
    });
    router.post("/projects/:id/inbox/:itemId/promote", access("editor"), async (c) => {
        const item = await projectItem(c.req.param("id"), c.req.param("itemId"));
        if (item.kind !== "bug_report") throw new HTTPException(400, { message: "Only bug reports can be promoted to regression coverage" });
        const intent = await enqueueIntent(item.projectId, {
            kind: "coverage", priority: 90,
            reason: `Regression coverage for ${item.title}`.slice(0, 2000),
            goal: `The human requested a regression Spec for this bug. Inspect existing coverage, reproduce the issue and propose a new Spec or a behavior change in Inbox. Do not silently edit spec.yml.
${item.title}
${item.body}`.slice(0, 6000),
        }, `regression:${item.id}`, "user", { sourceChatId: await sourceChatForItem(item) });
        await jobsRepository.updateItem(item.id, { payload: { ...item.payload, regressionIntentId: intent.id } });
        return c.json({ intentId: intent.id }, 202);
    });
    router.post("/projects/:id/inbox/:itemId/select", access("editor"), zValidator("json", selectSpecBatchSchema), async (c) => {
        const item = await projectItem(c.req.param("id"), c.req.param("itemId"), "Suggestion not found");
        try {
            const selected = await selectSpecBatch(item, c.req.valid("json").candidateIds);
            return c.json({ item: { ...selected, payload: { ...selected.payload, specBatch: await presentSpecBatch(selected) } } }, 202);
        } catch (error) {
            throw new HTTPException(409, { message: sanitizeTechnicalDetails(error instanceof Error ? error.message : String(error)) });
        }
    });
    router.post("/projects/:id/inbox/:itemId/discuss", access("editor"), async (c) => {
        const item = await projectItem(c.req.param("id"), c.req.param("itemId"));
        const existing = await sourceChatForItem(item);
        if (existing) return c.json({ chatId: existing });
        const chat = await createChat(item.projectId, {}, chatTitle(item.title));
        await jobsRepository.updateItem(item.id, { payload: { ...item.payload, discussionChatId: chat.id } });
        startChatTurn(chat.id, `Help me understand this suggestion and decide what to do. Explain it in plain English. Do not change files unless I ask you to.\n${item.title}\n${sanitizeTechnicalDetails(item.body)}\nSuggestion reference: ${item.id}.`);
        return c.json({ chatId: chat.id });
    });
    router.post("/projects/:id/inbox/:itemId/review", access("editor"), zValidator("json", reviewSchema), async (c) => {
        const item = await projectItem(c.req.param("id"), c.req.param("itemId"));
        const { action, answer } = c.req.valid("json");
        const job = await jobsRepository.get(item.jobId);
        const proposal = ["spec_fix", "new_spec", "feature"].includes(item.kind);
        if ((action === "approve" || action === "reject") && !proposal) throw new HTTPException(400, { message: "This item is not a proposal" });
        if (action === "report_bug" && item.kind !== "spec_fix") throw new HTTPException(400, { message: "Only a suggested check update can be marked as an app bug" });
        if (action === "answer" && (item.kind !== "question" || !answer)) throw new HTTPException(400, { message: "Provide an answer to a question" });
        if (action === "answer" && (!job || job.status !== "blocked" || isChatBusy(job.chatId))) {
            throw new HTTPException(409, { message: "Wait for the job to pause before answering" });
        }
        if (!await jobsRepository.claimItem(item.id)) throw new HTTPException(409, { message: "This item has already been reviewed" });
        try {
            if (action === "approve") {
                const commitSha = await applyProposal(item);
                await jobsRepository.updateItem(item.id, { status: "approved", commitSha });
            } else if (action === "answer") {
                await jobsRepository.answer(item, answer!);
                void drainJobs();
            } else if (action === "report_bug") {
                const params = item.payload.params as { specId?: string } | undefined;
                const existing = (await jobsRepository.inbox(item.projectId)).find((other) => other.kind === "bug_report" && other.payload.sourceItemId === item.id);
                if (!existing) await jobsRepository.addItem({ projectId: item.projectId, jobId: item.jobId, kind: "bug_report",
                    title: "You marked this as a problem in the app. Add a regression Spec?",
                    body: "The suggested update was declined. The existing check and expected behavior are unchanged.",
                    payload: { sourceItemId: item.id, specId: params?.specId ?? job?.specId, runId: job?.runId, language: "en" } });
                await jobsRepository.updateItem(item.id, { status: "rejected" });
                if (job) await cancelJob(job, "application_bug");
            } else if (action === "ignore") {
                await jobsRepository.updateItem(item.id, { status: "dismissed", payload: { ...item.payload, ignoredCheck: true } });
                if (job) await cancelJob(job);
            } else {
                await jobsRepository.updateItem(item.id, { status: action === "reject" ? "rejected" : "dismissed" });
            }
            await jobsRepository.log(item.jobId, `inbox:${action}`, item.id);
            return c.json({ item: await jobsRepository.item(item.id) });
        } catch (error) {
            await jobsRepository.updateItem(item.id, { status: "pending" });
            throw new HTTPException(409, { message: error instanceof Error ? error.message : String(error) });
        }
    });
    return router;
}
