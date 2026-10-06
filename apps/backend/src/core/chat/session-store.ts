import { jobsRepository } from "../../infra/repositories/jobs";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { sessionsDir } from "../paths";
import { chatsRepository, type ChatMetadata } from "../../infra/repositories/chats";
import { isChatDeleting, publishChatUpdate } from "./chat-registry";
import type { ChatMessageRecord, ChatToolStepRecord } from "./types";

export const cwd = process.cwd();
export const ERROR_TYPE = "specbook-error";
export const WARNING_TYPE = "specbook-warning";
export const TOOL_STEP_TYPE = "specbook-tool-step";
const DEFAULT_TITLE = "New chat";

export interface AgentMessage {
    role?: string;
    content?: unknown;
    stopReason?: string;
    errorMessage?: string;
}

export function extractText(message: AgentMessage | undefined): string {
    const content = message?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter(
            (part): part is { type: string; text: string } =>
                typeof part === "object" &&
                part !== null &&
                (part as { type?: string }).type === "text" &&
                typeof (part as { text?: unknown }).text === "string",
        )
        .map((part) => part.text)
        .join("");
}

/**
 * Writes the whole session file now, including a chat without messages.
 * SessionManager offers no public flush, so Specbook relies on the library's
 * private `_rewriteFile` here (checked against @earendil-works/pi-coding-agent
 * 1.0.4). Keep every use of the private API behind this wrapper.
 */
export function flushSessionFile(sessionManager: SessionManager): void {
    const writable = sessionManager as unknown as { _rewriteFile(): void; flushed: boolean };
    writable._rewriteFile();
    writable.flushed = true;
}

// Chat id -> session file path. Session files are named "<timestamp>_<id>.jsonl", so a
// cache miss is resolved with a directory listing instead of parsing every session file.
const sessionPaths = new Map<string, string>();
const titles = new Map<string, { mtimeMs: number; size: number; title: string }>();

async function fileExists(filePath: string): Promise<boolean> {
    try {
        return (await fs.stat(filePath)).isFile();
    } catch {
        return false;
    }
}

async function refreshSessionPaths(): Promise<void> {
    await fs.mkdir(sessionsDir, { recursive: true });
    const names = await fs.readdir(sessionsDir);
    for (const name of names) {
        const match = /_([^_]+)\.jsonl$/.exec(name);
        if (match) sessionPaths.set(match[1], path.join(sessionsDir, name));
    }
}

async function resolveSessionPath(id: string): Promise<string | null> {
    const cached = sessionPaths.get(id);
    if (cached && (await fileExists(cached))) return cached;
    sessionPaths.delete(id);
    await refreshSessionPaths();
    const found = sessionPaths.get(id);
    if (found && (await fileExists(found))) return found;
    sessionPaths.delete(id);
    // Fallback for session files that do not follow the naming convention.
    const info = (await SessionManager.list(cwd, sessionsDir)).find((session) => session.id === id);
    if (!info) return null;
    sessionPaths.set(id, info.path);
    return info.path;
}

function forgetSession(id: string): void {
    sessionPaths.delete(id);
    titles.delete(id);
}

export async function openSession(id: string): Promise<SessionManager | null> {
    const sessionPath = await resolveSessionPath(id);
    return sessionPath ? SessionManager.open(sessionPath, sessionsDir, cwd) : null;
}

function sessionTitle(sessionManager: SessionManager): string {
    const name = sessionManager.getSessionName()?.trim();
    if (name && name !== DEFAULT_TITLE) return name;
    for (const entry of sessionManager.getEntries()) {
        if (entry.type !== "message" || entry.message.role !== "user") continue;
        const text = extractText(entry.message as AgentMessage).trim();
        if (text) return text.slice(0, 80);
    }
    return DEFAULT_TITLE;
}

