import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
    createAgentSession,
    DefaultResourceLoader,
    SessionManager,
    type AgentSession,
    type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import {
    beginChatBrowserTool,
    endChatBrowserTool,
    getOrCreateChatBrowser,
} from "../browser/sessions";
import {
    bridgeBrowserTools,
    getActiveTabUrl,
    type BrowserMcp,
    type BrowserToolPolicy,
} from "../browser/mcp";
import { modelRegistryPromise, modelRuntimePromise } from "../llm/runtime";
import { sessionsDir, storageRoot } from "../paths";
import { createProjectScrubber } from "../credentials/scrub";
import { chatsRepository, type ChatMetadata } from "../../infra/repositories/chats";
import {
    projectContextsRepository,
    type ProjectContextRevisionRow,
} from "../../infra/repositories/project-contexts";
import { projectsRepository, type Project } from "../../infra/repositories/projects";
import { settingsRepository } from "../../infra/repositories/settings";
import { createContextTools, projectContextJsonSchema } from "./context-tools";
import { createCredentialTools } from "./credential-tools";
import { createSessionTools } from "./session-tools";
import { createDomainTools } from "./tools";
import type { ChatMessageRecord } from "./types";

const busyChats = new Set<string>();
const deletingChats = new Set<string>();
const activeChatSessions = new Map<string, ActiveChatSession>();
const pendingFollowUps = new Map<string, string[]>();
const abortRequestedChats = new Set<string>();
const chatUpdateListeners = new Map<string, Set<(event: ChatUpdateEvent) => void>>();
const ERROR_TYPE = "specbook-error";
const WARNING_TYPE = "specbook-warning";
const cwd = process.cwd();
const agentDir = path.join(storageRoot, "pi-agent");

export type ChatUpdateEvent =
    | { type: "updated" }
    | { type: "assistant_delta"; delta: string }
    | { type: "tool_start"; toolName: string }
    | { type: "tool_end"; toolName: string }
    | { type: "agent_status"; status: "working" | "retrying" | "idle"; message?: string }
    | { type: "queue_update"; steering: number; followUp: number };

interface ActiveChatSession {
    session: AgentSession;
    sessionManager: SessionManager;
    aborted: boolean;
}

interface AgentMessage {
    role?: string;
    content?: unknown;
    stopReason?: string;
    errorMessage?: string;
}

const promptsDir = new URL("./prompts/", import.meta.url);

function loadPrompt(name: string): string {
    return readFileSync(new URL(name, promptsDir), "utf8").trimEnd();
}

function fillTemplate(template: string, values: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
        if (!(key in values)) throw new Error(`Missing template value: ${key}`);
        return values[key];
    });
}

const PROJECT_CONTEXT_SCHEMA_TEXT = JSON.stringify(projectContextJsonSchema, null, 2);
const STANDARD_SYSTEM_PROMPT_TEMPLATE = loadPrompt("standard-system-prompt.txt");
const DISCOVERY_SYSTEM_PROMPT_TEMPLATE = loadPrompt("discovery-system-prompt.txt");

function standardSystemPrompt(
    project: Project,
    confirmedContext: ProjectContextRevisionRow | null,
): string {
    const base = fillTemplate(STANDARD_SYSTEM_PROMPT_TEMPLATE, { baseUrl: project.baseUrl });
    if (confirmedContext) {
        return [
            base,
            "",
            `The user confirmed the following project context (revision ${confirmedContext.id}, confirmed at ${confirmedContext.confirmedAt}). Treat it as reviewed background knowledge about the application.`,
            "<confirmed-project-context>",
            JSON.stringify(confirmedContext.context, null, 2),
            "</confirmed-project-context>",
        ].join("\n");
    }
    return [base, "No confirmed project context exists for this project yet."].join("\n");
}

function discoverySystemPrompt(project: Project, revision: ProjectContextRevisionRow): string {
    const { brief } = revision;
    const safetyNotes = brief.safetyNotes.length
        ? brief.safetyNotes.map((note) => `- ${note}`).join("\n")
        : "- (none provided)";
    return fillTemplate(DISCOVERY_SYSTEM_PROMPT_TEMPLATE, {
        projectName: project.name,
        origin: new URL(project.baseUrl).origin,
        startUrl: brief.startUrl,
        goal: brief.goal,
        safetyNotes,
        schema: PROJECT_CONTEXT_SCHEMA_TEXT,
    });
}

