import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { projectContextSchema } from "../core/chat/context-tools";
import { createConversation } from "../core/chat/session";
import type { DiscoveryBrief } from "../db/schema";
import {
    attachContextConversation,
    confirmProjectContextRevision,
    createProjectContextDraft,
    deleteProjectContextDraft,
    discardProjectContextRevision,
    getActiveProjectContextDraft,
    getLatestConfirmedProjectContext,
    getProjectContextRevision,
    replaceProjectContextDraft,
    updateProjectContextDraftBrief,
    withProjectContextDraftLock,
} from "../repositories/project-contexts";
import { getProject } from "../repositories/projects";

export const DEFAULT_DISCOVERY_GOAL =
    "Autonomously explore the application and map its areas, terminology, roles, business rules, and UI patterns. Record anything inaccessible or unclear as unknowns and ask the user for help only when blocked.";

const discoveryBriefSchema = z.object({
    goal: z.string().trim().min(1).max(500).optional(),
    startUrl: z.string().trim().url().optional(),
    maxActions: z.number().int().min(10).max(80).default(40),
    safetyNotes: z
        .array(z.string().trim().min(1).max(200))
        .max(20)
        .default([]),
});

const draftPatchSchema = z.object({
    context: projectContextSchema.optional(),
    maxActions: z.number().int().min(10).max(80).optional(),
});

function parseOrigin(url: string): string | null {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
        return parsed.origin;
    } catch {
        return null;
    }
}

export function resolveDiscoveryBrief(
    baseUrl: string,
    input: z.infer<typeof discoveryBriefSchema>,
): DiscoveryBrief {
    const baseOrigin = parseOrigin(baseUrl);
    if (!baseOrigin) throw new HTTPException(400, { message: "The project base URL is not a valid HTTP origin" });
    const startUrl = input.startUrl ?? baseUrl;
    const startOrigin = parseOrigin(startUrl);
    if (!startOrigin) throw new HTTPException(400, { message: "The start URL must be a valid HTTP URL" });
    if (startOrigin !== baseOrigin) {
        throw new HTTPException(400, { message: "The start URL must share the project base URL origin" });
    }
    return {
        goal: input.goal ?? DEFAULT_DISCOVERY_GOAL,
        startUrl,
        maxActions: input.maxActions,
        safetyNotes: input.safetyNotes,
    };
}

export function createProjectContextsRouter(): Hono {
    const router = new Hono();

    router.post(
        "/projects/:id/context-discoveries",
        zValidator("json", discoveryBriefSchema),
        async (c) => {
            const project = await getProject(c.req.param("id"));
            if (!project) throw new HTTPException(404, { message: "Project not found" });
            return withProjectContextDraftLock(project.id, async () => {
                const activeDraft = await getActiveProjectContextDraft(project.id);
                if (activeDraft) {
                    return c.json(
                        {
                            error: "This project already has an active context draft",
                            draft: activeDraft,
                            conversationId: activeDraft.sourceConversationId,
                        },
                        409,
                    );
                }
                const brief = resolveDiscoveryBrief(project.baseUrl, c.req.valid("json"));
                const revision = await createProjectContextDraft(project.id, brief);
                let conversation: { id: string };
                try {
                    conversation = await createConversation(project.id, { contextRevisionId: revision.id });
                } catch (error) {
                    await deleteProjectContextDraft(revision.id).catch(console.error);
                    throw error;
                }
                await attachContextConversation(revision.id, conversation.id);
                const attached = await getProjectContextRevision(revision.id);
                return c.json({ revision: attached ?? revision, conversation }, 201);
            });
        },
    );

    router.get("/projects/:id/context", async (c) => {
        const project = await getProject(c.req.param("id"));
        if (!project) throw new HTTPException(404, { message: "Project not found" });
        const [confirmed, draft] = await Promise.all([
            getLatestConfirmedProjectContext(project.id),
            getActiveProjectContextDraft(project.id),
        ]);
        return c.json({ confirmed, draft });
    });

    router.get("/project-contexts/:id", async (c) => {
        const revision = await getProjectContextRevision(c.req.param("id"));
        if (!revision) throw new HTTPException(404, { message: "Context revision not found" });
        return c.json({ revision });
    });

    router.patch("/project-contexts/:id", zValidator("json", draftPatchSchema), async (c) => {
        const revision = await getProjectContextRevision(c.req.param("id"));
        if (!revision) throw new HTTPException(404, { message: "Context revision not found" });
        if (revision.status !== "draft") {
            throw new HTTPException(409, { message: "Only draft context revisions can be edited" });
        }
        const patch = c.req.valid("json");
        let updated = revision;
        if (patch.context) {
            updated = (await replaceProjectContextDraft(revision.id, patch.context)) ?? updated;
        }
        if (patch.maxActions !== undefined) {
            updated =
                (await updateProjectContextDraftBrief(revision.id, {
                    ...updated.brief,
                    maxActions: patch.maxActions,
                })) ?? updated;
        }
        return c.json({ revision: updated });
    });

    router.post("/project-contexts/:id/confirm", async (c) => {
        const revision = await getProjectContextRevision(c.req.param("id"));
        if (!revision) throw new HTTPException(404, { message: "Context revision not found" });
        if (revision.status === "confirmed") return c.json({ revision });
        if (revision.status !== "draft") {
            throw new HTTPException(409, { message: "Only draft context revisions can be confirmed" });
        }
        if (!revision.context.summary.trim()) {
            throw new HTTPException(400, { message: "Confirmation requires a non-empty summary" });
        }
        if (revision.context.areas.length === 0 && revision.context.unknowns.length === 0) {
            throw new HTTPException(400, { message: "Confirmation requires at least one area or unknown" });
        }
        const confirmed = await confirmProjectContextRevision(revision.id);
        return c.json({ revision: confirmed ?? revision });
    });

    router.post("/project-contexts/:id/discard", async (c) => {
        const revision = await getProjectContextRevision(c.req.param("id"));
        if (!revision) throw new HTTPException(404, { message: "Context revision not found" });
        if (revision.status === "discarded") return c.json({ revision });
        if (revision.status !== "draft") {
            throw new HTTPException(409, { message: "Confirmed context revisions cannot be discarded" });
        }
        const discarded = await discardProjectContextRevision(revision.id);
        return c.json({ revision: discarded ?? revision });
    });

    return router;
}
