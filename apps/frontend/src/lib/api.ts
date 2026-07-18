import type {
    Feature,
    GitStatus,
    GitSyncOutcome,
    LlmCurrentSettings,
    LlmOAuthPoll,
    LlmOAuthStart,
    LlmRuntimeStatus,
    LlmSettingsResponse,
    ProjectContext,
    ProjectContextRevision,
    ProjectContextState,
    RunBatch,
    SpecDetail,
} from "./types";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
export const WS_URL = API_URL.replace(/^http/, "ws");

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");

    const response = await fetch(`${API_URL}${path}`, { ...init, headers });
    if (!response.ok) {
        const text = await response.text();
        let message = text;
        try {
            const body = JSON.parse(text) as { error?: string; message?: string };
            message = body.error ?? body.message ?? text;
        } catch {}
        throw new Error(message || `Request failed with status ${response.status}`);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
}

export interface DiscoveryBriefInput {
    goal?: string;
    startUrl?: string;
    maxActions?: number;
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
    patch: { context?: ProjectContext; maxActions?: number },
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

export function startRunBatch(projectId: string, specIds: string[], label: string): Promise<{ batch: RunBatch }> {
    return api(`/projects/${encodeURIComponent(projectId)}/run-batches`, {
        method: "POST",
        body: JSON.stringify({ specIds, label }),
    });
}

export function getRunBatch(batchId: string): Promise<{ batch: RunBatch; reportUrl: string | null }> {
    return api(`/run-batches/${encodeURIComponent(batchId)}`);
}

export function getProjectGit(projectId: string): Promise<{ git: GitStatus }> {
    return api(`/projects/${encodeURIComponent(projectId)}/git`);
}

export function connectProjectGit(
    projectId: string,
    remoteUrl: string,
    token?: string | null,
): Promise<{ git: GitStatus }> {
    return api(`/projects/${encodeURIComponent(projectId)}/git`, {
        method: "PUT",
        body: JSON.stringify({ remoteUrl, token }),
    });
}

export function disconnectProjectGit(projectId: string): Promise<void> {
    return api(`/projects/${encodeURIComponent(projectId)}/git`, { method: "DELETE" });
}

export function syncProjectGit(projectId: string): Promise<{ outcome: GitSyncOutcome }> {
    return api(`/projects/${encodeURIComponent(projectId)}/git/sync`, { method: "POST" });
}

export function resolveProjectGit(
    projectId: string,
    choices: { path: string; keep: "local" | "remote" }[],
): Promise<{ outcome: GitSyncOutcome }> {
    return api(`/projects/${encodeURIComponent(projectId)}/git/resolve`, {
        method: "POST",
        body: JSON.stringify({ choices }),
    });
}

export function getSpecHistory(specId: string): Promise<{
    entries: { sha: string; date: string; message: string }[];
}> {
    return api(`/specs/${encodeURIComponent(specId)}/history`);
}

export function getSpecAtCommit(
    specId: string,
    sha: string,
): Promise<{ markdown: string | null; robot: string | null }> {
    return api(`/specs/${encodeURIComponent(specId)}/history/${encodeURIComponent(sha)}`);
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

export function submitLlmProviderOAuthManual(providerId: string, sessionId: string, input: string): Promise<{ ok: boolean }> {
    return api<{ ok: boolean }>(`/settings/llm/providers/${encodeURIComponent(providerId)}/oauth/manual`, {
        method: "POST",
        body: JSON.stringify({ sessionId, input }),
    });
}

export function updateSpecFiles(specId: string, input: { yaml?: string; robot?: string }): Promise<SpecDetail> {
    return api(`/specs/${encodeURIComponent(specId)}/files`, {
        method: "PUT",
        body: JSON.stringify(input),
    });
}

export function moveSpecToFeature(specId: string, featureId: string): Promise<SpecDetail> {
    return api(`/specs/${encodeURIComponent(specId)}/move`, {
        method: "POST",
        body: JSON.stringify({ featureId }),
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

export function getFeatureFile(featureId: string): Promise<{ feature: Feature; yaml: string | null }> {
    return api(`/features/${encodeURIComponent(featureId)}/file`);
}

export function updateFeatureFile(featureId: string, yaml: string): Promise<{ feature: Feature }> {
    return api(`/features/${encodeURIComponent(featureId)}/file`, {
        method: "PUT",
        body: JSON.stringify({ yaml }),
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
