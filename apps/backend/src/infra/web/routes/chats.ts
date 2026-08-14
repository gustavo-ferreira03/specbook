import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { getChatBrowser, getChatBrowserActivity } from "../../../core/browser/sessions";
import { getPendingCredentialRequest } from "../../../core/chat/credential-requests";
import { deleteChatData, ResourceBusyError } from "../../../core/deletion";
import {
    createChat,
    branchChatForTurn,
    getChatMessages,
    getChatQueueState,
    isChatBusy,
    isChatDeleting,
    listChats,
    abortChatTurn,
    queueChatFollowUp,
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
        const browserActivity = getChatBrowserActivity(id);
        const revision = row.contextRevisionId
            ? await projectContextsRepository.getProjectContextRevision(row.contextRevisionId)
            : null;
        const pendingCredential = getPendingCredentialRequest(id);
        return c.json({
            title: chat?.title ?? "Chat",
            messages,
            busy: isChatBusy(id),
            queue: getChatQueueState(id),
            vncSessionId: browserActivity?.sessionId ?? null,
            projectId: row.projectId,
            mode: chatsRepository.chatMode(row),
            contextRevision: revision
                ? {
                      id: revision.id,
                      status: revision.status,
                      brief: revision.brief,
                      hasProposal: revision.context.summary.trim().length > 0,
                  }
                : null,
            credentialRequest: pendingCredential
                ? { id: pendingCredential.id, profileName: pendingCredential.profileName, fields: pendingCredential.fields }
                : null,
        });
    });

    router.get("/chats/:id/events", async (c) => {
        const id = c.req.param("id");
        if (!(await chatsRepository.getChatRow(id))) throw new HTTPException(404, { message: "Chat not found" });
        return streamSSE(c, async (stream) => {
            const notify = (event: Parameters<typeof subscribeToChatUpdates>[1] extends (event: infer T) => void ? T : never) =>
                void stream
                    .writeSSE({
                        event: event.type,
                        data: event.type === "updated" ? "" : JSON.stringify(event),
                    })
                    .catch(() => undefined);
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

    router.post("/chats/:id/message", zValidator("json", messageSchema), async (c) => {
        const id = c.req.param("id");
        await assertChatWritable(id);
        const { text } = c.req.valid("json");
        void runChatTurn(id, text).catch(console.error);
        return c.json({ ok: true });
    });

    router.post("/chats/:id/follow-up", zValidator("json", messageSchema), async (c) => {
        const id = c.req.param("id");
        await assertChatWritable(id, { allowBusy: true });
        const { text } = c.req.valid("json");
        try {
            await queueChatFollowUp(id, text);
            return c.json({ ok: true });
        } catch (error) {
            throw new HTTPException(409, { message: error instanceof Error ? error.message : String(error) });
        }
    });

    router.post("/chats/:id/abort", async (c) => {
        const id = c.req.param("id");
        await assertChatWritable(id, { allowBusy: true });
        try {
            await abortChatTurn(id);
            return c.json({ ok: true });
        } catch (error) {
            throw new HTTPException(409, { message: error instanceof Error ? error.message : String(error) });
        }
    });

    router.patch("/chats/:id/messages/:messageId", zValidator("json", messageSchema), async (c) => {
        const id = c.req.param("id");
        await assertChatWritable(id);
        const { text } = c.req.valid("json");
        try {
            const branch = await branchChatForTurn(id, c.req.param("messageId"), { editedText: text, userOnly: true });
            void runChatTurn(id, branch.text, branch.sessionManager).catch(console.error);
            return c.json({ ok: true });
        } catch (error) {
            throw new HTTPException(409, { message: error instanceof Error ? error.message : String(error) });
        }
    });

    router.post("/chats/:id/messages/:messageId/retry", async (c) => {
        const id = c.req.param("id");
        await assertChatWritable(id);
        try {
            const branch = await branchChatForTurn(id, c.req.param("messageId"));
            void runChatTurn(id, branch.text, branch.sessionManager).catch(console.error);
            return c.json({ ok: true });
        } catch (error) {
            throw new HTTPException(409, { message: error instanceof Error ? error.message : String(error) });
        }
    });

    return router;
}

async function assertChatWritable(id: string, options: { allowBusy?: boolean } = {}): Promise<void> {
    const row = await chatsRepository.getChatRow(id);
    if (!row) throw new HTTPException(404, { message: "Chat not found" });
    if (row.contextRevisionId) {
        const revision = await projectContextsRepository.getProjectContextRevision(row.contextRevisionId);
        if (revision?.status !== "draft") throw new HTTPException(409, { message: "This discovery is closed" });
    }
    if (isChatDeleting(id)) throw new HTTPException(409, { message: "Chat is being deleted" });
    if (!options.allowBusy && isChatBusy(id)) throw new HTTPException(409, { message: "The agent is still replying" });
}
