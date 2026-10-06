import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { environmentSchema, validateEnvironmentCredentials } from "../../../core/environments";
import { environmentsRepository } from "../../repositories/environments";
import { projectsRepository } from "../../repositories/projects";
import { access } from "../access";

const saves = new Map<string, Promise<unknown>>();

async function withEnvironmentLock<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = saves.get(projectId) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(work);
    saves.set(projectId, pending);
    try { return await pending; } finally { if (saves.get(projectId) === pending) saves.delete(projectId); }
}

export function createEnvironmentsRouter(): Hono {
    const router = new Hono();
    router.get("/projects/:id/environments", access("viewer"), async (c) => {
        if (!await projectsRepository.getProject(c.req.param("id"))) throw new HTTPException(404, { message: "Project not found" });
        return c.json({ environments: await environmentsRepository.list(c.req.param("id")) });
    });
    const save = async (projectId: string, input: typeof environmentSchema._output, id?: string) => withEnvironmentLock(projectId, async () => {
        if (!await projectsRepository.getProject(projectId)) throw new HTTPException(404, { message: "Project not found" });
        const rows = await environmentsRepository.list(projectId);
        const previous = id ? rows.find((row) => row.id === id) : undefined;
        if (id && !previous) throw new HTTPException(404, { message: "Environment not found" });
        if (previous?.name === "Production" && input.name !== "Production") throw new HTTPException(400, { message: "Keep the default environment named Production" });
        if (rows.some((row) => row.id !== id && row.name.toLowerCase() === input.name.toLowerCase())) throw new HTTPException(409, { message: "An environment with this name already exists" });
        try { await validateEnvironmentCredentials(projectId, input.credentialOverrides); }
        catch (error) { throw new HTTPException(400, { message: String(error instanceof Error ? error.message : error) }); }
        return previous ? environmentsRepository.update(previous, input) : environmentsRepository.create(projectId, input);
    });
    router.post("/projects/:id/environments", access("editor"), zValidator("json", environmentSchema), async (c) => c.json({ environment: await save(c.req.param("id"), c.req.valid("json")) }, 201));
    router.put("/projects/:id/environments/:environmentId", access("editor"), zValidator("json", environmentSchema), async (c) => c.json({ environment: await save(c.req.param("id"), c.req.valid("json"), c.req.param("environmentId")) }));
    router.delete("/projects/:id/environments/:environmentId", access("editor"), async (c) => {
        const row = (await environmentsRepository.list(c.req.param("id"))).find((environment) => environment.id === c.req.param("environmentId"));
        if (!row) throw new HTTPException(404, { message: "Environment not found" });
        if (row.name === "Production") throw new HTTPException(400, { message: "Production is the default environment and cannot be removed" });
        await environmentsRepository.delete(row.id);
        return c.body(null, 204);
    });
    return router;
}
