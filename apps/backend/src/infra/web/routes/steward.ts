import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { dailyBudget } from "../../../core/steward/engine";
import { projectPresentation } from "../../../core/jobs/presentation";
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
        const { activity, summary } = await projectPresentation(id);
        return c.json({ activity, summary });
    });
    return router;
}
