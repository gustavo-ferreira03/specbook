import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { getSecuritySettings, securitySettingsSchema, updateSecuritySettings } from "../../../core/chat/safety-settings";
import { access } from "../access";

export function createSafetySettingsRouter(): Hono {
    const router = new Hono();
    router.get("/settings/security", access("admin"), async (c) => c.json(await getSecuritySettings()));
    router.put("/settings/security", access("admin"), zValidator("json", securitySettingsSchema), async (c) => {
        return c.json(await updateSecuritySettings(c.req.valid("json")));
    });
    return router;
}
