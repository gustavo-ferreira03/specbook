import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

// In-memory state of chats handled by this process: which chats have a turn running,
// which are being deleted, the live agent session of each running turn, queued
// follow-ups and SSE listeners.

export type ChatUpdateEvent =
    | { type: "updated" }
    | { type: "message_start" }
    | { type: "assistant_delta"; delta: string }
    | { type: "message_end" }
    | { type: "tool_start"; toolName: string }
    | { type: "tool_end"; toolName: string }
    | { type: "agent_status"; status: "working" | "retrying" | "idle"; message?: string }
    | { type: "queue_update"; steering: number; followUp: number };

export interface ActiveChatSession {
    session: AgentSession;
    sessionManager: SessionManager;
    aborted: boolean;
}

const busyChats = new Set<string>();
const deletingChats = new Set<string>();
const activeChatSessions = new Map<string, ActiveChatSession>();
const pendingFollowUps = new Map<string, string[]>();
const abortRequestedChats = new Set<string>();
const chatUpdateListeners = new Map<string, Set<(event: ChatUpdateEvent) => void>>();

export class ChatBusyError extends Error {}

export function isChatBusy(id: string): boolean {
    return busyChats.has(id);
}

export function isChatDeleting(id: string): boolean {
    return deletingChats.has(id);
}

/**
 * Synchronously claims the chat for a new turn. Returns false when a turn is already
 * running or the chat is being deleted. The caller must call releaseChatTurn on every
 * path once the claim is no longer needed.
 */
export function tryReserveChatTurn(id: string): boolean {
    if (busyChats.has(id) || deletingChats.has(id)) return false;
    busyChats.add(id);
    return true;
}

export function releaseChatTurn(id: string): void {
    pendingFollowUps.delete(id);
    abortRequestedChats.delete(id);
    busyChats.delete(id);
}

export function subscribeToChatUpdates(
    id: string,
    listener: (event: ChatUpdateEvent) => void,
): () => void {
    const listeners = chatUpdateListeners.get(id) ?? new Set<(event: ChatUpdateEvent) => void>();
    listeners.add(listener);
    chatUpdateListeners.set(id, listeners);
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) chatUpdateListeners.delete(id);
    };
}

export function publishChatUpdate(id: string, event: ChatUpdateEvent = { type: "updated" }): void {
    for (const listener of chatUpdateListeners.get(id) ?? []) listener(event);
}

export function getChatQueueState(id: string): { steering: number; followUp: number } {
    const active = activeChatSessions.get(id);
    return {
        steering: active?.session.getSteeringMessages().length ?? 0,
        followUp: (active?.session.getFollowUpMessages().length ?? 0) + (pendingFollowUps.get(id)?.length ?? 0),
    };
}

export function getActiveChatSession(id: string): ActiveChatSession | undefined {
    return activeChatSessions.get(id);
}

export function setActiveChatSession(id: string, active: ActiveChatSession): void {
    activeChatSessions.set(id, active);
}

export function clearActiveChatSession(id: string, session: AgentSession): void {
    if (activeChatSessions.get(id)?.session === session) activeChatSessions.delete(id);
}

export function takePendingFollowUps(id: string): string[] {
    const queue = pendingFollowUps.get(id) ?? [];
    pendingFollowUps.delete(id);
    return queue;
}

export function consumeAbortRequest(id: string): boolean {
    return abortRequestedChats.delete(id);
}

export async function queueChatFollowUp(id: string, text: string): Promise<void> {
    if (deletingChats.has(id)) throw new Error("Chat is being deleted");
    if (!busyChats.has(id)) throw new Error("The agent is not currently replying");

    const active = activeChatSessions.get(id);
    if (active) {
        await active.session.followUp(text);
        publishChatUpdate(id, {
            type: "queue_update",
            ...getChatQueueState(id),
        });
        return;
    }

    const queue = pendingFollowUps.get(id) ?? [];
    queue.push(text);
    pendingFollowUps.set(id, queue);
    publishChatUpdate(id, { type: "queue_update", ...getChatQueueState(id) });
}

export async function abortChatTurn(id: string): Promise<void> {
    const active = activeChatSessions.get(id);
    if (!active) {
        if (busyChats.has(id)) {
            abortRequestedChats.add(id);
            publishChatUpdate(id, { type: "agent_status", status: "idle" });
            return;
        }
        throw new Error("The agent is not currently replying");
    }
    active.aborted = true;
    await active.session.abort();
}

export function beginChatDeletion(id: string): boolean {
    if (busyChats.has(id) || deletingChats.has(id)) return false;
    deletingChats.add(id);
    return true;
}

export function cancelChatDeletion(id: string): void {
    deletingChats.delete(id);
}
