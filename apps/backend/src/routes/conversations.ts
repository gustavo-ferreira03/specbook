import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { getConversationBrowser, getOrCreateConversationBrowser } from "../core/browser/sessions";
import { deleteConversationData, ResourceBusyError } from "../core/deletion";
import {
    createConversation,
    getConversationMessages,
    isConversationBusy,
    isConversationDeleting,
    listConversations,
    runConversationTurn,
} from "../core/chat/session";
import { conversationsRepository } from "../repositories/conversations";
import { projectContextsRepository } from "../repositories/project-contexts";
import { projectsRepository } from "../repositories/projects";

const messageSchema = z.object({ text: z.string().trim().min(1) });

export function createConversationsRouter(): Hono {
    const router = new Hono();

    router.post("/projects/:id/conversations", async (c) => {
        const project = await projectsRepository.getProject(c.req.param("id"));
        if (!project) throw new HTTPException(404, { message: "Project not found" });
        return c.json({ conversation: await createConversation(project.id) });
    });

    router.get("/projects/:id/conversations", async (c) => {
        const project = await projectsRepository.getProject(c.req.param("id"));
        if (!project) throw new HTTPException(404, { message: "Project not found" });
        return c.json({ conversations: await listConversations(project.id) });
    });

    router.get("/conversations/:id", async (c) => {
        const id = c.req.param("id");
        const [row, messages] = await Promise.all([conversationsRepository.getConversationRow(id), getConversationMessages(id)]);
        if (!row || !messages) throw new HTTPException(404, { message: "Conversation not found" });
        const conversation = (await listConversations(row.projectId)).find((item) => item.id === id);
        const browser = await getConversationBrowser(id);
        const revision = row.contextRevisionId
            ? await projectContextsRepository.getProjectContextRevision(row.contextRevisionId)
            : null;
        return c.json({
            title: conversation?.title ?? "Conversation",
            messages,
            busy: isConversationBusy(id),
            vncSessionId: browser?.vnc.id ?? null,
            projectId: row.projectId,
            mode: conversationsRepository.conversationMode(row),
            contextRevision: revision
                ? {
                      id: revision.id,
                      status: revision.status,
                      brief: revision.brief,
                      actionsUsed: revision.actionsUsed,
                      hasProposal: revision.context.summary.trim().length > 0,
                  }
                : null,
        });
    });

    router.delete("/conversations/:id", async (c) => {
        try {
            if (!(await deleteConversationData(c.req.param("id")))) {
                throw new HTTPException(404, { message: "Conversation not found" });
            }
            return c.body(null, 204);
        } catch (error) {
            if (error instanceof HTTPException) throw error;
            if (error instanceof ResourceBusyError) throw new HTTPException(409, { message: error.message });
            throw error;
        }
    });

    router.post("/conversations/:id/browser", async (c) => {
        const id = c.req.param("id");
        const row = await conversationsRepository.getConversationRow(id);
        if (!row) throw new HTTPException(404, { message: "Conversation not found" });
        if (isConversationDeleting(id)) throw new HTTPException(409, { message: "Conversation is being deleted" });
        const project = await projectsRepository.getProject(row.projectId);
        if (!project) throw new HTTPException(404, { message: "Project not found" });
        if (!(await conversationsRepository.getConversationRow(id))) throw new HTTPException(404, { message: "Conversation not found" });
        const revision = row.contextRevisionId
            ? await projectContextsRepository.getProjectContextRevision(row.contextRevisionId)
            : null;
        if (row.contextRevisionId && revision?.status !== "draft") {
            throw new HTTPException(409, { message: "This discovery is closed" });
        }
        const browser = await getOrCreateConversationBrowser(id);
        await browser.mcp.navigate(revision?.brief.startUrl ?? project.baseUrl);
        return c.json({ vncSessionId: browser.vnc.id });
    });

    router.post("/conversations/:id/message", zValidator("json", messageSchema), async (c) => {
        const id = c.req.param("id");
        const row = await conversationsRepository.getConversationRow(id);
        if (!row) throw new HTTPException(404, { message: "Conversation not found" });
        if (row.contextRevisionId) {
            const revision = await projectContextsRepository.getProjectContextRevision(row.contextRevisionId);
            if (revision?.status !== "draft") throw new HTTPException(409, { message: "This discovery is closed" });
        }
        if (isConversationDeleting(id)) throw new HTTPException(409, { message: "Conversation is being deleted" });
        if (isConversationBusy(id)) throw new HTTPException(409, { message: "The agent is still replying" });
        const { text } = c.req.valid("json");
        void runConversationTurn(id, text).catch(console.error);
        return c.json({ ok: true });
    });

    return router;
}
