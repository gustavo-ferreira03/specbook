import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { cleanupRetention } from "../../../core/operations/retention";
import { retentionSettingsSchema } from "../../../core/operations/schemas";
import { settingsRepository } from "../../repositories/settings";
import { access } from "../access";

export function createOperationsRouter(): Hono {
    const router = new Hono();
    router.get("/settings/retention", access("admin"), async (c) => c.json(await settingsRepository.getRetention()));
    router.put("/settings/retention", access("admin"), zValidator("json", retentionSettingsSchema), async (c) => {
        await settingsRepository.updateRetention(c.req.valid("json"));
        return c.json(await settingsRepository.getRetention());
    });
    router.post("/settings/retention/cleanup", access("admin"), async (c) => {
        await cleanupRetention();
        return c.json(await settingsRepository.getRetention());
    });
    return router;
}
