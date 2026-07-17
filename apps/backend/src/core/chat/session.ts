import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
    createAgentSession,
    DefaultResourceLoader,
    SessionManager,
    type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { getOrCreateConversationBrowser } from "../browser/sessions";
import { bridgeBrowserTools } from "../browser/mcp";
import { modelRegistry } from "../llm/runtime";
import { sessionsDir, storageRoot } from "../paths";
import { getConversationRow, insertConversation, listConversationRows } from "../../repositories/conversations";
import { getProject } from "../../repositories/projects";
import { getLlmSettings } from "../../repositories/settings";
import { createDomainTools } from "./tools";
import type { ChatMessageRecord } from "./types";

const busyConversations = new Set<string>();
const deletingConversations = new Set<string>();
const ERROR_TYPE = "specbook-error";
const WARNING_TYPE = "specbook-warning";
const cwd = process.cwd();
const agentDir = path.join(storageRoot, "pi-agent");

interface AgentMessage {
    role?: string;
    content?: unknown;
    stopReason?: string;
    errorMessage?: string;
}

function systemPrompt(baseUrl: string): string {
    return [
        "You are the Specbook agent. You document and test a web application by operating a real browser and turning what you learn into Specs.",
        `The application under test lives at ${baseUrl}. Use the browser tools to navigate and interact with it. The user watches your browser live.`,
        "A Spec is a permanent behavior page with preconditions, execution steps, an expected result, postconditions, and a Robot Framework executable.",
        "Explore the described flow, ask direct clarifying questions when rules, credentials, or expected outcomes are ambiguous, then create or update the Spec and verify it with run_spec.",
        "Always call list_features and list_specs before creating anything. Reuse existing features. Call get_spec before changing an existing Spec.",
        "Robot source must import only 'Library    Browser', start its own headless Chromium browser, use ${BASE_URL} instead of a literal application origin, avoid sleeps, and make explicit assertions that prove the expected result.",
        "Robot source is an internal implementation detail. Do not paste it into chat unless the user explicitly asks to see it.",
        "Never claim an action succeeded unless a tool result confirms it. If a tool fails or rejects input, report that failure exactly.",
        "Reply in the same language as the user and keep answers concise.",
    ].join("\n");
}

function extractText(message: AgentMessage | undefined): string {
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

function flushSessionFile(sessionManager: SessionManager): void {
    const writable = sessionManager as unknown as { _rewriteFile(): void; flushed: boolean };
    writable._rewriteFile();
    writable.flushed = true;
}

async function listSessionInfos(): Promise<SessionInfo[]> {
    await fs.mkdir(sessionsDir, { recursive: true });
    return SessionManager.list(cwd, sessionsDir);
}

async function openSession(id: string): Promise<SessionManager | null> {
    const infos = await listSessionInfos();
    const info = infos.find((session) => session.id === id);
    return info ? SessionManager.open(info.path, sessionsDir, cwd) : null;
}

function userMessageCount(sessionManager: SessionManager): number {
    return sessionManager
        .getEntries()
        .filter((entry) => entry.type === "message" && entry.message.role === "user").length;
}

function ensureUserMessage(sessionManager: SessionManager, userText: string, previousCount: number): void {
    if (userMessageCount(sessionManager) > previousCount) return;
    sessionManager.appendMessage({ role: "user", content: userText, timestamp: Date.now() });
}

function appendError(sessionManager: SessionManager, message: string): void {
    sessionManager.appendCustomMessageEntry(ERROR_TYPE, message, true);
    flushSessionFile(sessionManager);
}

async function createResourceLoader(baseUrl: string): Promise<DefaultResourceLoader> {
    const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPromptOverride: () => systemPrompt(baseUrl),
        appendSystemPromptOverride: () => [],
    });
    await loader.reload();
    return loader;
}

export function isConversationBusy(id: string): boolean {
    return busyConversations.has(id);
}

export function isConversationDeleting(id: string): boolean {
    return deletingConversations.has(id);
}

export function beginConversationDeletion(id: string): boolean {
    if (busyConversations.has(id) || deletingConversations.has(id)) return false;
    deletingConversations.add(id);
    return true;
}

export function cancelConversationDeletion(id: string): void {
    deletingConversations.delete(id);
}

export async function removeConversationSession(id: string): Promise<void> {
    const infos = await listSessionInfos();
    const info = infos.find((session) => session.id === id);
    if (!info) return;
    const root = path.resolve(sessionsDir);
    const sessionPath = path.resolve(info.path);
    const relative = path.relative(root, sessionPath);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error("Invalid conversation session path");
    }
    await fs.rm(sessionPath, { force: true });
}

export async function createConversation(projectId: string): Promise<{ id: string }> {
    await fs.mkdir(sessionsDir, { recursive: true });
    const id = crypto.randomUUID();
    const sessionManager = SessionManager.create(cwd, sessionsDir, { id });
    flushSessionFile(sessionManager);
    await insertConversation(sessionManager.getSessionId(), projectId);
    return { id: sessionManager.getSessionId() };
}

