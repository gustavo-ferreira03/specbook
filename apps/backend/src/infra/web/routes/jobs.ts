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
import { proposalFiles } from "../../../core/jobs/preview";
import { createJobSchema, reviewSchema } from "../../../core/jobs/schemas";
import { drainJobs, enqueueJob } from "../../../core/jobs/worker";
import { jobsRepository } from "../../repositories/jobs";
import { projectsRepository } from "../../repositories/projects";

export function createJobsRouter(): Hono {
    const router = new Hono();
    router.use("/projects/:id/jobs/*", async (c, next) => {
        if (!await projectsRepository.getProject(c.req.param("id")!)) throw new HTTPException(404, { message: "Project not found" });
        await next();
    });
    router.get("/projects/:id/jobs", async (c) => c.json({ jobs: await jobsRepository.list(c.req.param("id")) }));
    router.post("/projects/:id/jobs", zValidator("json", createJobSchema), async (c) => {
        return c.json({ job: await enqueueJob(c.req.param("id"), c.req.valid("json")) }, 202);
    });
    router.get("/projects/:id/jobs/:jobId", async (c) => {
        const job = await jobsRepository.get(c.req.param("jobId"));
        if (!job || job.projectId !== c.req.param("id")) throw new HTTPException(404, { message: "Job not found" });
        return c.json({ job, actions: await jobsRepository.actions(job.id) });
    });
    router.post("/projects/:id/jobs/:jobId/cancel", async (c) => {
        const job = await jobsRepository.get(c.req.param("jobId"));
        if (!job || job.projectId !== c.req.param("id")) throw new HTTPException(404, { message: "Job not found" });
        if (!["queued", "running", "blocked"].includes(job.status)) throw new HTTPException(409, { message: "Job already stopped" });
        await jobsRepository.update(job.id, { status: "cancelled" });
        if (isChatBusy(job.chatId)) await Promise.all([abortChatTurn(job.chatId), closeChatBrowser(job.chatId)]);
        await jobsRepository.log(job.id, "cancelled", "Cancelled by human");
        return c.json({ ok: true });
    });
    router.get("/projects/:id/inbox", async (c) => {
        if (!await projectsRepository.getProject(c.req.param("id"))) throw new HTTPException(404, { message: "Project not found" });
        const items = await jobsRepository.inbox(c.req.param("id"));
        return c.json({ items: await Promise.all(items.map(async (item) => ({
            ...item, payload: { ...item.payload, files: await proposalFiles(item) },
        }))) });
    });
    router.get("/projects/:id/inbox/:itemId/evidence/:file{.+}", async (c) => {
        const item = await jobsRepository.item(c.req.param("itemId"));
        if (!item || item.projectId !== c.req.param("id")) throw new HTTPException(404, { message: "Inbox item not found" });
        const verification = item.payload.verification as ProposalVerification | undefined;
        const file = c.req.param("file");
        if (!verification || !verification.screenshots.includes(file) || !/^evidence\/step-\d{2,3}\.png$/.test(file)) throw new HTTPException(404, { message: "Evidence not found" });
        const directory = proposalDirectory(item, verification.id);
        const target = path.join(directory, file);
        if (await fs.realpath(target) !== target) throw new HTTPException(400, { message: "Invalid artifact path" });
        return c.body(new Uint8Array(await fs.readFile(target)), 200, { "Content-Type": "image/png", "Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff" });
    });
    router.post("/projects/:id/inbox/:itemId/promote", async (c) => {
        const item = await jobsRepository.item(c.req.param("itemId"));
        if (!item || item.projectId !== c.req.param("id")) throw new HTTPException(404, { message: "Inbox item not found" });
        if (item.kind !== "bug_report") throw new HTTPException(400, { message: "Only bug reports can be promoted to regression coverage" });
        const intent = await enqueueIntent(item.projectId, {
            kind: "coverage", priority: 90,
            reason: `Regression coverage for ${item.title}`.slice(0, 2000),
            goal: `The human requested a regression Spec for this bug. Inspect existing coverage, reproduce the issue and propose a new Spec or a behavior change in Inbox. Do not silently edit spec.yml.
${item.title}
${item.body}`.slice(0, 6000),
        }, `regression:${item.id}`);
        await jobsRepository.updateItem(item.id, { payload: { ...item.payload, regressionIntentId: intent.id } });
        return c.json({ intentId: intent.id }, 202);
    });
    router.post("/projects/:id/inbox/:itemId/review", zValidator("json", reviewSchema), async (c) => {
        const item = await jobsRepository.item(c.req.param("itemId"));
        if (!item || item.projectId !== c.req.param("id")) throw new HTTPException(404, { message: "Inbox item not found" });
        const { action, answer } = c.req.valid("json");
        const job = await jobsRepository.get(item.jobId);
        const proposal = ["spec_fix", "new_spec", "feature"].includes(item.kind);
        if ((action === "approve" || action === "reject") && !proposal) throw new HTTPException(400, { message: "This item is not a proposal" });
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
