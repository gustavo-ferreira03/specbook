import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { dailyBudget } from "../../../core/steward/engine";
import { specsRepository } from "../../repositories/specs";
import { jobsRepository } from "../../repositories/jobs";
import { projectsRepository } from "../../repositories/projects";
import { stewardRepository } from "../../repositories/steward";

const settingsSchema = z.object({ autonomy: z.enum(["observe", "propose", "act"]) }).strict();

export function createStewardRouter(): Hono {
    const router = new Hono();
    const check = async (id: string) => {
        if (!await projectsRepository.getProject(id)) throw new HTTPException(404, { message: "Project not found" });
    };
    router.get("/projects/:id/steward", async (c) => {
        const id = c.req.param("id");
        await check(id);
        const row = await stewardRepository.get(id);
        return c.json({ autonomy: row.autonomy, remaining: dailyBudget(await jobsRepository.list(id)) });
    });
    router.put("/projects/:id/steward", zValidator("json", settingsSchema), async (c) => {
        const id = c.req.param("id");
        await check(id);
        const previous = await stewardRepository.get(id);
        await stewardRepository.update(id, c.req.valid("json"));
        if (previous.autonomy === "observe" && c.req.valid("json").autonomy !== "observe") await stewardRepository.resumeObserved(id);
        return c.json({ autonomy: (await stewardRepository.get(id)).autonomy, remaining: dailyBudget(await jobsRepository.list(id)) });
    });
    router.get("/projects/:id/activity", async (c) => {
        const id = c.req.param("id");
        await check(id);
        const [signals, intents, jobs, inbox, specs] = await Promise.all([
            stewardRepository.signals(id), stewardRepository.intents(id), jobsRepository.list(id), jobsRepository.inbox(id), specsRepository.listSpecs(id),
        ]);
        const activity = [
            ...signals.filter((signal) => signal.kind !== "job_completed").map((signal) => ({ id: signal.id, kind: "signal", title: signal.title, reason: signal.body, status: signal.status, createdAt: signal.createdAt })),
            ...intents.filter((intent) => !intent.jobId).map((intent) => ({ id: intent.id, kind: "signal", title: intent.intent.reason, reason: intent.reason, status: intent.status, createdAt: intent.createdAt, specId: intent.intent.specIds?.[0], runId: intent.intent.runId })),
            ...jobs.map((job) => {
                const intent = intents.find((intent) => intent.jobId === job.id);
                const pending = inbox.some((item) => item.jobId === job.id && item.status === "pending" && ["new_spec", "spec_fix", "feature", "bug_report"].includes(item.kind));
                const note = inbox.find((item) => item.jobId === job.id && item.kind === "note");
                return { id: job.id, jobId: job.id, kind: "job", title: intent?.intent.reason ?? (job.specId ? `Investigating “${specs.find((spec) => spec.id === job.specId)?.title ?? "Spec"}”` : "Reviewing the project"), reason: note?.body ?? intent?.intent.goal ?? "",
                    status: pending && job.status === "completed" ? "proposed" : job.status, createdAt: job.createdAt, specId: job.specId ?? undefined, runId: job.runId ?? undefined };
            }),
        ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200);
        return c.json({ activity });
    });
    return router;
}
