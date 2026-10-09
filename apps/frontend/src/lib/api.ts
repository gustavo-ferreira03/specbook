import { invalidate, resourceForPath } from "./invalidation";
import type {
    Chat,
    ChatState,
    CoverageResponse,
    CredentialFieldInput,
    CredentialProfile,
    Feature,
    GitRemoteAccess,
    HumanSpec,
    LlmCurrentSettings,
    LlmOAuthPoll,
    LlmOAuthStart,
    LlmRuntimeStatus,
    LlmSettingsResponse,
    OverviewResponse,
    Project,
    ProjectEnvironment,
    ProjectContext,
    ProjectContextRevision,
    ProjectContextState,
    ProjectTree,
    Run,
    RunBatch,
    RunEvidence,
    SpecDetail,
} from "./types";

export const API_URL = "/api";

export function websocketUrl(path: string): string {
    const url = new URL(`${API_URL}${path}`, window.location.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
}

export class ApiError extends Error {
    readonly status: number;
    readonly code?: string;

    constructor(message: string, status: number, code?: string) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.code = code;
    }
}

export const SERVER_UNREACHABLE_MESSAGE = "Can't reach the Specbook server. Check that the backend is running, then try again.";

export function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function apiPath(strings: TemplateStringsArray, ...values: (string | number)[]): string {
    return strings.reduce((path, part, index) => path + part + (index < values.length ? encodeURIComponent(String(values[index])) : ""), "");
}

export function safeReturnPath(value: string | null): string {
    if (!value?.startsWith("/") || value.startsWith("//") || /[\\\r\n]/.test(value)) return "/";
    const url = new URL(value, "https://specbook.local");
    if (url.origin !== "https://specbook.local" || ["/login", "/setup", "/join"].includes(url.pathname)) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (method !== "GET" && method !== "HEAD") headers.set("X-Specbook-Request", "1");

    let response: Response;
    try {
        response = await fetch(`${API_URL}${path}`, { credentials: "same-origin", ...init, headers });
    } catch (error) {
        if (isAbortError(error)) throw error;
        throw new ApiError(SERVER_UNREACHABLE_MESSAGE, 0, "network_error");
    }
    if (!response.ok) {
        if (response.status === 401 && typeof window !== "undefined" && !path.startsWith("/auth/") && !path.startsWith("/setup/") && !["/login", "/setup", "/join"].includes(window.location.pathname)) {
            const next = safeReturnPath(`${window.location.pathname}${window.location.search}${window.location.hash}`);
            window.location.replace(`/login?next=${encodeURIComponent(next)}`);
        }
        const text = await response.text().catch(() => "");
        let message = text;
        let code: string | undefined;
        try {
            const body = JSON.parse(text) as { error?: string; message?: string; code?: string; nextStep?: string };
            message = [body.error ?? body.message ?? text, body.nextStep].filter(Boolean).join(" ");
            code = typeof body.code === "string" ? body.code : undefined;
        } catch {}
        throw new ApiError(message || `Request failed with status ${response.status}`, response.status, code);
    }
    if (method !== "GET" && method !== "HEAD") invalidate({ resource: resourceForPath(path) });
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
}

export function listProjects(signal?: AbortSignal): Promise<{ projects: Project[] }> {
    return api("/projects", { signal });
}

export function getProject(projectId: string, signal?: AbortSignal): Promise<{ project: Project }> {
    return api(apiPath`/projects/${projectId}`, { signal });
}

export function getProjectTree(projectId: string, signal?: AbortSignal): Promise<ProjectTree> {
    return api(apiPath`/projects/${projectId}/tree`, { signal });
}

export function listProjectChats(projectId: string, signal?: AbortSignal): Promise<{ chats: Chat[] }> {
    return api(apiPath`/projects/${projectId}/chats`, { signal });
}

export function startProjectChat(projectId: string, text: string): Promise<{ chat: { id: string } }> {
    return api(apiPath`/projects/${projectId}/chats`, { method: "POST", body: JSON.stringify({ text }) });
}

export function getHealth(signal?: AbortSignal): Promise<{ ok: boolean }> {
    return api("/health", { signal });
}

