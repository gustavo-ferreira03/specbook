import path from "node:path";
import type { TurnPolicy } from "../jobs/policy";
import {
    createAgentSession,
    DefaultResourceLoader,
    type SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
    beginChatBrowserTool,
    closeChatBrowser,
    endChatBrowserTool,
    getOrCreateChatBrowser,
} from "../browser/sessions";
import { bridgeBrowserTools, type BrowserToolPolicy } from "../browser/mcp";
import { modelRegistryPromise, modelRuntimePromise } from "../llm/runtime";
import { storageRoot } from "../paths";
import { createProjectScrubber } from "../credentials/scrub";
import { chatsRepository } from "../../infra/repositories/chats";
import { credentialsRepository } from "../../infra/repositories/credentials";
import { jobsRepository } from "../../infra/repositories/jobs";
import { projectContextsRepository } from "../../infra/repositories/project-contexts";
import { projectsRepository } from "../../infra/repositories/projects";
import { settingsRepository } from "../../infra/repositories/settings";
import { logger } from "../../infra/logger";
import { auditTools } from "../accounts/audit";
import { agentSettings } from "./safety-settings";
import {
    ChatBusyError,
    clearActiveChatSession,
    consumeAbortRequest,
    getActiveChatSession,
    getChatQueueState,
    publishChatUpdate,
    releaseChatTurn,
    setActiveChatSession,
    takePendingFollowUps,
    tryReserveChatTurn,
    type ActiveChatSession,
} from "./chat-registry";
import { createContextTools, createSpecBatchTool, createApiDocumentationTool } from "./context-tools";
import { createCredentialTools } from "./credential-tools";
import { createExplorationTools } from "./exploration-tools";
import { createBackgroundTaskTool } from "../steward/tools";
import { createAutonomousBrowserPolicy, createDiscoveryBrowserPolicy, createOriginBrowserPolicy } from "./discovery-policy";
import { TurnMetricsRecorder, type TurnTrigger } from "./metrics";
import { buildSystemPrompt } from "./prompts";
import {
    appendError,
    appendWarning,
    branchSessionForTurn,
    cwd,
    ensureUserMessage,
    openSession,
    userMessageCount,
    type AgentMessage,
} from "./session-store";
import { createSessionTools } from "./session-tools";
import { createDomainTools } from "./tools";
import { ChatTurnTimeoutError, withTurnTimeout } from "./deadline";
import { browserFailureMessage, providerFailure, providerFailureMessage } from "../jobs/presentation-errors";

const agentDir = path.join(storageRoot, "pi-agent");

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

/**
 * Reserves the chat synchronously and starts a turn in the background.
 * Throws ChatBusyError when a turn is already running or the chat is being deleted.
 */
export function startChatTurn(id: string, userText: string): void {
    if (!tryReserveChatTurn(id)) throw new ChatBusyError("The agent is still replying");
    void runReservedChatTurn(id, userText, undefined, "message").catch(console.error);
}

/**
 * Reserves the chat synchronously, moves the session leaf to replay `messageId` (edited
 * or retried) and starts the turn in the background. The reservation is released if the
 * branch cannot be prepared.
 */
export async function startBranchedChatTurn(
    id: string,
    messageId: string,
    options: { editedText?: string; userOnly?: boolean } = {},
): Promise<void> {
    if (!tryReserveChatTurn(id)) throw new ChatBusyError("The agent is still replying");
    let branch: Awaited<ReturnType<typeof branchSessionForTurn>>;
    try {
        branch = await branchSessionForTurn(id, messageId, options);
    } catch (error) {
        releaseChatTurn(id);
        publishChatUpdate(id);
        throw error;
    }
    const trigger: TurnTrigger = options.editedText !== undefined ? "edit" : "retry";
    void runReservedChatTurn(id, branch.text, branch.sessionManager, trigger).catch(console.error);
}

/** Moves the session leaf for a replayed turn. Rejects while a turn is running. */
export async function branchChatForTurn(
    id: string,
    messageId: string,
    options: { editedText?: string; userOnly?: boolean } = {},
): Promise<{ text: string; sessionManager: SessionManager }> {
    if (!tryReserveChatTurn(id)) throw new Error("The agent is still replying");
    try {
        return await branchSessionForTurn(id, messageId, options);
    } finally {
        releaseChatTurn(id);
    }
}

