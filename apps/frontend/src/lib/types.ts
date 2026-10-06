export type SpecStatus = "unverified" | "passed" | "failed" | "invalid";
export type RunStatus = "running" | "passed" | "failed" | "error";

export interface Project {
    id: string;
    name: string;
    baseUrl: string;
    createdAt: string;
}

export interface GitAccessTokenInfo {
    hasToken: boolean;
    prefix: string | null;
    createdAt: string | null;
    lastUsedAt: string | null;
}

export interface GitRemoteAccess {
    cloneUrl: string;
    branch: string;
    headSha: string | null;
    token: GitAccessTokenInfo;
    externalSyncError: string | null;
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
    /** Most recent run, or null when the Spec was never run. */
    lastRun: Run | null;
}

/** Response of GET /projects/:id/tree, shared by the Sidebar and the Specs screens. */
export interface ProjectTree {
    features: Feature[];
    specs: SpecSummary[];
    syncError: string | null;
}

export interface HumanSpec {
    preconditions: string[];
    steps: string[];
    expectedResult: string;
    postconditions: string[];
}

export interface Run {
    id: string;
    retryOf: string | null;
    flaky: boolean;
    automationPending: boolean;
    specId: string;
    commitSha: string;
    sourceHash: string;
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
        sourceHash: string;
        markdownHash: string;
        invalidReason: string | null;
        createdAt: string;
        updatedAt: string;
    };
    feature: Feature | null;
    content: {
        humanSpec: HumanSpec | null;
        testSource: string;
        yamlSource: string;
    } | null;
    runs: Run[];
}

export interface ChatMessage {
    id: string;
    chatId: string;
    role: "user" | "agent";
    content: string;
    createdAt: string;
    canRetry?: boolean;
}

export type ChatMode = "standard" | "discovery";
export type ProjectContextStatus = "draft" | "confirmed" | "discarded";

export interface DiscoveryBrief {
    goal: string;
    startUrl: string;
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
    hasProposal: boolean;
}

export interface Chat {
    id: string;
    title: string;
    createdAt: string;
}

export interface ChatCredentialRequest {
    id: string;
    profileName: string;
    fields: { key: string; label?: string }[];
}

export interface ChatState {
    title: string;
    messages: ChatMessage[];
    busy: boolean;
    queue: { steering: number; followUp: number };
    vncSessionId: string | null;
    projectId: string;
    mode: ChatMode;
    contextRevision: ChatContextRevision | null;
    credentialRequest: ChatCredentialRequest | null;
}

export interface ArtifactListing {
    files: string[];
}

export interface RunEvidence {
    expectedResult: string;
    steps: { number: number; label: string; file: string }[];
    video: string | null;
    /** Title of the step() that failed, when the run failed inside one. */
    failedStep: string | null;
    diagnostics?: { kind: "console" | "pageerror" | "requestfailed" | "response"; message: string; url?: string; method?: string; status?: number }[];
    errorContext?: string;
    reportAvailable: boolean;
    reportUrl: string | null;
}

export interface RunBatchItem {
    runId: string;
    specId: string;
    commitSha: string;
    sourceHash: string;
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
}

export type LlmOAuthPrompt =
    | { type: "select"; message: string; options: { id: string; label: string; description?: string }[] }
    | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string };

export interface LlmOAuthPoll {
    status: "pending" | "done" | "error";
    url?: string;
    userCode?: string;
    verificationUri?: string;
    prompt?: LlmOAuthPrompt;
    error?: string;
}

export interface CredentialFieldPublic {
    key: string;
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
    value?: string;
}

export interface Job {
    id: string;
    projectId: string;
    chatId: string;
    trigger: string;
    goal: string;
    status: "queued" | "running" | "blocked" | "completed" | "budget_exceeded" | "cancelled";
    budget: { maxTokens: number; wallTimeMs: number; maxActions: number };
    tokensUsed: number;
    actionsUsed: number;
    elapsedMs: number;
    createdAt: string;
}
export interface JobAction { id: number; action: string; detail: string; createdAt: string }
export interface InboxItem {
    id: string;
    jobId: string;
    kind: "new_spec" | "spec_fix" | "feature" | "question" | "bug_report" | "note";
    status: "pending" | "applying" | "approved" | "rejected" | "answered" | "dismissed";
    title: string;
    body: string;
    payload: { before?: { yaml?: string; testSource?: string }; params?: Record<string, unknown>; requiresVerification?: boolean; verification?: { status: string; failReason: string | null; durationMs: number | null; screenshots: string[] } };
    answer: string | null;
    commitSha: string | null;
    createdAt: string;
}