async function cachedTitle(id: string): Promise<string> {
    const sessionPath = await resolveSessionPath(id);
    if (!sessionPath) return DEFAULT_TITLE;
    const stats = await fs.stat(sessionPath).catch(() => null);
    if (!stats) return DEFAULT_TITLE;
    const cached = titles.get(id);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.title;
    const title = sessionTitle(SessionManager.open(sessionPath, sessionsDir, cwd));
    titles.set(id, { mtimeMs: stats.mtimeMs, size: stats.size, title });
    return title;
}

export function userMessageCount(sessionManager: SessionManager): number {
    return sessionManager
        .getEntries()
        .filter((entry) => entry.type === "message" && entry.message.role === "user").length;
}

export function ensureUserMessage(sessionManager: SessionManager, userText: string, previousCount: number): void {
    if (userMessageCount(sessionManager) > previousCount) return;
    sessionManager.appendMessage({ role: "user", content: userText, timestamp: Date.now() });
}

export function appendError(sessionManager: SessionManager, message: string): void {
    sessionManager.appendCustomMessageEntry(ERROR_TYPE, message, true);
    flushSessionFile(sessionManager);
}

export function appendWarning(sessionManager: SessionManager, message: string): void {
    sessionManager.appendCustomMessageEntry(WARNING_TYPE, message, true);
    flushSessionFile(sessionManager);
}

/**
 * Moves the session leaf so the next turn replays `messageId`'s user text. The caller
 * must already hold the chat's turn reservation.
 */
export async function branchSessionForTurn(
    id: string,
    messageId: string,
    options: { editedText?: string; userOnly?: boolean } = {},
): Promise<{ text: string; sessionManager: SessionManager }> {
    if (isChatDeleting(id)) throw new Error("Chat is being deleted");

    const sessionManager = await openSession(id);
    if (!sessionManager) throw new Error("Chat not found");

    const branch = sessionManager.getBranch();
    const targetIndex = branch.findIndex((entry) => entry.id === messageId);
    const target = targetIndex >= 0 ? branch[targetIndex] : undefined;
    if (
        !target ||
        target.type !== "message" ||
        (target.message.role !== "user" && target.message.role !== "assistant") ||
        (options.userOnly && target.message.role !== "user")
    ) {
        throw new Error("Message is not available in the active conversation");
    }

    let text = "";
    let branchFromId: string | null = null;
    if (target.message.role === "user") {
        text = options.editedText ?? extractText(target.message as AgentMessage);
        branchFromId = target.parentId;
    } else {
        for (let index = targetIndex - 1; index >= 0; index -= 1) {
            const entry = branch[index];
            if (entry.type === "message" && entry.message.role === "user") {
                text = extractText(entry.message as AgentMessage);
                branchFromId = entry.parentId;
                break;
            }
        }
    }

    if (!text.trim()) throw new Error("Message has no text to send");
    if (branchFromId) sessionManager.branch(branchFromId);
    else sessionManager.resetLeaf();
    sessionManager.appendCustomEntry("specbook-retry", { messageId });
    flushSessionFile(sessionManager);
    publishChatUpdate(id);
    return { text: text.trim(), sessionManager };
}

export async function removeChatSession(id: string): Promise<void> {
    const sessionPath = await resolveSessionPath(id);
    forgetSession(id);
    if (!sessionPath) return;
    const root = path.resolve(sessionsDir);
    const resolved = path.resolve(sessionPath);
    const relative = path.relative(root, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error("Invalid chat session path");
    }
    await fs.rm(resolved, { force: true });
}

export async function createChat(
    projectId: string,
    metadata: ChatMetadata = {},
): Promise<{ id: string }> {
    await fs.mkdir(sessionsDir, { recursive: true });
    const id = crypto.randomUUID();
    const sessionManager = SessionManager.create(cwd, sessionsDir, { id });
    flushSessionFile(sessionManager);
    const sessionId = sessionManager.getSessionId();
    const sessionFile = sessionManager.getSessionFile();
    titles.delete(sessionId);
    if (sessionFile) sessionPaths.set(sessionId, sessionFile);
    await chatsRepository.insertChat(sessionId, projectId, metadata);
    return { id: sessionId };
}

