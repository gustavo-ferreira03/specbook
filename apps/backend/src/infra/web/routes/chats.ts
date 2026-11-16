import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

import { watchSession } from "../../../core/accounts/sessions";
import { getChatBrowser } from "../../../core/browser/sessions";
import { getPendingCredentialRequest } from "../../../core/chat/credential-requests";
import { chatResults } from "../../../core/chat/results";
import {
  abortChatTurn,
  chatTitle,
  createChat,
  getChatQueueState,
  getChatView,
  isChatBusy,
  isChatDeleting,
  listChats,
  queueChatFollowUp,
  startBranchedChatTurn,
  startChatTurn,
  subscribeToChatUpdates,
} from "../../../core/chat/session";
import type { ChatUpdateEvent } from "../../../core/chat/session";
import { deleteChatData, ResourceBusyError } from "../../../core/deletion";
import { chatsRepository } from "../../repositories/chats";
import { jobsRepository } from "../../repositories/jobs";
import { projectContextsRepository } from "../../repositories/project-contexts";
import { projectsRepository } from "../../repositories/projects";
import { access } from "../access";

export const createChatsRouter = function createChatsRouter(): Hono {
  const router = new Hono();

  router.post(
    "/projects/:id/chats",
    access("editor"),
    zValidator("json", messageSchema),
    async (c) => {
      const project = await projectsRepository.getProject(c.req.param("id"));
      if (!project) {
        throw new HTTPException(404, { message: "Project not found" });
      }
      const { text } = c.req.valid("json");
      const chat = await createChat(project.id, {}, chatTitle(text));
      startChatTurn(chat.id, text);
      return c.json({ chat });
    }
  );

  router.get("/projects/:id/chats", access("viewer"), async (c) => {
    const project = await projectsRepository.getProject(c.req.param("id"));
    if (!project) {
      throw new HTTPException(404, { message: "Project not found" });
    }
    return c.json({ chats: await listChats(project.id) });
  });

  router.get("/chats/:id", access("viewer"), async (c) => {
    const id = c.req.param("id");
    const [row, view] = await Promise.all([
      chatsRepository.getChatRow(id),
      getChatView(id),
    ]);
    if (!row || !view) {
      throw new HTTPException(404, { message: "Chat not found" });
    }
    const browser = await getChatBrowser(id);
    const revision = row.contextRevisionId
      ? await projectContextsRepository.getProjectContextRevision(
          row.contextRevisionId
        )
      : null;
    const pendingCredential = getPendingCredentialRequest(id);
    return c.json({
      title: view.title,
      messages: view.messages,
      toolSteps: view.toolSteps,
      busy: isChatBusy(id),
      queue: getChatQueueState(id),
      vncSessionId: browser?.vnc.id ?? null,
      projectId: row.projectId,
      mode: revision?.status === "draft" ? "discovery" : "standard",
      contextRevision: revision
        ? {
            id: revision.id,
            status: revision.status,
            brief: revision.brief,
            hasProposal: revision.context.summary.trim().length > 0,
          }
        : null,
      credentialRequest: pendingCredential
        ? {
            id: pendingCredential.id,
            kind: pendingCredential.kind,
            origin: pendingCredential.origin,
            profileName: pendingCredential.profileName,
            fields: pendingCredential.fields,
          }
        : null,
    });
  });

  router.get("/chats/:id/events", access("viewer"), async (c) => {
    const id = c.req.param("id");
    if (!(await chatsRepository.getChatRow(id))) {
      throw new HTTPException(404, { message: "Chat not found" });
    }
    c.res = streamSSE(c, async (stream) => {
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- This mutable callback slot belongs to one resource acquisition and is replaced independently for each operation.
      let releaseSession = () => {
        /* No action is needed until this callback is replaced or invoked by its owner. */
      };
      const notify = (event: ChatUpdateEvent) =>
        stream
          .writeSSE({
            event: event.type,
            data: event.type === "updated" ? "" : JSON.stringify(event),
          })
          .catch(() => {
            /* No action is needed until this callback is replaced or invoked by its owner. */
          });
      const unsubscribe = subscribeToChatUpdates(id, notify);
      const heartbeat = setInterval(
        () =>
          stream.write(":ping\n\n").catch(() => {
            /* No action is needed until this callback is replaced or invoked by its owner. */
          }),
        SSE_HEARTBEAT_MS
      );
      stream.onAbort(() => {
        clearInterval(heartbeat);
        unsubscribe();
        releaseSession();
      });
      if (c.get("user")) {
        releaseSession = await watchSession(c.req.raw.headers, () =>
          stream.abort()
        );
      }
      if (stream.aborted) {
        releaseSession();
        return;
      }
      await stream.writeSSE({ event: "connected", data: "" });
      // oxlint-disable-next-line promise/avoid-new -- Bridge an event or callback API to the asynchronous operation.
      await new Promise<void>((resolve) => {
        if (stream.aborted) {
          resolve();
        } else {
          stream.onAbort(resolve);
        }
      });
    });
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("X-Accel-Buffering", "no");
    return c.res;
  });

  router.get("/chats/:id/results", access("viewer"), async (c) => {
    const results = await chatResults(c.req.param("id"));
    if (!results) {
      throw new HTTPException(404, { message: "Chat not found" });
    }
    return c.json(results);
  });

  router.delete("/chats/:id", access("editor"), async (c) => {
    try {
      if (await jobsRepository.forChat(c.req.param("id"))) {
        throw new HTTPException(409, {
          message: "Job sessions are retained for audit",
        });
      }
      if (!(await deleteChatData(c.req.param("id")))) {
        throw new HTTPException(404, { message: "Chat not found" });
      }
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }
      if (error instanceof ResourceBusyError) {
        throw new HTTPException(409, { message: error.message });
      }
      throw error;
    }
  });

  router.post(
    "/chats/:id/message",
    access("editor"),
    zValidator("json", messageSchema),
    async (c) => {
      const id = c.req.param("id");
      await assertChatWritable(id);
      const { text } = c.req.valid("json");
      try {
        startChatTurn(id, text);
      } catch (error) {
        throw new HTTPException(409, {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return c.json({ ok: true });
    }
  );

  router.post(
    "/chats/:id/follow-up",
    access("editor"),
    zValidator("json", messageSchema),
    async (c) => {
      const id = c.req.param("id");
      await assertChatWritable(id, { allowBusy: true });
      const { text } = c.req.valid("json");
      try {
        await queueChatFollowUp(id, text);
        return c.json({ ok: true });
      } catch (error) {
        throw new HTTPException(409, {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );

  router.post("/chats/:id/abort", access("editor"), async (c) => {
    const id = c.req.param("id");
    await assertChatWritable(id, { allowBusy: true });
    try {
      await abortChatTurn(id);
      return c.json({ ok: true });
    } catch (error) {
      throw new HTTPException(409, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.patch(
    "/chats/:id/messages/:messageId",
    access("editor"),
    zValidator("json", messageSchema),
    async (c) => {
      const id = c.req.param("id");
      await assertChatWritable(id);
      const { text } = c.req.valid("json");
      try {
        await startBranchedChatTurn(id, c.req.param("messageId"), {
          editedText: text,
          userOnly: true,
        });
        return c.json({ ok: true });
      } catch (error) {
        throw new HTTPException(409, {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );

  router.post(
    "/chats/:id/messages/:messageId/retry",
    access("editor"),
    async (c) => {
      const id = c.req.param("id");
      await assertChatWritable(id);
      try {
        await startBranchedChatTurn(id, c.req.param("messageId"));
        return c.json({ ok: true });
      } catch (error) {
        throw new HTTPException(409, {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );

  return router;
};

const assertChatWritable = async function assertChatWritable(
  id: string,
  options: { allowBusy?: boolean } = {}
): Promise<void> {
  const row = await chatsRepository.getChatRow(id);
  if (!row) {
    throw new HTTPException(404, { message: "Chat not found" });
  }
  if (await jobsRepository.forChat(id)) {
    throw new HTTPException(409, {
      message: "Use the project Inbox to answer this job",
    });
  }
  if (isChatDeleting(id)) {
    throw new HTTPException(409, { message: "Chat is being deleted" });
  }
  if (!options.allowBusy && isChatBusy(id)) {
    throw new HTTPException(409, { message: "The agent is still replying" });
  }
};

const messageSchema = z.object({ text: z.string().trim().min(1) });
const SSE_HEARTBEAT_MS = 20_000;
