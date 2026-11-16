import type { ReplayRecording } from "@specbook/runtime/replay-assets";

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
  ProjectTunnel,
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

export const websocketUrl = function websocketUrl(path: string): string {
  const url = new URL(`${API_URL}${path}`, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};

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

export const SERVER_UNREACHABLE_MESSAGE =
  "Can't reach the Specbook server. Check that the backend is running, then try again.";

export const isAbortError = function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
};

export const errorMessage = function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
};

export const apiPath = function apiPath(
  strings: TemplateStringsArray,
  ...values: (string | number)[]
): string {
  return strings.reduce(
    (path, part, index) =>
      path +
      part +
      (index < values.length ? encodeURIComponent(String(values[index])) : ""),
    ""
  );
};

export const safeReturnPath = function safeReturnPath(
  value: string | null
): string {
  if (
    !value?.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\r\n]/u.test(value)
  ) {
    return "/";
  }
  const url = new URL(value, "https://specbook.local");
  if (
    url.origin !== "https://specbook.local" ||
    ["/login", "/setup", "/join"].includes(url.pathname)
  ) {
    return "/";
  }
  return `${url.pathname}${url.search}${url.hash}`;
};

export const api =
  /* oxlint-disable eslint/complexity -- Keep the existing render states and their coordinated actions together during the lint migration. */
  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    if (init?.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    if (method !== "GET" && method !== "HEAD") {
      headers.set("X-Specbook-Request", "1");
    }

    let response: Response;
    try {
      response = await fetch(`${API_URL}${path}`, {
        credentials: "same-origin",
        ...init,
        headers,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new ApiError(SERVER_UNREACHABLE_MESSAGE, 0, "network_error");
    }
    if (!response.ok) {
      if (
        response.status === 401 &&
        typeof window !== "undefined" &&
        !path.startsWith("/auth/") &&
        !path.startsWith("/setup/") &&
        !["/login", "/setup", "/join"].includes(window.location.pathname)
      ) {
        const next = safeReturnPath(
          `${window.location.pathname}${window.location.search}${window.location.hash}`
        );
        window.location.replace(`/login?next=${encodeURIComponent(next)}`);
      }
      const text = await (async () => {
        try {
          return await response.text();
        } catch {
          return "";
        }
      })();
      let message = text;
      let code: string | undefined;
      try {
        const body = JSON.parse(text) as {
          error?: string;
          message?: string;
          code?: string;
          nextStep?: string;
        };
        message = [body.error ?? body.message ?? text, body.nextStep]
          .filter(Boolean)
          .join(" ");
        code = typeof body.code === "string" ? body.code : undefined;
      } catch {
        // Keep the last usable state if this optional operation fails.
      }
      throw new ApiError(
        message || `Request failed with status ${response.status}`,
        response.status,
        code
      );
    }
    if (method !== "GET" && method !== "HEAD") {
      invalidate({ resource: resourceForPath(path) });
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return response.json() as Promise<T>;
  };
/* oxlint-enable eslint/complexity */

export const listProjects = function listProjects(
  signal?: AbortSignal
): Promise<{ projects: Project[] }> {
  return api("/projects", { signal });
};

export const getProject = function getProject(
  projectId: string,
  signal?: AbortSignal
): Promise<{ project: Project }> {
  return api(apiPath`/projects/${projectId}`, { signal });
};

export const getProjectTree = function getProjectTree(
  projectId: string,
  signal?: AbortSignal
): Promise<ProjectTree> {
  return api(apiPath`/projects/${projectId}/tree`, { signal });
};

export const listProjectChats = function listProjectChats(
  projectId: string,
  signal?: AbortSignal
): Promise<{ chats: Chat[] }> {
  return api(apiPath`/projects/${projectId}/chats`, { signal });
};

export const startProjectChat = function startProjectChat(
  projectId: string,
  text: string
): Promise<{ chat: { id: string } }> {
  return api(apiPath`/projects/${projectId}/chats`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
};

export const getHealth = function getHealth(
  signal?: AbortSignal
): Promise<{ ok: boolean }> {
  return api("/health", { signal });
};

export const getChat = function getChat(
  chatId: string,
  signal?: AbortSignal
): Promise<ChatState> {
  return api(apiPath`/chats/${chatId}`, { signal });
};

export const sendChatMessage = function sendChatMessage(
  chatId: string,
  text: string
): Promise<{ ok: true }> {
  return api(apiPath`/chats/${chatId}/message`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
};

export const chatEventsUrl = function chatEventsUrl(chatId: string): string {
  return `${API_URL}${apiPath`/chats/${chatId}/events`}`;
};

export const deleteChat = function deleteChat(chatId: string): Promise<void> {
  return api(apiPath`/chats/${chatId}`, { method: "DELETE" });
};

export const getSpec = function getSpec(
  specId: string,
  options: { limit?: number; signal?: AbortSignal } = {}
): Promise<SpecDetail> {
  const query = options.limit ? `?limit=${options.limit}` : "";
  return api(`${apiPath`/specs/${specId}`}${query}`, {
    signal: options.signal,
  });
};

export const runSpec = function runSpec(
  specId: string,
  environment?: string
): Promise<{ run: Run }> {
  return api(
    `${apiPath`/specs/${specId}/run`}${environment ? `?environment=${encodeURIComponent(environment)}` : ""}`,
    { method: "POST" }
  );
};

export const deleteSpec = function deleteSpec(specId: string): Promise<void> {
  return api(apiPath`/specs/${specId}`, { method: "DELETE" });
};

export const deleteFeature = function deleteFeature(
  featureId: string
): Promise<void> {
  return api(apiPath`/features/${featureId}`, { method: "DELETE" });
};

export const getRunEvidence = function getRunEvidence(
  runId: string,
  signal?: AbortSignal
): Promise<RunEvidence> {
  return api(apiPath`/runs/${runId}/evidence`, { signal });
};

export const getRunReplay = function getRunReplay(
  runId: string,
  signal?: AbortSignal
): Promise<ReplayRecording> {
  return api(apiPath`/runs/${runId}/replay`, { signal });
};

export interface DiscoveryBriefInput {
  goal?: string;
  startUrl?: string;
  safetyNotes?: string[];
}

export const createContextDiscovery = function createContextDiscovery(
  projectId: string,
  brief: DiscoveryBriefInput
): Promise<{ revision: ProjectContextRevision; chat: { id: string } }> {
  return api(`/projects/${encodeURIComponent(projectId)}/context-discoveries`, {
    method: "POST",
    body: JSON.stringify(brief),
  });
};

export const getProjectContext = function getProjectContext(
  projectId: string
): Promise<ProjectContextState> {
  return api(`/projects/${encodeURIComponent(projectId)}/context`);
};

export const patchProjectContext = function patchProjectContext(
  revisionId: string,
  patch: { context?: ProjectContext }
): Promise<{ revision: ProjectContextRevision }> {
  return api(`/project-contexts/${encodeURIComponent(revisionId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
};

export const confirmProjectContext = function confirmProjectContext(
  revisionId: string
): Promise<{ revision: ProjectContextRevision }> {
  return api(`/project-contexts/${encodeURIComponent(revisionId)}/confirm`, {
    method: "POST",
  });
};

export const discardProjectContext = function discardProjectContext(
  revisionId: string
): Promise<{ revision: ProjectContextRevision }> {
  return api(`/project-contexts/${encodeURIComponent(revisionId)}/discard`, {
    method: "POST",
  });
};

export const startRunBatch = function startRunBatch(
  projectId: string,
  specIds: string[],
  label: string,
  environment?: string
): Promise<{ batch: RunBatch }> {
  return api(`/projects/${encodeURIComponent(projectId)}/run-batches`, {
    method: "POST",
    body: JSON.stringify({ specIds, label, environment }),
  });
};

export const getRunBatch = function getRunBatch(
  batchId: string,
  signal?: AbortSignal
): Promise<{ batch: RunBatch; reportUrl: string | null }> {
  return api(`/run-batches/${encodeURIComponent(batchId)}`, { signal });
};

export const updateProject = function updateProject(
  projectId: string,
  input: { name?: string; baseUrl?: string }
): Promise<{ project: Project }> {
  return api(`/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
};

export const editChatMessage = function editChatMessage(
  chatId: string,
  messageId: string,
  text: string
): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(
    `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
    { method: "PATCH", body: JSON.stringify({ text }) }
  );
};

export const retryChatMessage = function retryChatMessage(
  chatId: string,
  messageId: string
): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(
    `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/retry`,
    { method: "POST" }
  );
};

export const queueChatFollowUp = function queueChatFollowUp(
  chatId: string,
  text: string
): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(
    `/chats/${encodeURIComponent(chatId)}/follow-up`,
    {
      method: "POST",
      body: JSON.stringify({ text }),
    }
  );
};

export const abortChatTurn = function abortChatTurn(
  chatId: string
): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/chats/${encodeURIComponent(chatId)}/abort`, {
    method: "POST",
  });
};

export const deleteProject = function deleteProject(
  projectId: string
): Promise<void> {
  return api(`/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
  });
};

export const getProjectGitRemote = function getProjectGitRemote(
  projectId: string
): Promise<{ remote: GitRemoteAccess }> {
  return api(`/projects/${encodeURIComponent(projectId)}/git/remote`);
};

export const issueProjectGitRemoteToken = function issueProjectGitRemoteToken(
  projectId: string
): Promise<{ token: string; remote: GitRemoteAccess }> {
  return api(`/projects/${encodeURIComponent(projectId)}/git/remote/token`, {
    method: "POST",
  });
};

export const revokeProjectGitRemoteToken = function revokeProjectGitRemoteToken(
  projectId: string
): Promise<{ remote: GitRemoteAccess }> {
  return api(`/projects/${encodeURIComponent(projectId)}/git/remote/token`, {
    method: "DELETE",
  });
};

export const getSpecHistory = function getSpecHistory(specId: string): Promise<{
  entries: { sha: string; date: string; message: string }[];
}> {
  return api(`/specs/${encodeURIComponent(specId)}/history`);
};

export const getSpecAtCommit = function getSpecAtCommit(
  specId: string,
  sha: string
): Promise<{ yaml: string | null; testSource: string | null }> {
  return api(
    `/specs/${encodeURIComponent(specId)}/history/${encodeURIComponent(sha)}`
  );
};

export const testLlmConnection = function testLlmConnection(): Promise<{
  ok: true;
  message: string;
}> {
  return api("/settings/llm/test", { method: "POST" });
};

export const getLlmSettings =
  function getLlmSettings(): Promise<LlmSettingsResponse> {
    return api<LlmSettingsResponse>("/settings/llm");
  };

export const getLlmRuntimeStatus =
  function getLlmRuntimeStatus(): Promise<LlmRuntimeStatus> {
    return api<LlmRuntimeStatus>("/settings/llm/status");
  };

export const updateLlmSettings = function updateLlmSettings(
  update: Partial<LlmCurrentSettings>
): Promise<LlmCurrentSettings> {
  return api<LlmCurrentSettings>("/settings/llm", {
    method: "PATCH",
    body: JSON.stringify(update),
  });
};

export const saveLlmProviderApiKey = function saveLlmProviderApiKey(
  providerId: string,
  apiKey: string
): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(
    `/settings/llm/providers/${encodeURIComponent(providerId)}`,
    {
      method: "PUT",
      body: JSON.stringify({ apiKey }),
    }
  );
};

export const removeLlmProviderAuth = function removeLlmProviderAuth(
  providerId: string
): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(
    `/settings/llm/providers/${encodeURIComponent(providerId)}`,
    {
      method: "DELETE",
    }
  );
};

export const startLlmProviderOAuth = function startLlmProviderOAuth(
  providerId: string
): Promise<LlmOAuthStart> {
  return api<LlmOAuthStart>(
    `/settings/llm/providers/${encodeURIComponent(providerId)}/oauth/start`,
    {
      method: "POST",
    }
  );
};

export const pollLlmProviderOAuth = function pollLlmProviderOAuth(
  providerId: string,
  sessionId: string
): Promise<LlmOAuthPoll> {
  return api<LlmOAuthPoll>(
    `/settings/llm/providers/${encodeURIComponent(providerId)}/oauth/poll?sessionId=${encodeURIComponent(sessionId)}`
  );
};

export const submitLlmProviderOAuthInput = function submitLlmProviderOAuthInput(
  providerId: string,
  sessionId: string,
  input: string
): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(
    `/settings/llm/providers/${encodeURIComponent(providerId)}/oauth/input`,
    {
      method: "POST",
      body: JSON.stringify({ sessionId, input }),
    }
  );
};

export const updateSpecFiles = function updateSpecFiles(
  specId: string,
  input: { yaml?: string; testSource?: string }
): Promise<SpecDetail> {
  return api(`/specs/${encodeURIComponent(specId)}/files`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
};

export const updateSpec = function updateSpec(
  specId: string,
  input: { title?: string; description?: string; humanSpec?: HumanSpec }
): Promise<SpecDetail> {
  return api(`/specs/${encodeURIComponent(specId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
};

export const createManualSpec = function createManualSpec(
  projectId: string,
  featureId: string,
  title: string
): Promise<{ spec: { id: string } }> {
  return api(`/projects/${encodeURIComponent(projectId)}/specs`, {
    method: "POST",
    body: JSON.stringify({ featureId, title }),
  });
};

export const createFeature = function createFeature(
  projectId: string,
  input: { parentId?: string; title: string; description?: string }
): Promise<{ feature: Feature }> {
  return api(`/projects/${encodeURIComponent(projectId)}/features`, {
    method: "POST",
    body: JSON.stringify(input),
  });
};

export const updateFeature = function updateFeature(
  featureId: string,
  input: { title?: string; description?: string }
): Promise<{ feature: Feature }> {
  return api(`/features/${encodeURIComponent(featureId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
};

export const listCredentialProfiles = function listCredentialProfiles(
  projectId: string
): Promise<{ profiles: CredentialProfile[] }> {
  return api(`/projects/${encodeURIComponent(projectId)}/credentials`);
};

export const createCredentialProfile = function createCredentialProfile(
  projectId: string,
  input: {
    name: string;
    allowedOrigins?: string[];
    fields: CredentialFieldInput[];
  }
): Promise<{ profile: CredentialProfile }> {
  return api(`/projects/${encodeURIComponent(projectId)}/credentials`, {
    method: "POST",
    body: JSON.stringify(input),
  });
};

export const updateCredentialProfile = function updateCredentialProfile(
  profileId: string,
  input: { allowedOrigins?: string[]; fields: CredentialFieldInput[] }
): Promise<{ profile: CredentialProfile }> {
  return api(`/credentials/${encodeURIComponent(profileId)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
};

export const deleteCredentialProfile = function deleteCredentialProfile(
  profileId: string
): Promise<void> {
  return api(`/credentials/${encodeURIComponent(profileId)}`, {
    method: "DELETE",
  });
};

export const resolveChatCredentialRequest =
  function resolveChatCredentialRequest(
    chatId: string,
    requestId: string,
    body:
      | { action: "dismiss" }
      | { action: "submit"; values: Record<string, string> }
  ): Promise<{ ok: boolean }> {
    return api(
      `/chats/${encodeURIComponent(chatId)}/credential-requests/${encodeURIComponent(requestId)}`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    );
  };

export const getEnvironments = function getEnvironments(
  projectId: string,
  signal?: AbortSignal
): Promise<{ environments: ProjectEnvironment[] }> {
  return api(apiPath`/projects/${projectId}/environments`, { signal });
};

export const getProjectTunnels = function getProjectTunnels(
  projectId: string,
  signal?: AbortSignal
): Promise<{ tunnels: ProjectTunnel[] }> {
  return api(apiPath`/projects/${projectId}/tunnels`, { signal });
};

export const getOverview = function getOverview(
  projectId: string,
  signal?: AbortSignal
): Promise<OverviewResponse> {
  return api(apiPath`/projects/${projectId}/overview`, { signal });
};

export const getCoverage = function getCoverage(
  projectId: string,
  signal?: AbortSignal
): Promise<CoverageResponse> {
  return api(apiPath`/projects/${projectId}/coverage`, { signal });
};

export const requestTask = function requestTask(
  projectId: string,
  kind: "coverage" | "explore"
): Promise<{ intentId: string; status: "queued" | "running" | "paused" }> {
  return api(apiPath`/projects/${projectId}/tasks`, {
    method: "POST",
    body: JSON.stringify({ kind }),
  });
};

export const setStewardPaused = function setStewardPaused(
  projectId: string,
  paused: boolean
): Promise<unknown> {
  return api(apiPath`/projects/${projectId}/steward`, {
    method: "PUT",
    body: JSON.stringify({ paused }),
  });
};