function buildSystemPrompt(
    project: Project,
    discoveryRevision: ProjectContextRevisionRow | null,
    confirmedContext: ProjectContextRevisionRow | null,
): string {
    return discoveryRevision
        ? discoverySystemPrompt(project, discoveryRevision)
        : standardSystemPrompt(project, confirmedContext);
}

export const DISCOVERY_BROWSER_TOOLS: ReadonlySet<string> = new Set([
    "browser_navigate",
    "browser_navigate_back",
    "browser_snapshot",
    "browser_click",
    "browser_type",
    "browser_hover",
    "browser_wait_for",
    "browser_tabs",
]);

const DESTRUCTIVE_CLICK_PATTERN =
    /\b(add|create|delete|edit|remove|erase|destroy|save|confirm|pay|payment|purchase|buy|checkout|refund|unsubscribe|cancel|logout|log out|sign out|publish|submit|send|place order|adicionar|criar|editar|salvar|confirmar|excluir|apagar|remover|deletar|pagar|pagamento|comprar|estornar|reembolso|cancelar|sair|desconectar|encerrar|publicar|enviar|submeter|finalizar)\b/i;

function isWithinDiscoveryOrigin(url: string, origin: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return parsed.origin === origin;
}

export function createDiscoveryBrowserPolicy(
    revision: ProjectContextRevisionRow,
    mcp: BrowserMcp,
): BrowserToolPolicy {
    const origin = new URL(revision.brief.startUrl).origin;
    return {
        allowedTools: DISCOVERY_BROWSER_TOOLS,
        beforeCall: async (toolName, args) => {
            if (toolName === "browser_navigate") {
                const target = String(args.url ?? "");
                let parsed: URL;
                try {
                    parsed = new URL(target);
                } catch {
                    throw new Error(`Navigation rejected: "${target}" is not a valid URL.`);
                }
                if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                    throw new Error("Navigation rejected: only HTTP and HTTPS URLs are allowed during discovery.");
                }
                if (parsed.origin !== origin) {
                    throw new Error(
                        `Navigation rejected: ${parsed.origin} is outside the discovery origin ${origin}.`,
                    );
                }
            }
            if (toolName === "browser_tabs" && args.action === "new") {
                throw new Error("Opening new tabs is not allowed during discovery.");
            }
            if (toolName === "browser_click") {
                const description = String(args.element ?? "");
                const match = description.match(DESTRUCTIVE_CLICK_PATTERN);
                if (match) {
                    throw new Error(
                        `Click rejected: "${description}" looks like a destructive or irreversible action ("${match[0]}"). Discovery must not trigger it.`,
                    );
                }
            }
        },
        afterCall: async () => {
            const active = await getActiveTabUrl(mcp);
            if (!active || isWithinDiscoveryOrigin(active, origin)) return;
            await mcp.client.callTool({ name: "browser_navigate_back", arguments: {} }).catch(() => undefined);
            const afterBack = await getActiveTabUrl(mcp);
            if (afterBack && !isWithinDiscoveryOrigin(afterBack, origin)) {
                await mcp.navigate(revision.brief.startUrl).catch(() => undefined);
            }
            throw new Error(
                `The page left the discovery origin ${origin} (it reached ${active}). The browser returned to the allowed origin; the external destination was not inspected.`,
            );
        },
    };
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

async function createResourceLoader(promptText: string): Promise<DefaultResourceLoader> {
    const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPromptOverride: () => promptText,
        appendSystemPromptOverride: () => [],
    });
    await loader.reload();
    return loader;
}

export function isChatBusy(id: string): boolean {
    return busyChats.has(id);
}

export function isChatDeleting(id: string): boolean {
    return deletingChats.has(id);
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

export async function branchChatForTurn(
    id: string,
    messageId: string,
    options: { editedText?: string; userOnly?: boolean } = {},
): Promise<{ text: string; sessionManager: SessionManager }> {
    if (busyChats.has(id)) throw new Error("The agent is still replying");
    if (deletingChats.has(id)) throw new Error("Chat is being deleted");

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
    flushSessionFile(sessionManager);
    publishChatUpdate(id);
    return { text: text.trim(), sessionManager };
}

export async function removeChatSession(id: string): Promise<void> {
    const infos = await listSessionInfos();
    const info = infos.find((session) => session.id === id);
    if (!info) return;
    const root = path.resolve(sessionsDir);
    const sessionPath = path.resolve(info.path);
    const relative = path.relative(root, sessionPath);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error("Invalid chat session path");
    }
    await fs.rm(sessionPath, { force: true });
}

