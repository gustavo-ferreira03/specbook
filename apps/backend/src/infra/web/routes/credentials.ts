import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
    createProfile,
    listPublicProfiles,
    updateProfile,
} from "../../../core/credentials/profiles";
import { credentialsRepository } from "../../repositories/credentials";
import { projectsRepository } from "../../repositories/projects";

const fieldSchema = z.object({
    key: z.string().min(1),
    secret: z.boolean(),
    value: z.string().optional(),
});

const createSchema = z.object({
    name: z.string().min(1),
    allowedOrigins: z.array(z.string()).optional(),
    fields: z.array(fieldSchema).min(1),
});

const updateSchema = z.object({
    allowedOrigins: z.array(z.string()).optional(),
    fields: z.array(fieldSchema).min(1),
});

function mapDomainError(error: unknown): never {
    if (error instanceof Error && /Invalid|Duplicate|already exists|collides|needs a value|at least one field/.test(error.message)) {
        throw new HTTPException(400, { message: error.message });
    }
    throw error;
}

export function createCredentialsRouter(): Hono {
    const router = new Hono();

    router.get("/projects/:id/credentials", async (c) => {
        const project = await projectsRepository.getProject(c.req.param("id"));
        if (!project) throw new HTTPException(404, { message: "Project not found" });
        return c.json({ profiles: await listPublicProfiles(project.id) });
    });

    router.post("/projects/:id/credentials", zValidator("json", createSchema), async (c) => {
        const project = await projectsRepository.getProject(c.req.param("id"));
        if (!project) throw new HTTPException(404, { message: "Project not found" });
        const profile = await createProfile(project.id, c.req.valid("json")).catch(mapDomainError);
        return c.json({ profile });
    });

    router.put("/credentials/:id", zValidator("json", updateSchema), async (c) => {
        const row = await credentialsRepository.getProfile(c.req.param("id"));
        if (!row) throw new HTTPException(404, { message: "Credential profile not found" });
        const profile = await updateProfile(row, c.req.valid("json")).catch(mapDomainError);
        return c.json({ profile });
    });

    router.delete("/credentials/:id", async (c) => {
        const row = await credentialsRepository.getProfile(c.req.param("id"));
        if (!row) throw new HTTPException(404, { message: "Credential profile not found" });
        await credentialsRepository.deleteProfile(row.id);
        return c.body(null, 204);
    });

    return router;
}
