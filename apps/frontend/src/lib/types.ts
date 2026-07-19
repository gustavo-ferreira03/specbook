export type SpecStatus = "unverified" | "passed" | "failed" | "invalid" | "conflict";
export type RunStatus = "running" | "passed" | "failed" | "error";

export interface Project {
    id: string;
    name: string;
    baseUrl: string;
    createdAt: string;
}

export interface GitStatus {
    remoteUrl: string | null;
    hasToken: boolean;
    pushError: string | null;
    conflictPaths: string[] | null;
    contextSyncError: string | null;
}

export interface GitSyncOutcome {
    status: "no-remote" | "clean" | "updated" | "conflict";
    conflictedPaths: string[];
}

export interface Feature {
    id: string;
    projectId: string;
    parentId: string | null;
    title: string;
    description: string;
    path: string;
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
    commitSha: string;
    robotHash: string;
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
        path: string;
        robotHash: string;
        markdownHash: string;
        invalidReason: string | null;
        createdAt: string;
        updatedAt: string;
    };
    feature: Feature | null;
    content: { humanSpec: HumanSpec | null; robotSource: string; yamlSource: string } | null;
    runs: Run[];
}

export interface ChatMessage {
    id: string;
    chatId: string;
    role: "user" | "agent";
    content: string;
    createdAt: string;
}

export type ChatMode = "standard" | "discovery";
export type ProjectContextStatus = "draft" | "confirmed" | "discarded";

export interface DiscoveryBrief {
    goal: string;
    startUrl: string;
    maxActions: number;
    safetyNotes: string[];
}

export interface ProjectContext {
    summary: string;
    areas: { name: string; routes: string[]; description: string }[];
    terminology: { term: string; meaning: string }[];
    roles: { name: string; capabilities: string[] }[];
    businessRules: string[];
    uiPatterns: string[];
    executionNotes: string[];
    unknowns: string[];
    sources: { url: string; note: string }[];
}

export interface ProjectContextRevision {
    id: string;
    projectId: string;
    sourceChatId: string | null;
    status: ProjectContextStatus;
    brief: DiscoveryBrief;
    context: ProjectContext;
    actionsUsed: number;
    createdAt: string;
    updatedAt: string;
    confirmedAt: string | null;
}

export interface ProjectContextState {
    confirmed: ProjectContextRevision | null;
    draft: ProjectContextRevision | null;
}

export interface ChatContextRevision {
    id: string;
    status: ProjectContextStatus;
    brief: DiscoveryBrief;
    actionsUsed: number;
    hasProposal: boolean;
}

export interface Chat {
    id: string;
    title: string;
    createdAt: string;
}

export interface ChatState {
    title: string;
    messages: ChatMessage[];
    busy: boolean;
    vncSessionId: string | null;
    projectId: string;
    mode: ChatMode;
    contextRevision: ChatContextRevision | null;
}

export interface ArtifactListing {
    files: string[];
}

export interface RunEvidence {
    expectedResult: string;
    steps: { number: number; label: string; file: string }[];
    video: string | null;
    reportAvailable: boolean;
    reportUrl: string | null;
}

export interface RunBatchItem {
    runId: string;
    specId: string;
    commitSha: string;
    robotHash: string;
    markdownHash: string;
    title: string;
    status: RunStatus;
    durationMs: number | null;
    failReason: string | null;
}

export interface RunBatch {
    id: string;
    projectId: string;
    label: string;
    status: RunStatus;
    startedAt: string;
    durationMs: number | null;
    failReason: string | null;
    specs: RunBatchItem[];
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

export interface CredentialFieldPublic {
    key: string;
    secret: boolean;
    value?: string;
    hasValue: boolean;
}

export interface CredentialProfile {
    id: string;
    name: string;
    allowedOrigins: string[];
    fields: CredentialFieldPublic[];
    createdAt: string;
}

export interface CredentialFieldInput {
    key: string;
    secret: boolean;
    value?: string;
}