export async function listChats(
    projectId: string,
): Promise<{ id: string; title: string; createdAt: string }[]> {
    const jobChatIds = new Set((await jobsRepository.list(projectId)).map((job) => job.chatId));
    const rows = (await chatsRepository.listChatRows(projectId)).filter((row) => !jobChatIds.has(row.id));
    return Promise.all(
        rows.map(async (row) => ({
            id: row.id,
            title: await cachedTitle(row.id).catch(() => DEFAULT_TITLE),
            createdAt: row.createdAt,
        })),
    );
}

export function messagesOf(id: string, sessionManager: SessionManager): ChatMessageRecord[] {
    const messages: ChatMessageRecord[] = [];
    for (const entry of sessionManager.getBranch()) {
        if (entry.type === "custom_message" && entry.display) {
            const content = extractText({ role: "assistant", content: entry.content }).trim();
            if (content) {
                messages.push({
                    id: entry.id,
                    chatId: id,
                    role: "agent",
                    content,
                    createdAt: entry.timestamp,
                    canRetry: false,
                });
            }
            continue;
        }
        if (entry.type !== "message") continue;
        const role = entry.message.role;
        if (role !== "user" && role !== "assistant") continue;
        const content = extractText(entry.message as AgentMessage).trim();
        if (!content) continue;
        messages.push({
            id: entry.id,
            chatId: id,
            role: role === "user" ? "user" : "agent",
            content,
            createdAt: entry.timestamp,
            canRetry: role === "user" || role === "assistant",
        });
    }
    return messages;
}

/** Tool calls follow the active session branch, including messages with no visible text. */
export function toolStepsOf(sessionManager: SessionManager): ChatToolStepRecord[] {
    const branch = sessionManager.getBranch();
    const results = new Map<string, number>();
    const timings = new Map<string, ChatToolStepRecord>();
    const calls = new Map<string, string>();
    for (const entry of branch) {
        if (entry.type === "message" && entry.message.role === "assistant") {
            for (const part of entry.message.content) {
                if (part.type === "toolCall") calls.set(part.id, `${entry.id}:${part.id}`);
            }
        }
        if (entry.type === "message" && entry.message.role === "toolResult") {
            const id = calls.get(entry.message.toolCallId);
            if (id) results.set(id, entry.message.timestamp);
        }
        if (entry.type === "custom" && entry.customType === TOOL_STEP_TYPE) {
            const step = entry.data as ChatToolStepRecord;
            timings.set(step.id, step);
        }
    }
    const steps: ChatToolStepRecord[] = [];
    let afterMessageId: string | null = null;
    for (const entry of branch) {
        if (entry.type === "custom_message" && entry.display && extractText({ content: entry.content }).trim()) {
            afterMessageId = entry.id;
        }
        if (entry.type !== "message") continue;
        const message = entry.message;
        if ((message.role === "user" || message.role === "assistant") && extractText(message).trim()) {
            afterMessageId = entry.id;
        }
        if (message.role !== "assistant") continue;
        for (const part of message.content) {
            if (part.type !== "toolCall") continue;
            const id = `${entry.id}:${part.id}`;
            const timing = timings.get(id);
            if (!timing && !results.has(id)) continue;
            steps.push({
                id,
                toolName: part.name,
                afterMessageId,
                startedAt: timing?.startedAt ?? message.timestamp,
                endedAt: timing?.endedAt ?? results.get(id) ?? null,
            });
        }
    }
    return steps;
}

export async function getChatMessages(id: string): Promise<ChatMessageRecord[] | null> {
    const sessionManager = await openSession(id);
    return sessionManager ? messagesOf(id, sessionManager) : null;
}

/** Title and visible messages of a chat, reading its session file once. */
export async function getChatView(
    id: string,
): Promise<{ title: string; messages: ChatMessageRecord[]; toolSteps: ChatToolStepRecord[] } | null> {
    const sessionManager = await openSession(id);
    if (!sessionManager) return null;
    return { title: sessionTitle(sessionManager), messages: messagesOf(id, sessionManager), toolSteps: toolStepsOf(sessionManager) };
}
