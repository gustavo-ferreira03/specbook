import { access } from "../access";
import { loadProject } from "../load-project";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { automationSettingsSchema, publicAutomation, updateAutomation } from "../../../core/jobs/schedules";
import { NetworkTargetError } from "../../../core/network/targets";
import { schedulesRepository } from "../../repositories/schedules";

export function createSchedulesRouter(): Hono {
    const router = new Hono();
    router.get("/projects/:id/automation", access("editor"), async (c) => {
        const id = c.req.param("id");
        await loadProject(id);
        return c.json({
            automation: publicAutomation(id, await schedulesRepository.get(id)),
            notifications: await schedulesRepository.notifications(id),
        });
    });
    router.put("/projects/:id/automation", access("editor"), zValidator("json", automationSettingsSchema), async (c) => {
        const id = c.req.param("id");
        await loadProject(id);
        try {
            return c.json({
                automation: await updateAutomation(id, c.req.valid("json")),
                notifications: await schedulesRepository.notifications(id),
            });
        } catch (error) {
            if (error instanceof NetworkTargetError || error instanceof Error && error.message === "Every selected Spec must belong to this project") {
                throw new HTTPException(400, { message: error.message });
            }
            throw error;
        }
    });
    return router;
}