/** Runs a turn if the chat is free; silently returns when it is busy or being deleted. */
export async function runChatTurn(
    id: string,
    userText: string,
    existingSessionManager?: SessionManager,
    policy?: TurnPolicy,
): Promise<void> {
    if (!tryReserveChatTurn(id)) return;
    await runReservedChatTurn(id, userText, existingSessionManager, existingSessionManager ? "retry" : "message", policy);
}

interface SessionEventValue {
    type?: string;
    message?: AgentMessage & { usage?: Parameters<TurnMetricsRecorder["assistantMessage"]>[0]["usage"] };
    messages?: AgentMessage[];
    assistantMessageEvent?: { type?: string; delta?: string };
    toolName?: string;
    isError?: boolean;
    steering?: readonly string[];
    followUp?: readonly string[];
    willRetry?: boolean;
    attempt?: number;
    maxAttempts?: number;
    errorMessage?: string;
}

/** Runs a turn for a chat whose reservation the caller already holds; always releases it. */
async function runReservedChatTurn(
    id: string,
    userText: string,
    existingSessionManager: SessionManager | undefined,
    trigger: TurnTrigger,
    turnPolicy?: TurnPolicy,
): Promise<void> {
    publishChatUpdate(id);
    const metrics = new TurnMetricsRecorder(id, trigger);
    let sessionManager: SessionManager | null = existingSessionManager ?? null;
    let previousUserCount = 0;
    let activeSession: ActiveChatSession | null = null;
    try {
        if (consumeAbortRequest(id)) {
            metrics.fail("aborted", "aborted_before_start");
            return;
        }
        const row = await chatsRepository.getChatRow(id);
        sessionManager = sessionManager ?? (await openSession(id));
        if (!row || !sessionManager) {
            metrics.fail("error", "chat_missing");
            return;
        }
        metrics.setContext({ projectId: row.projectId, mode: row.contextRevisionId ? "discovery" : "standard" });
        metrics.seedFromSession(sessionManager);
        if (consumeAbortRequest(id)) {
            metrics.fail("aborted", "aborted_before_start");
            return;
        }
        previousUserCount = userMessageCount(sessionManager);
        const storedProject = await projectsRepository.getProject(row.projectId);
        const project = storedProject && turnPolicy?.baseUrl ? { ...storedProject, baseUrl: turnPolicy.baseUrl } : storedProject;
        if (!project) {
            metrics.fail("error", "project_missing");
            ensureUserMessage(sessionManager, userText, previousUserCount);
            appendError(sessionManager, "The project for this chat no longer exists.");
            return;
        }

        const [modelRegistry, modelRuntime, { provider, model: modelName }] = await Promise.all([
            modelRegistryPromise,
            modelRuntimePromise,
            settingsRepository.getLlmSettings(),
        ]);
        metrics.setContext({ provider: provider || null, model: modelName || null });
        const model = provider && modelName ? modelRegistry.find(provider, modelName) : null;
        if (!model) {
            metrics.fail("error", provider || modelName ? "model_unavailable" : "model_not_configured");
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
            metrics.fail("error", "provider_not_authenticated");
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
            metrics.fail("rejected", "discovery_closed");
            ensureUserMessage(sessionManager, userText, previousUserCount);
            appendError(sessionManager, "This discovery is closed and cannot accept more messages.");
            return;
        }

        let browserTools: ReturnType<typeof bridgeBrowserTools> = [];
        let chatBrowser: Awaited<ReturnType<typeof getOrCreateChatBrowser>> | null = null;
        const scrub = createProjectScrubber(row.projectId);
        try {
            const startUrl = discoveryRevision?.brief.startUrl ?? project.baseUrl;
            const profiles = await credentialsRepository.listProfiles(row.projectId);
            const origins = [...new Set([new URL(startUrl).origin, ...(turnPolicy?.environment?.allowedOrigins ?? []), ...profiles.flatMap((profile) => profile.allowedOrigins)])];
            chatBrowser = await getOrCreateChatBrowser(id, origins);
            const browser = chatBrowser;
            const basePolicy: BrowserToolPolicy = discoveryRevision
                ? { ...createDiscoveryBrowserPolicy(discoveryRevision, browser.mcp, origins), sanitizeResult: scrub }
                : turnPolicy ? { ...createAutonomousBrowserPolicy(project.baseUrl, browser.mcp, origins), sanitizeResult: scrub } : { ...createOriginBrowserPolicy(project.baseUrl, browser.mcp, origins), sanitizeResult: scrub };
            const policy: BrowserToolPolicy = {
                ...basePolicy,
                beforeCall: async (toolName, args, signal) => {
                    await browser.mcp.ensureBrowser(signal);
                    await basePolicy.beforeCall?.(toolName, args, signal);
                    beginChatBrowserTool(id, toolName);
                    publishChatUpdate(id);
                },
                afterCall: async (toolName, args, result, signal) => {
                    try {
                        if (!signal?.aborted) await basePolicy.afterCall?.(toolName, args, result, signal);
                    } finally {
                        endChatBrowserTool(id, toolName);
                        publishChatUpdate(id);
                    }
                },
            };
            browserTools = bridgeBrowserTools(browser.mcp, browser.workDir, policy);
            metrics.setBrowserAvailable(true);
            await turnPolicy?.browserReady?.();
        } catch (error) {
            logger.warn("chat browser unavailable", { chatId: id, error });
            if (turnPolicy?.infrastructureFailure) {
                await turnPolicy.infrastructureFailure(String(error));
                return;
            }
            appendWarning(
                sessionManager,
                browserFailureMessage(error),
            );
        }

        const credentialTools = createCredentialTools({
            projectId: row.projectId,
            baseUrl: storedProject!.baseUrl,
            environment: turnPolicy?.environment,
            chatId: id,
            mcp: chatBrowser?.mcp ?? null,
            workDir: chatBrowser?.workDir ?? null,
            scrub,
            notify: () => publishChatUpdate(id),
        });
        const sessionTools = createSessionTools({
            projectId: row.projectId,
            baseUrl: project.baseUrl,
            productionBaseUrl: storedProject!.baseUrl,
            environment: turnPolicy?.environment,
            mcp: chatBrowser?.mcp ?? null,
            workDir: chatBrowser?.workDir ?? null,
        });
        const explorationTools = createExplorationTools({
            baseUrl: project.baseUrl,
            mcp: chatBrowser?.mcp ?? null,
            scrub,
            recordEvidence: async (json) => {
                const job = await jobsRepository.forChat(id);
                if (!job) return;
                await jobsRepository.log(job.id, "page_scan", json);
                return `/p/${row.projectId}/overview#${job.id}`;
            },
        });
        const customTools = discoveryRevision
            ? [
                  ...browserTools,
                  ...createContextTools(discoveryRevision.id, row.projectId, id),
                  createApiDocumentationTool(row.projectId, turnPolicy?.environment),
                  ...credentialTools,
                  ...sessionTools,
                  ...explorationTools,
              ]
            : [
                  ...browserTools,
                  ...createDomainTools(row.projectId, { scrub, metrics, baseUrl: project.baseUrl, environment: turnPolicy?.environment }),
                  createSpecBatchTool(row.projectId, id),
                  createApiDocumentationTool(row.projectId, turnPolicy?.environment),
                  ...(!turnPolicy ? [createBackgroundTaskTool(row.projectId, `chat:${id}`)] : []),
                  ...credentialTools,
                  ...sessionTools,
                  ...explorationTools,
              ];
        const confirmedContext = discoveryRevision
            ? null
            : await projectContextsRepository.getLatestConfirmedProjectContext(row.projectId);
        const resourceLoader = await createResourceLoader(
            buildSystemPrompt(project, discoveryRevision, confirmedContext) + (turnPolicy?.prompt ?? ""),
        );
        if (consumeAbortRequest(id)) {
            metrics.fail("aborted", "aborted_before_start");
            return;
        }
        const { session } = await createAgentSession({
            model,
            modelRuntime,
            cwd,
            noTools: "builtin",
            customTools: auditTools(row.projectId, id, turnPolicy ? turnPolicy.tools(customTools) : customTools),
            resourceLoader,
            sessionManager,
            settingsManager: await agentSettings(),
        });
        const active: ActiveChatSession = { session, sessionManager, aborted: false };
        activeSession = active;
        setActiveChatSession(id, active);
        const queuedFollowUps = takePendingFollowUps(id);
        let modelError = "";
        let promptFailed = false;
        let timedOut = false;
        const unsubscribe = session.subscribe((event) => {
            const value = event as unknown as SessionEventValue;
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
            if (value.type === "message_start" && value.message?.role === "assistant") {
                publishChatUpdate(id, { type: "message_start" });
            }
            if (value.type === "message_start" && value.message?.role === "user") {
                metrics.userMessage();
            }
            if (value.type === "message_update" && value.assistantMessageEvent?.type === "text_delta") {
                const delta = value.assistantMessageEvent.delta;
                if (delta) publishChatUpdate(id, { type: "assistant_delta", delta });
            }
            if (value.type === "message_end" && value.message?.role === "assistant") {
                metrics.assistantMessage(value.message);
                turnPolicy?.tokens(value.message.usage?.totalTokens ?? 0);
                publishChatUpdate(id, { type: "message_end" });
            }
            if (value.type === "tool_execution_start" && value.toolName) {
                metrics.toolStart(value.toolName);
                publishChatUpdate(id, { type: "tool_start", toolName: value.toolName });
            }
            if (value.type === "tool_execution_end" && value.toolName) {
                metrics.toolEnd(value.toolName, value.isError === true);
                publishChatUpdate(id, { type: "tool_end", toolName: value.toolName });
            }
            if (value.type === "agent_start") {
                publishChatUpdate(id, { type: "agent_status", status: "working" });
            }
            if (value.type === "agent_end") {
                publishChatUpdate(
                    id,
                    value.willRetry
                        ? { type: "agent_status", status: "retrying", message: providerFailureMessage(value.errorMessage) }
                        : { type: "updated" },
                );
            }
            if (value.type === "agent_settled") {
                publishChatUpdate(id, { type: "agent_status", status: "idle" });
            }
            if (value.type === "auto_retry_start") {
                metrics.autoRetry();
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
            await withTurnTimeout(async () => {
                const promptPromise = session.prompt(userText);
                for (const followUp of queuedFollowUps) await session.followUp(followUp);
                await promptPromise;
            }, async () => {
                active.aborted = true;
                await Promise.allSettled([session.abort(), closeChatBrowser(id)]);
            });
        } catch (error) {
            promptFailed = true;
            if (error instanceof ChatTurnTimeoutError) {
                timedOut = true;
                metrics.fail("error", "turn_timeout");
                ensureUserMessage(sessionManager, userText, previousUserCount);
                appendError(sessionManager, error.message);
            } else if (!active.aborted) {
                metrics.fail("error", "prompt_failed");
                ensureUserMessage(sessionManager, userText, previousUserCount);
                appendError(
                    sessionManager,
                    providerFailureMessage(error),
                );
            }
        } finally {
            unsubscribe();
            session.dispose();
            clearActiveChatSession(id, session);
        }
        if (active.aborted && !timedOut) metrics.fail("aborted", "user_abort");
        if (modelError && !active.aborted && !promptFailed) {
            metrics.fail("error", "model_error");
            appendError(sessionManager, providerFailureMessage(modelError));
        }
    } catch (error) {
        const aborted = activeSession?.aborted ?? getActiveChatSession(id)?.aborted ?? false;
        metrics.fail(aborted ? "aborted" : "error", aborted ? "user_abort" : "turn_failed");
        if (!aborted) logger.error("chat turn failed", { chatId: id, error });
        if (sessionManager) {
            if (!aborted) {
                ensureUserMessage(sessionManager, userText, previousUserCount);
                appendError(
                    sessionManager,
                    providerFailure(error).code === "provider_error"
                        ? "Specbook could not complete this conversation turn. Try again. If it keeps failing, check System status in global Settings."
                        : providerFailureMessage(error),
                );
            }
        } else {
            console.error(error);
        }
    } finally {
        try {
            await turnPolicy?.flush();
        } finally {
            releaseChatTurn(id);
            publishChatUpdate(id, { type: "agent_status", status: "idle" });
            publishChatUpdate(id, { type: "queue_update", ...getChatQueueState(id) });
            publishChatUpdate(id);
            void metrics.finish();
        }
    }
}
