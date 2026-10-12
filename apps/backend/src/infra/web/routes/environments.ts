import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { changesPrivateDestination, environmentSchema, validateEnvironmentCredentials, withProjectEnvironmentLock } from "../../../core/environments";
import { environmentsRepository } from "../../repositories/environments";
import { access } from "../access";
import { loadProject } from "../load-project";

export function createEnvironmentsRouter(): Hono {
    const router = new Hono();
    router.get("/projects/:id/environments", access("viewer"), async (c) => {
        await loadProject(c.req.param("id"));
        return c.json({ environments: await environmentsRepository.list(c.req.param("id")) });
    });
    const save = async (projectId: string, input: typeof environmentSchema._output, adminSession: boolean, id?: string) => withProjectEnvironmentLock(projectId, async () => {
        await loadProject(projectId);
        const rows = await environmentsRepository.list(projectId);
        const previous = id ? rows.find((row) => row.id === id) : undefined;
        if (id && !previous) throw new HTTPException(404, { message: "Environment not found" });
        if (!adminSession && changesPrivateDestination(previous, input)) throw new HTTPException(403, { message: "Only administrators signed in to the web app can change runner or tunnel destinations." });
        if (previous?.name === "Production" && input.name !== "Production") throw new HTTPException(400, { message: "Keep the default environment named Production" });
        if (rows.some((row) => row.id !== id && row.name.toLowerCase() === input.name.toLowerCase())) throw new HTTPException(409, { message: "An environment with this name already exists" });
        try { await validateEnvironmentCredentials(projectId, input.credentialOverrides); }
        catch (error) { throw new HTTPException(400, { message: String(error instanceof Error ? error.message : error) }); }
        return previous ? environmentsRepository.update(previous, input) : environmentsRepository.create(projectId, input);
    });
    router.post("/projects/:id/environments", access("editor"), zValidator("json", environmentSchema), async (c) => c.json({ environment: await save(c.req.param("id"), c.req.valid("json"), c.get("user")?.role === "admin" && c.get("authentication") === "session") }, 201));
    router.put("/projects/:id/environments/:environmentId", access("editor"), zValidator("json", environmentSchema), async (c) => c.json({ environment: await save(c.req.param("id"), c.req.valid("json"), c.get("user")?.role === "admin" && c.get("authentication") === "session", c.req.param("environmentId")) }));
    router.delete("/projects/:id/environments/:environmentId", access("editor"), async (c) => {
        const row = (await environmentsRepository.list(c.req.param("id"))).find((environment) => environment.id === c.req.param("environmentId"));
        if (!row) throw new HTTPException(404, { message: "Environment not found" });
        if (row.name === "Production") throw new HTTPException(400, { message: "Production is the default environment and cannot be removed" });
        await environmentsRepository.delete(row.id);
        return c.body(null, 204);
    });
    return router;
}
