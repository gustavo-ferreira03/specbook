export type SpecStatus = "draft" | "unverified" | "passed" | "failed";
export type RunStatus = "running" | "passed" | "failed" | "error";

export interface Project {
    id: string;
    name: string;
    baseUrl: string;
    createdAt: string;
}

export interface Feature {
    id: string;
    projectId: string;
    parentId: string | null;
    title: string;
    description: string;
    createdAt: string;
}

export interface SpecSummary {
    id: string;
    featureId: string;
    title: string;
    status: SpecStatus;
}

export interface HumanSpec {
    preconditions: string[];
    steps: string[];
    expectedResult: string;
    postconditions: string[];
}

export interface Run {
    id: string;
    specId: string;
    specVersionId: string;
    status: RunStatus;
    startedAt: string;
    durationMs: number | null;
    failReason: string | null;
}

export interface SpecDetail {
    spec: {
        id: string;
        projectId: string;
        featureId: string;
        title: string;
        description: string;
        status: SpecStatus;
        createdAt: string;
        updatedAt: string;
    };
    feature: Feature | null;
    version: { id: string; version: number; humanSpec: HumanSpec } | null;
    runs: Run[];
}

export interface ChatMessage {
    id: string;
    conversationId: string;
    role: "user" | "agent";
    content: string;
    createdAt: string;
}

export interface Conversation {
    id: string;
    title: string;
    createdAt: string;
}

export interface ConversationState {
    title: string;
    messages: ChatMessage[];
    busy: boolean;
    vncSessionId: string | null;
    projectId: string;
}

export interface ArtifactListing {
    files: string[];
}

export interface RunEvidence {
    expectedResult: string;
    steps: { number: number; label: string; file: string }[];
    video: string | null;
    reportAvailable: boolean;
}

export type LlmAuthMethod = "oauth" | "api_key";

export interface LlmModel {
    id: string;
    label: string;
}

export interface LlmProvider {
    id: string;
    name: string;
    configured: boolean;
    authMethods: LlmAuthMethod[];
    models: LlmModel[];
}

export interface LlmCurrentSettings {
    provider: string;
    model: string;
}

export interface LlmSettingsResponse {
    providers: LlmProvider[];
    current: LlmCurrentSettings;
}

export interface LlmRuntimeStatus {
    ready: boolean;
    provider: string;
    model: string;
}

export interface LlmOAuthStart {
    sessionId: string;
    type: "browser" | "device_code";
}

export interface LlmOAuthPoll {
    status: "pending" | "done" | "error";
    url?: string;
    userCode?: string;
    verificationUri?: string;
    error?: string;
}
