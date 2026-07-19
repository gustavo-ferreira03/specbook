import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
    createAgentSession,
    DefaultResourceLoader,
    SessionManager,
    type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { getOrCreateChatBrowser } from "../browser/sessions";
import {
    bridgeBrowserTools,
    getActiveTabUrl,
    type BrowserMcp,
    type BrowserToolPolicy,
} from "../browser/mcp";
import { modelRegistry } from "../llm/runtime";
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
import { createDomainTools } from "./tools";
import type { ChatMessageRecord } from "./types";

const busyChats = new Set<string>();
const deletingChats = new Set<string>();
const chatUpdateListeners = new Map<string, Set<() => void>>();
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
        maxActions: String(brief.maxActions),
        actionsUsed: String(revision.actionsUsed),
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
            const budget = await projectContextsRepository.consumeDiscoveryAction(revision.id);
            if (!budget) throw new Error("The discovery draft for this chat no longer exists.");
            if (!budget.allowed) {
                throw new Error(
                    `Discovery action limit reached (${budget.used}/${budget.max}). Stop browsing and call propose_project_context with your current findings.`,
                );
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

export function subscribeToChatUpdates(id: string, listener: () => void): () => void {
    const listeners = chatUpdateListeners.get(id) ?? new Set<() => void>();
    listeners.add(listener);
    chatUpdateListeners.set(id, listeners);
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) chatUpdateListeners.delete(id);
    };
}

export function publishChatUpdate(id: string): void {
    for (const listener of chatUpdateListeners.get(id) ?? []) listener();
}

export function beginChatDeletion(id: string): boolean {
    if (busyChats.has(id) || deletingChats.has(id)) return false;
    deletingChats.add(id);
    return true;
}

export function cancelChatDeletion(id: string): void {
    deletingChats.delete(id);
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
    for (const entry of sessionManager.getEntries()) {
        if (entry.type === "custom_message" && entry.display) {
            const content = extractText({ role: "assistant", content: entry.content }).trim();
            if (content) {
                messages.push({
                    id: entry.id,
                    chatId: id,
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
            chatId: id,
            role: role === "user" ? "user" : "agent",
            content,
            createdAt: entry.timestamp,
        });
    }
    return messages;
}

export async function runChatTurn(id: string, userText: string): Promise<void> {
    if (busyChats.has(id) || deletingChats.has(id)) return;
    busyChats.add(id);
    publishChatUpdate(id);
    let sessionManager: SessionManager | null = null;
    let previousUserCount = 0;
    try {
        const row = await chatsRepository.getChatRow(id);
        sessionManager = await openSession(id);
        if (!row || !sessionManager) return;
        previousUserCount = userMessageCount(sessionManager);
        const project = await projectsRepository.getProject(row.projectId);
        if (!project) {
            ensureUserMessage(sessionManager, userText, previousUserCount);
            appendError(sessionManager, "The project for this chat no longer exists.");
            return;
        }

        const { provider, model: modelName } = await settingsRepository.getLlmSettings();
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
        const scrub = await createProjectScrubber(row.projectId);
        try {
            chatBrowser = await getOrCreateChatBrowser(id);
            const policy: BrowserToolPolicy = discoveryRevision
                ? { ...createDiscoveryBrowserPolicy(discoveryRevision, chatBrowser.mcp), sanitizeResult: scrub }
                : { sanitizeResult: scrub };
            browserTools = bridgeBrowserTools(chatBrowser.mcp, chatBrowser.workDir, policy);
        } catch (error) {
            sessionManager.appendCustomMessageEntry(
                WARNING_TYPE,
                `The agent browser failed to start: ${error instanceof Error ? error.message : String(error)}. Browser tools are unavailable for this turn.`,
                true,
            );
            flushSessionFile(sessionManager);
        }

        const credentialTools = discoveryRevision
            ? []
            : createCredentialTools({
                  projectId: row.projectId,
                  baseUrl: project.baseUrl,
                  chatId: id,
                  mcp: chatBrowser?.mcp ?? null,
                  workDir: chatBrowser?.workDir ?? null,
                  scrub,
                  notify: () => publishChatUpdate(id),
              });
        const customTools = discoveryRevision
            ? [...browserTools, ...createContextTools(discoveryRevision.id, row.projectId)]
            : [...browserTools, ...createDomainTools(row.projectId), ...credentialTools];
        const confirmedContext = discoveryRevision
            ? null
            : await projectContextsRepository.getLatestConfirmedProjectContext(row.projectId);
        const resourceLoader = await createResourceLoader(
            buildSystemPrompt(project, discoveryRevision, confirmedContext),
        );
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
            if (value.type === "agent_end") publishChatUpdate(id);
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
                `The chat turn failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        } else {
            console.error(error);
        }
    } finally {
        busyChats.delete(id);
        publishChatUpdate(id);
    }
}
