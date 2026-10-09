import { access } from "../access";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { submitChatCredentials } from "../../../core/chat/credential-submit";
import {
    createProfile,
    deleteProfile,
    listPublicProfiles,
    updateProfile,
} from "../../../core/credentials/profiles";
import { credentialsRepository } from "../../repositories/credentials";
import { projectsRepository } from "../../repositories/projects";

const fieldSchema = z.object({
    key: z.string().min(1),
    value: z.string().optional(),
});

const createSchema = z.object({
    name: z.string().min(1),
    allowedOrigins: z.array(z.string()).optional(),
    fields: z.array(fieldSchema).min(1),
    identifier: z.string().trim().max(320).nullable().optional(),
});

const updateSchema = z.object({
    allowedOrigins: z.array(z.string()).optional(),
    fields: z.array(fieldSchema).min(1),
    identifier: z.string().trim().max(320).nullable().optional(),
});

const requestResolutionSchema = z.union([
    z.object({ action: z.literal("dismiss") }),
    z.object({
        action: z.literal("submit"),
        values: z.record(z.string(), z.string()),
        allowedOrigins: z.array(z.string()).optional(),
    }),
]);

function mapDomainError(error: unknown): never {
    if (error instanceof Error && /Invalid|Duplicate|already exists|collides|needs a value|at least one field/.test(error.message)) {
        throw new HTTPException(400, { message: error.message });
    }
    throw error;
}

export function createCredentialsRouter(): Hono {
    const router = new Hono();

    router.get("/projects/:id/credentials", access("viewer"), async (c) => {
        const project = await projectsRepository.getProject(c.req.param("id"));
        if (!project) throw new HTTPException(404, { message: "Project not found" });
        return c.json({ profiles: await listPublicProfiles(project.id) });
    });

    router.post("/projects/:id/credentials", access("editor"), zValidator("json", createSchema), async (c) => {
        const project = await projectsRepository.getProject(c.req.param("id"));
        if (!project) throw new HTTPException(404, { message: "Project not found" });
        const profile = await createProfile(project.id, c.req.valid("json")).catch(mapDomainError);
        return c.json({ profile });
    });

    router.put("/credentials/:id", access("editor"), zValidator("json", updateSchema), async (c) => {
        const row = await credentialsRepository.getProfile(c.req.param("id"));
        if (!row) throw new HTTPException(404, { message: "Credential profile not found" });
        const profile = await updateProfile(row, c.req.valid("json")).catch(mapDomainError);
        return c.json({ profile });
    });

    router.delete("/credentials/:id", access("editor"), async (c) => {
        const row = await credentialsRepository.getProfile(c.req.param("id"));
        if (!row) throw new HTTPException(404, { message: "Credential profile not found" });
        await deleteProfile(row);
        return c.body(null, 204);
    });

    router.post(
        "/chats/:chatId/credential-requests/:requestId", access("editor"),
        zValidator("json", requestResolutionSchema),
        async (c) => {
            const chatId = c.req.param("chatId");
            const requestId = c.req.param("requestId");
            return c.json(await submitChatCredentials(chatId, requestId, c.req.valid("json")).catch(mapDomainError));
        },
    );

    return router;
}