export async function listConversations(
    projectId: string,
): Promise<{ id: string; title: string; createdAt: string }[]> {
    const [rows, infos] = await Promise.all([listConversationRows(projectId), listSessionInfos()]);
    return rows.map((row) => {
        const info = infos.find((session) => session.id === row.id);
        const piName = info?.name && info.name !== "New chat" ? info.name : undefined;
        const firstMessage =
            info?.firstMessage && info.firstMessage !== "(no messages)"
                ? info.firstMessage.trim().slice(0, 80)
                : undefined;
        return {
            id: row.id,
            title: piName || firstMessage || "New conversation",
            createdAt: row.createdAt,
        };
    });
}

export async function getConversationMessages(id: string): Promise<ChatMessageRecord[] | null> {
    const sessionManager = await openSession(id);
    if (!sessionManager) return null;
    const messages: ChatMessageRecord[] = [];
    for (const entry of sessionManager.getEntries()) {
        if (entry.type === "custom_message" && entry.display) {
            const content = extractText({ role: "assistant", content: entry.content }).trim();
            if (content) {
                messages.push({
                    id: entry.id,
                    conversationId: id,
                    role: "agent",
                    content,
                    createdAt: entry.timestamp,
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
            conversationId: id,
            role: role === "user" ? "user" : "agent",
            content,
            createdAt: entry.timestamp,
        });
    }
    return messages;
}

export async function runConversationTurn(id: string, userText: string): Promise<void> {
    if (busyConversations.has(id) || deletingConversations.has(id)) return;
    busyConversations.add(id);
    let sessionManager: SessionManager | null = null;
    let previousUserCount = 0;
    try {
        const row = await getConversationRow(id);
        sessionManager = await openSession(id);
        if (!row || !sessionManager) return;
        previousUserCount = userMessageCount(sessionManager);
        const project = await getProject(row.projectId);
        if (!project) {
            ensureUserMessage(sessionManager, userText, previousUserCount);
            appendError(sessionManager, "The project for this conversation no longer exists.");
            return;
        }

        const { provider, model: modelName } = await getLlmSettings();
        const model = provider && modelName ? modelRegistry.find(provider, modelName) : null;
        if (!model) {
            ensureUserMessage(sessionManager, userText, previousUserCount);
            appendError(
                sessionManager,
                provider || modelName
                    ? `The configured LLM model "${provider}/${modelName}" is unavailable. Open Settings and choose an available provider and model.`
                    : "No LLM model is configured. Open Settings and choose a provider and model.",
            );
            return;
        }
        if (!modelRegistry.hasConfiguredAuth(model)) {
            ensureUserMessage(sessionManager, userText, previousUserCount);
            appendError(
                sessionManager,
                `The LLM provider "${provider}" is not authenticated. Open Settings and connect it or add an API key.`,
            );
            return;
        }

        let browserTools: ReturnType<typeof bridgeBrowserTools> = [];
        try {
            const browser = await getOrCreateConversationBrowser(id);
            browserTools = bridgeBrowserTools(browser.mcp, browser.workDir);
        } catch (error) {
            sessionManager.appendCustomMessageEntry(
                WARNING_TYPE,
                `The agent browser failed to start: ${error instanceof Error ? error.message : String(error)}. Browser tools are unavailable for this turn.`,
                true,
            );
            flushSessionFile(sessionManager);
        }

        const customTools = [...browserTools, ...createDomainTools(row.projectId)];
        const resourceLoader = await createResourceLoader(project.baseUrl);
        const { session } = await createAgentSession({
            model,
            modelRegistry,
            cwd,
            noTools: "builtin",
            customTools,
            resourceLoader,
            sessionManager,
        });
        let modelError = "";
        const unsubscribe = session.subscribe((event) => {
            const value = event as { type?: string; message?: AgentMessage; messages?: AgentMessage[] };
            const messages =
                value.type === "agent_end" && Array.isArray(value.messages)
                    ? value.messages
                    : value.message
                      ? [value.message]
                      : [];
            for (const message of messages) {
                if (message.role === "assistant" && message.stopReason === "error" && message.errorMessage) {
                    modelError = message.errorMessage;
                }
            }
        });

        try {
            await session.prompt(userText);
        } catch (error) {
            ensureUserMessage(sessionManager, userText, previousUserCount);
            appendError(
                sessionManager,
                `The model couldn't respond: ${error instanceof Error ? error.message : String(error)}`,
            );
        } finally {
            unsubscribe();
            session.dispose();
        }
        if (modelError) appendError(sessionManager, `The model couldn't respond: ${modelError}`);
    } catch (error) {
        if (sessionManager) {
            ensureUserMessage(sessionManager, userText, previousUserCount);
            appendError(
                sessionManager,
                `The conversation turn failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        } else {
            console.error(error);
        }
    } finally {
        busyConversations.delete(id);
    }
}
