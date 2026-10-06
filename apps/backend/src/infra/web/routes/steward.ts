import { zValidator } from "@hono/zod-validator";
import crypto from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { pauseAgentJobs, resumeAgentJobs } from "../../../core/jobs/worker";
import { isAgentPaused } from "../../../core/jobs/pause";
import { enqueueIntent, processProjectSteward, withProjectLock } from "../../../core/steward/engine";
import { jobsRepository } from "../../repositories/jobs";
import { projectsRepository } from "../../repositories/projects";
import { settingsRepository } from "../../repositories/settings";
import { stewardRepository } from "../../repositories/steward";

const settingsSchema = z.object({ autonomy: z.enum(["observe", "propose", "act"]).optional(), paused: z.boolean().optional() }).strict()
    .refine((input) => input.autonomy !== undefined || input.paused !== undefined, "Provide an autonomy setting or pause state");
const taskSchema = z.object({ kind: z.enum(["coverage", "explore"]), goal: z.string().trim().min(1).max(6000).optional() }).strict();

export function createStewardRouter(): Hono {
    const router = new Hono();
    const check = async (id: string) => {
        if (!await projectsRepository.getProject(id)) throw new HTTPException(404, { message: "Project not found" });
    };
    router.get("/projects/:id/steward", async (c) => {
        const id = c.req.param("id");
        await check(id);
        const row = await stewardRepository.get(id);
        return c.json({ autonomy: row.autonomy, paused: row.paused, globallyPaused: await settingsRepository.getAgentPaused() });
    });
    router.put("/projects/:id/steward", zValidator("json", settingsSchema), async (c) => {
        const id = c.req.param("id");
        await check(id);
        const previous = await stewardRepository.get(id);
        const patch = c.req.valid("json");
        await stewardRepository.update(id, patch);
        if (previous.autonomy === "observe" && patch.autonomy && patch.autonomy !== "observe") await stewardRepository.resumeObserved(id);
        if (patch.paused === true) await pauseAgentJobs(id);
        else if (patch.paused === false) await resumeAgentJobs(id);
        const row = await stewardRepository.get(id);
        return c.json({ autonomy: row.autonomy, paused: row.paused, globallyPaused: await settingsRepository.getAgentPaused() });
    });
    router.post("/projects/:id/tasks", zValidator("json", taskSchema), async (c) => {
        const id = c.req.param("id");
        await check(id);
        const input = c.req.valid("json");
        const goal = input.goal ?? (input.kind === "coverage"
            ? "Compare confirmed project areas, roles and rules with existing Specs and propose coverage for uncovered behavior."
            : "Explore the app under the discovery browser policy and report reproducible bugs with evidence. Ask when access or a human decision is needed.");
        const intent = await withProjectLock(id, async () => {
            const jobs = await jobsRepository.list(id);
            const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
            const existing = (await stewardRepository.intents(id)).find((row) => row.source === "user"
                && row.intent.kind === input.kind && normalize(row.intent.goal) === normalize(goal)
                && (row.status === "pending" || row.status === "running" && jobs.some((job) => job.id === (row.jobId ?? row.id)
                    && ["queued", "running", "paused", "blocked", "stalled"].includes(job.status))));
            return existing ?? enqueueIntent(id, { kind: input.kind, goal, priority: 70,
                reason: input.kind === "coverage" ? "You requested a coverage review." : "You requested an exploration of the app.",
            }, `manual-task:${crypto.randomUUID()}`, "user");
        });
        await processProjectSteward(id, false);
        const job = await jobsRepository.get(intent.jobId ?? intent.id);
        const status = await isAgentPaused(id) ? "paused" : job?.status === "running" ? "running" : "queued";
        return c.json({ intentId: intent.id, status }, 202);
    });
    return router;
}