export async function createChat(
    projectId: string,
    metadata: ChatMetadata = {},
): Promise<{ id: string }> {
    await fs.mkdir(sessionsDir, { recursive: true });
    const id = crypto.randomUUID();
    const sessionManager = SessionManager.create(cwd, sessionsDir, { id });
    flushSessionFile(sessionManager);
    await chatsRepository.insertChat(sessionManager.getSessionId(), projectId, metadata);
    return { id: sessionManager.getSessionId() };
}

export async function listChats(
    projectId: string,
): Promise<{ id: string; title: string; createdAt: string }[]> {
    const [rows, infos] = await Promise.all([
        chatsRepository.listChatRows(projectId),
        listSessionInfos(),
    ]);
    return rows.map((row) => {
        const info = infos.find((session) => session.id === row.id);
        const piName = info?.name && info.name !== "New chat" ? info.name : undefined;
        const firstMessage =
            info?.firstMessage && info.firstMessage !== "(no messages)"
                ? info.firstMessage.trim().slice(0, 80)
                : undefined;
        return {
            id: row.id,
            title: piName || firstMessage || "New chat",
            createdAt: row.createdAt,
        };
    });
}

export async function getChatMessages(id: string): Promise<ChatMessageRecord[] | null> {
    const sessionManager = await openSession(id);
    if (!sessionManager) return null;
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

export async function runChatTurn(
    id: string,
    userText: string,
    existingSessionManager?: SessionManager,
): Promise<void> {
    if (busyChats.has(id) || deletingChats.has(id)) return;
    busyChats.add(id);
    publishChatUpdate(id);
    let sessionManager: SessionManager | null = existingSessionManager ?? null;
    let previousUserCount = 0;
    try {
        if (abortRequestedChats.delete(id)) return;
        const row = await chatsRepository.getChatRow(id);
        sessionManager = sessionManager ?? (await openSession(id));
        if (!row || !sessionManager) return;
        if (abortRequestedChats.delete(id)) return;
        previousUserCount = userMessageCount(sessionManager);
        const project = await projectsRepository.getProject(row.projectId);
        if (!project) {
            ensureUserMessage(sessionManager, userText, previousUserCount);
            appendError(sessionManager, "The project for this chat no longer exists.");
            return;
        }

        const [modelRegistry, modelRuntime, { provider, model: modelName }] = await Promise.all([
            modelRegistryPromise,
            modelRuntimePromise,
            settingsRepository.getLlmSettings(),
        ]);
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

        const contextRevision = row.contextRevisionId
            ? await projectContextsRepository.getProjectContextRevision(row.contextRevisionId)
            : null;
        const discoveryRevision = contextRevision?.status === "draft" ? contextRevision : null;

        if (row.contextRevisionId && !discoveryRevision) {
            ensureUserMessage(sessionManager, userText, previousUserCount);
            appendError(sessionManager, "This discovery is closed and cannot accept more messages.");
            return;
        }

        let browserTools: ReturnType<typeof bridgeBrowserTools> = [];
        let chatBrowser: Awaited<ReturnType<typeof getOrCreateChatBrowser>> | null = null;
        const scrub = createProjectScrubber(row.projectId);
        try {
            chatBrowser = await getOrCreateChatBrowser(id);
            const basePolicy: BrowserToolPolicy = discoveryRevision
                ? { ...createDiscoveryBrowserPolicy(discoveryRevision, chatBrowser.mcp), sanitizeResult: scrub }
                : { sanitizeResult: scrub };
            const policy: BrowserToolPolicy = {
                ...basePolicy,
                beforeCall: async (toolName, args) => {
                    await chatBrowser!.mcp.ensureBrowser();
                    await basePolicy.beforeCall?.(toolName, args);
                    beginChatBrowserTool(id, toolName);
                    publishChatUpdate(id);
                },
                afterCall: async (toolName, args, result) => {
                    try {
                        await basePolicy.afterCall?.(toolName, args, result);
                    } finally {
                        endChatBrowserTool(id, toolName);
                        publishChatUpdate(id);
                    }
                },
            };
            browserTools = bridgeBrowserTools(chatBrowser.mcp, chatBrowser.workDir, policy);
        } catch (error) {
            sessionManager.appendCustomMessageEntry(
                WARNING_TYPE,
                `The agent browser failed to start: ${error instanceof Error ? error.message : String(error)}. Browser tools are unavailable for this turn.`,
                true,
            );
            flushSessionFile(sessionManager);
        }

        const credentialTools = createCredentialTools({
            projectId: row.projectId,
            baseUrl: project.baseUrl,
            chatId: id,
            mcp: chatBrowser?.mcp ?? null,
            workDir: chatBrowser?.workDir ?? null,
            scrub,
            notify: () => publishChatUpdate(id),
        });
        const sessionTools = createSessionTools({
            projectId: row.projectId,
            baseUrl: project.baseUrl,
            mcp: chatBrowser?.mcp ?? null,
            workDir: chatBrowser?.workDir ?? null,
        });
        const customTools = discoveryRevision
            ? [
                  ...browserTools,
                  ...createContextTools(discoveryRevision.id, row.projectId),
                  ...credentialTools,
                  ...sessionTools,
              ]
            : [...browserTools, ...createDomainTools(row.projectId), ...credentialTools, ...sessionTools];
        const confirmedContext = discoveryRevision
            ? null
            : await projectContextsRepository.getLatestConfirmedProjectContext(row.projectId);
        const resourceLoader = await createResourceLoader(
            buildSystemPrompt(project, discoveryRevision, confirmedContext),
        );
        if (abortRequestedChats.delete(id)) return;
        const { session } = await createAgentSession({
            model,
            modelRuntime,
            cwd,
            noTools: "builtin",
            customTools,
            resourceLoader,
            sessionManager,
        });
        const activeSession: ActiveChatSession = { session, sessionManager, aborted: false };
        activeChatSessions.set(id, activeSession);
        const queuedFollowUps = pendingFollowUps.get(id) ?? [];
        pendingFollowUps.delete(id);
        let modelError = "";
        const unsubscribe = session.subscribe((event) => {
            const value = event as unknown as {
                type?: string;
                message?: AgentMessage;
                messages?: AgentMessage[];
                assistantMessageEvent?: { type?: string; delta?: string };
                toolName?: string;
                steering?: readonly string[];
                followUp?: readonly string[];
                willRetry?: boolean;
                attempt?: number;
                maxAttempts?: number;
                errorMessage?: string;
            };
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
            if (value.type === "message_update" && value.assistantMessageEvent?.type === "text_delta") {
                const delta = value.assistantMessageEvent.delta;
                if (delta) publishChatUpdate(id, { type: "assistant_delta", delta });
            }
            if (value.type === "tool_execution_start" && value.toolName) {
                publishChatUpdate(id, { type: "tool_start", toolName: value.toolName });
            }
            if (value.type === "tool_execution_end" && value.toolName) {
                publishChatUpdate(id, { type: "tool_end", toolName: value.toolName });
            }
            if (value.type === "agent_start") {
                publishChatUpdate(id, { type: "agent_status", status: "working" });
            }
            if (value.type === "agent_end") {
                publishChatUpdate(
                    id,
                    value.willRetry
                        ? { type: "agent_status", status: "retrying", message: value.errorMessage }
                        : { type: "updated" },
                );
            }
            if (value.type === "agent_settled") {
                publishChatUpdate(id, { type: "agent_status", status: "idle" });
            }
            if (value.type === "auto_retry_start") {
                publishChatUpdate(id, {
                    type: "agent_status",
                    status: "retrying",
                    message: `Retrying (${value.attempt ?? 1}/${value.maxAttempts ?? 1})`,
                });
            }
            if (value.type === "queue_update") {
                publishChatUpdate(id, {
                    type: "queue_update",
                    steering: value.steering?.length ?? 0,
                    followUp: value.followUp?.length ?? 0,
                });
            }
        });

        try {
            const promptPromise = session.prompt(userText);
            for (const followUp of queuedFollowUps) await session.followUp(followUp);
            await promptPromise;
        } catch (error) {
            if (!activeSession.aborted) {
                ensureUserMessage(sessionManager, userText, previousUserCount);
                appendError(
                    sessionManager,
                    `The model couldn't respond: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        } finally {
            unsubscribe();
            session.dispose();
            if (activeChatSessions.get(id)?.session === session) activeChatSessions.delete(id);
        }
        if (modelError && !activeSession.aborted) appendError(sessionManager, `The model couldn't respond: ${modelError}`);
    } catch (error) {
        if (sessionManager) {
            if (!activeChatSessions.get(id)?.aborted) {
                ensureUserMessage(sessionManager, userText, previousUserCount);
                appendError(
                    sessionManager,
                    `The chat turn failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        } else {
            console.error(error);
        }
    } finally {
        pendingFollowUps.delete(id);
        abortRequestedChats.delete(id);
        busyChats.delete(id);
        publishChatUpdate(id, { type: "queue_update", ...getChatQueueState(id) });
        publishChatUpdate(id);
    }
}
