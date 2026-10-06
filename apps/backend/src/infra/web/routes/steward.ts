import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { pauseAgentJobs, resumeAgentJobs } from "../../../core/jobs/worker";
import { projectPresentation } from "../../../core/jobs/presentation";
import { projectsRepository } from "../../repositories/projects";
import { settingsRepository } from "../../repositories/settings";
import { stewardRepository } from "../../repositories/steward";

const settingsSchema = z.object({ autonomy: z.enum(["observe", "propose", "act"]).optional(), paused: z.boolean().optional() }).strict()
    .refine((input) => input.autonomy !== undefined || input.paused !== undefined, "Provide an autonomy setting or pause state");

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
    router.get("/projects/:id/activity", async (c) => {
        const id = c.req.param("id");
        await check(id);
        const { activity, summary } = await projectPresentation(id);
        return c.json({ activity, summary });
    });
    return router;
}