export function getChat(chatId: string, signal?: AbortSignal): Promise<ChatState> {
    return api(apiPath`/chats/${chatId}`, { signal });
}

export function sendChatMessage(chatId: string, text: string): Promise<{ ok: true }> {
    return api(apiPath`/chats/${chatId}/message`, { method: "POST", body: JSON.stringify({ text }) });
}

export function chatEventsUrl(chatId: string): string {
    return `${API_URL}${apiPath`/chats/${chatId}/events`}`;
}

export function deleteChat(chatId: string): Promise<void> {
    return api(apiPath`/chats/${chatId}`, { method: "DELETE" });
}

export function getSpec(specId: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<SpecDetail> {
    const query = options.limit ? `?limit=${options.limit}` : "";
    return api(`${apiPath`/specs/${specId}`}${query}`, { signal: options.signal });
}

export function runSpec(specId: string, environment?: string): Promise<{ run: Run }> {
    return api(`${apiPath`/specs/${specId}/run`}${environment ? `?environment=${encodeURIComponent(environment)}` : ""}`, { method: "POST" });
}

export function deleteSpec(specId: string): Promise<void> {
    return api(apiPath`/specs/${specId}`, { method: "DELETE" });
}

export function deleteFeature(featureId: string): Promise<void> {
    return api(apiPath`/features/${featureId}`, { method: "DELETE" });
}

export function getRunEvidence(runId: string, signal?: AbortSignal): Promise<RunEvidence> {
    return api(apiPath`/runs/${runId}/evidence`, { signal });
}

export async function getRunArtifactText(runId: string, file: string, signal?: AbortSignal): Promise<string | null> {
    let response: Response;
    try {
        response = await fetch(`${API_URL}${apiPath`/runs/${runId}/artifacts/`}${file.split("/").map(encodeURIComponent).join("/")}`, { signal });
    } catch (error) {
        if (isAbortError(error)) throw error;
        return null;
    }
    return response.ok ? response.text() : null;
}

export interface DiscoveryBriefInput {
    goal?: string;
    startUrl?: string;
    safetyNotes?: string[];
}

export function createContextDiscovery(
    projectId: string,
    brief: DiscoveryBriefInput,
): Promise<{ revision: ProjectContextRevision; chat: { id: string } }> {
    return api(`/projects/${encodeURIComponent(projectId)}/context-discoveries`, {
        method: "POST",
        body: JSON.stringify(brief),
    });
}

export function getProjectContext(projectId: string): Promise<ProjectContextState> {
    return api(`/projects/${encodeURIComponent(projectId)}/context`);
}

export function patchProjectContext(
    revisionId: string,
    patch: { context?: ProjectContext },
): Promise<{ revision: ProjectContextRevision }> {
    return api(`/project-contexts/${encodeURIComponent(revisionId)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
    });
}

export function confirmProjectContext(revisionId: string): Promise<{ revision: ProjectContextRevision }> {
    return api(`/project-contexts/${encodeURIComponent(revisionId)}/confirm`, { method: "POST" });
}

export function discardProjectContext(revisionId: string): Promise<{ revision: ProjectContextRevision }> {
    return api(`/project-contexts/${encodeURIComponent(revisionId)}/discard`, { method: "POST" });
}

export function startRunBatch(projectId: string, specIds: string[], label: string, environment?: string): Promise<{ batch: RunBatch }> {
    return api(`/projects/${encodeURIComponent(projectId)}/run-batches`, {
        method: "POST",
        body: JSON.stringify({ specIds, label, environment }),
    });
}

export function getRunBatch(batchId: string, signal?: AbortSignal): Promise<{ batch: RunBatch; reportUrl: string | null }> {
    return api(`/run-batches/${encodeURIComponent(batchId)}`, { signal });
}

export function updateProject(
    projectId: string,
    input: { name?: string; baseUrl?: string },
): Promise<{ project: Project }> {
    return api(`/projects/${encodeURIComponent(projectId)}`, {
        method: "PATCH",
        body: JSON.stringify(input),
    });
}

export function editChatMessage(chatId: string, messageId: string, text: string): Promise<{ ok: boolean }> {
    return api<{ ok: boolean }>(
        `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
        { method: "PATCH", body: JSON.stringify({ text }) },
    );
}

export function retryChatMessage(chatId: string, messageId: string): Promise<{ ok: boolean }> {
    return api<{ ok: boolean }>(
        `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/retry`,
        { method: "POST" },
    );
}

export function queueChatFollowUp(chatId: string, text: string): Promise<{ ok: boolean }> {
    return api<{ ok: boolean }>(`/chats/${encodeURIComponent(chatId)}/follow-up`, {
        method: "POST",
        body: JSON.stringify({ text }),
    });
}

export function abortChatTurn(chatId: string): Promise<{ ok: boolean }> {
    return api<{ ok: boolean }>(`/chats/${encodeURIComponent(chatId)}/abort`, { method: "POST" });
}

export function deleteProject(projectId: string): Promise<void> {
    return api(`/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
}

export function getProjectGitRemote(projectId: string): Promise<{ remote: GitRemoteAccess }> {
    return api(`/projects/${encodeURIComponent(projectId)}/git/remote`);
}

export function issueProjectGitRemoteToken(projectId: string): Promise<{ token: string; remote: GitRemoteAccess }> {
    return api(`/projects/${encodeURIComponent(projectId)}/git/remote/token`, { method: "POST" });
}

export function revokeProjectGitRemoteToken(projectId: string): Promise<{ remote: GitRemoteAccess }> {
    return api(`/projects/${encodeURIComponent(projectId)}/git/remote/token`, { method: "DELETE" });
}

export function getSpecHistory(specId: string): Promise<{
    entries: { sha: string; date: string; message: string }[];
}> {
    return api(`/specs/${encodeURIComponent(specId)}/history`);
}

export function getSpecAtCommit(
    specId: string,
    sha: string,
): Promise<{ yaml: string | null; testSource: string | null }> {
    return api(`/specs/${encodeURIComponent(specId)}/history/${encodeURIComponent(sha)}`);
}

export function testLlmConnection(): Promise<{ ok: true; message: string }> {
    return api("/settings/llm/test", { method: "POST" });
}

export function getLlmSettings(): Promise<LlmSettingsResponse> {
    return api<LlmSettingsResponse>("/settings/llm");
}

export function getLlmRuntimeStatus(): Promise<LlmRuntimeStatus> {
    return api<LlmRuntimeStatus>("/settings/llm/status");
}

export function updateLlmSettings(update: Partial<LlmCurrentSettings>): Promise<LlmCurrentSettings> {
    return api<LlmCurrentSettings>("/settings/llm", {
        method: "PATCH",
        body: JSON.stringify(update),
    });
}

export function saveLlmProviderApiKey(providerId: string, apiKey: string): Promise<{ ok: boolean }> {
    return api<{ ok: boolean }>(`/settings/llm/providers/${encodeURIComponent(providerId)}`, {
        method: "PUT",
        body: JSON.stringify({ apiKey }),
    });
}

export function removeLlmProviderAuth(providerId: string): Promise<{ ok: boolean }> {
    return api<{ ok: boolean }>(`/settings/llm/providers/${encodeURIComponent(providerId)}`, {
        method: "DELETE",
    });
}

export function startLlmProviderOAuth(providerId: string): Promise<LlmOAuthStart> {
    return api<LlmOAuthStart>(`/settings/llm/providers/${encodeURIComponent(providerId)}/oauth/start`, {
        method: "POST",
    });
}

export function pollLlmProviderOAuth(providerId: string, sessionId: string): Promise<LlmOAuthPoll> {
    return api<LlmOAuthPoll>(
        `/settings/llm/providers/${encodeURIComponent(providerId)}/oauth/poll?sessionId=${encodeURIComponent(sessionId)}`,
    );
}

export function submitLlmProviderOAuthInput(providerId: string, sessionId: string, input: string): Promise<{ ok: boolean }> {
    return api<{ ok: boolean }>(`/settings/llm/providers/${encodeURIComponent(providerId)}/oauth/input`, {
        method: "POST",
        body: JSON.stringify({ sessionId, input }),
    });
}

export function updateSpecFiles(specId: string, input: { yaml?: string; testSource?: string }): Promise<SpecDetail> {
    return api(`/specs/${encodeURIComponent(specId)}/files`, {
        method: "PUT",
        body: JSON.stringify(input),
    });
}

export function updateSpec(
    specId: string,
    input: { title?: string; description?: string; humanSpec?: HumanSpec },
): Promise<SpecDetail> {
    return api(`/specs/${encodeURIComponent(specId)}`, {
        method: "PATCH",
        body: JSON.stringify(input),
    });
}

export function createManualSpec(
    projectId: string,
    featureId: string,
    title: string,
): Promise<{ spec: { id: string } }> {
    return api(`/projects/${encodeURIComponent(projectId)}/specs`, {
        method: "POST",
        body: JSON.stringify({ featureId, title }),
    });
}

export function createFeature(
    projectId: string,
    input: { parentId?: string; title: string; description?: string },
): Promise<{ feature: Feature }> {
    return api(`/projects/${encodeURIComponent(projectId)}/features`, {
        method: "POST",
        body: JSON.stringify(input),
    });
}

export function updateFeature(
    featureId: string,
    input: { title?: string; description?: string },
): Promise<{ feature: Feature }> {
    return api(`/features/${encodeURIComponent(featureId)}`, {
        method: "PATCH",
        body: JSON.stringify(input),
    });
}

export function getContextFile(projectId: string): Promise<{ yaml: string | null; contextSyncError: string | null }> {
    return api(`/projects/${encodeURIComponent(projectId)}/context-file`);
}

export function updateContextFile(
    projectId: string,
    yaml: string,
): Promise<{ yaml: string | null; contextSyncError: string | null }> {
    return api(`/projects/${encodeURIComponent(projectId)}/context-file`, {
        method: "PUT",
        body: JSON.stringify({ yaml }),
    });
}

export function listCredentialProfiles(projectId: string): Promise<{ profiles: CredentialProfile[] }> {
    return api(`/projects/${encodeURIComponent(projectId)}/credentials`);
}

export function createCredentialProfile(
    projectId: string,
    input: { name: string; allowedOrigins?: string[]; fields: CredentialFieldInput[] },
): Promise<{ profile: CredentialProfile }> {
    return api(`/projects/${encodeURIComponent(projectId)}/credentials`, {
        method: "POST",
        body: JSON.stringify(input),
    });
}

export function updateCredentialProfile(
    profileId: string,
    input: { allowedOrigins?: string[]; fields: CredentialFieldInput[] },
): Promise<{ profile: CredentialProfile }> {
    return api(`/credentials/${encodeURIComponent(profileId)}`, {
        method: "PUT",
        body: JSON.stringify(input),
    });
}

export function deleteCredentialProfile(profileId: string): Promise<void> {
    return api(`/credentials/${encodeURIComponent(profileId)}`, { method: "DELETE" });
}

export function resolveChatCredentialRequest(
    chatId: string,
    requestId: string,
    body: { action: "dismiss" } | { action: "submit"; values: Record<string, string> },
): Promise<{ ok: boolean }> {
    return api(`/chats/${encodeURIComponent(chatId)}/credential-requests/${encodeURIComponent(requestId)}`, {
        method: "POST",
        body: JSON.stringify(body),
    });
}

export function getEnvironments(projectId: string, signal?: AbortSignal): Promise<{ environments: ProjectEnvironment[] }> {
    return api(apiPath`/projects/${projectId}/environments`, { signal });
}


export function getOverview(projectId: string, signal?: AbortSignal): Promise<OverviewResponse> {
    return api(apiPath`/projects/${projectId}/overview`, { signal });
}

export function getCoverage(projectId: string, signal?: AbortSignal): Promise<CoverageResponse> {
    return api(apiPath`/projects/${projectId}/coverage`, { signal });
}

export function requestTask(projectId: string, kind: "coverage" | "explore"): Promise<{ intentId: string; status: "queued" | "running" | "paused" }> {
    return api(apiPath`/projects/${projectId}/tasks`, { method: "POST", body: JSON.stringify({ kind }) });
}

export function setStewardPaused(projectId: string, paused: boolean): Promise<unknown> {
    return api(apiPath`/projects/${projectId}/steward`, { method: "PUT", body: JSON.stringify({ paused }) });
}
