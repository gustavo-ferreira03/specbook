import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { getChatBrowser, getOrCreateChatBrowser } from "../../../core/browser/sessions";
import { deleteChatData, ResourceBusyError } from "../../../core/deletion";
import {
    createChat,
    getChatMessages,
    isChatBusy,
    isChatDeleting,
    listChats,
    publishChatUpdate,
    runChatTurn,
    subscribeToChatUpdates,
} from "../../../core/chat/session";
import { chatsRepository } from "../../repositories/chats";
import { projectContextsRepository } from "../../repositories/project-contexts";
import { projectsRepository } from "../../repositories/projects";

const messageSchema = z.object({ text: z.string().trim().min(1) });

export function createChatsRouter(): Hono {
    const router = new Hono();

    router.post("/projects/:id/chats", async (c) => {
        const project = await projectsRepository.getProject(c.req.param("id"));
        if (!project) throw new HTTPException(404, { message: "Project not found" });
        return c.json({ chat: await createChat(project.id) });
    });

    router.get("/projects/:id/chats", async (c) => {
        const project = await projectsRepository.getProject(c.req.param("id"));
        if (!project) throw new HTTPException(404, { message: "Project not found" });
        return c.json({ chats: await listChats(project.id) });
    });

    router.get("/chats/:id", async (c) => {
        const id = c.req.param("id");
        const [row, messages] = await Promise.all([chatsRepository.getChatRow(id), getChatMessages(id)]);
        if (!row || !messages) throw new HTTPException(404, { message: "Chat not found" });
        const chat = (await listChats(row.projectId)).find((item) => item.id === id);
        const browser = await getChatBrowser(id);
        const revision = row.contextRevisionId
            ? await projectContextsRepository.getProjectContextRevision(row.contextRevisionId)
            : null;
        return c.json({
            title: chat?.title ?? "Chat",
            messages,
            busy: isChatBusy(id),
            vncSessionId: browser?.vnc.id ?? null,
            projectId: row.projectId,
            mode: chatsRepository.chatMode(row),
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

    router.get("/chats/:id/events", async (c) => {
        const id = c.req.param("id");
        if (!(await chatsRepository.getChatRow(id))) throw new HTTPException(404, { message: "Chat not found" });
        return streamSSE(c, async (stream) => {
            const notify = () => void stream.writeSSE({ event: "updated", data: "" }).catch(() => undefined);
            const unsubscribe = subscribeToChatUpdates(id, notify);
            stream.onAbort(unsubscribe);
            await stream.writeSSE({ event: "connected", data: "" });
            await new Promise<void>((resolve) => stream.onAbort(resolve));
        });
    });

    router.delete("/chats/:id", async (c) => {
        try {
            if (!(await deleteChatData(c.req.param("id")))) {
                throw new HTTPException(404, { message: "Chat not found" });
            }
            return c.body(null, 204);
        } catch (error) {
            if (error instanceof HTTPException) throw error;
            if (error instanceof ResourceBusyError) throw new HTTPException(409, { message: error.message });
            throw error;
        }
    });

    router.post("/chats/:id/browser", async (c) => {
        const id = c.req.param("id");
        const row = await chatsRepository.getChatRow(id);
        if (!row) throw new HTTPException(404, { message: "Chat not found" });
        if (isChatDeleting(id)) throw new HTTPException(409, { message: "Chat is being deleted" });
        const project = await projectsRepository.getProject(row.projectId);
        if (!project) throw new HTTPException(404, { message: "Project not found" });
        if (!(await chatsRepository.getChatRow(id))) throw new HTTPException(404, { message: "Chat not found" });
        const revision = row.contextRevisionId
            ? await projectContextsRepository.getProjectContextRevision(row.contextRevisionId)
            : null;
        if (row.contextRevisionId && revision?.status !== "draft") {
            throw new HTTPException(409, { message: "This discovery is closed" });
        }
        const browser = await getOrCreateChatBrowser(id);
        await browser.mcp.navigate(revision?.brief.startUrl ?? project.baseUrl);
        publishChatUpdate(id);
        return c.json({ vncSessionId: browser.vnc.id });
    });

    router.post("/chats/:id/message", zValidator("json", messageSchema), async (c) => {
        const id = c.req.param("id");
        const row = await chatsRepository.getChatRow(id);
        if (!row) throw new HTTPException(404, { message: "Chat not found" });
        if (row.contextRevisionId) {
            const revision = await projectContextsRepository.getProjectContextRevision(row.contextRevisionId);
            if (revision?.status !== "draft") throw new HTTPException(409, { message: "This discovery is closed" });
        }
        if (isChatDeleting(id)) throw new HTTPException(409, { message: "Chat is being deleted" });
        if (isChatBusy(id)) throw new HTTPException(409, { message: "The agent is still replying" });
        const { text } = c.req.valid("json");
        void runChatTurn(id, text).catch(console.error);
        return c.json({ ok: true });
    });

    return router;
}
