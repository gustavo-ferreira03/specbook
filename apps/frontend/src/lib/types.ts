export type SpecStatus = "unverified" | "passed" | "failed" | "invalid";
export type RunStatus = "running" | "passed" | "failed" | "error";

export interface Project {
    id: string;
    name: string;
    baseUrl: string;
    createdAt: string;
}

export interface ProjectEnvironment {
    id: string;
    projectId: string;
    name: string;
    baseUrl: string;
    allowedOrigins: string[];
    credentialOverrides: Record<string, string>;
}

export interface SpecCandidate {
    id: string;
    title: string;
    goal: string;
    feature: string;
    featureId?: string;
    why: string;
    selected?: boolean;
    jobId?: string;
    specId?: string;
    runId?: string;
    questionId?: string;
    error?: string;
    state: "proposed" | "queued" | "generating" | "needs_answer" | "passed" | "failed" | "stopped";
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
    lastRun: Run | null;
}

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
    baseUrl?: string | null;
    environment?: ProjectEnvironment | null;
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

export interface ChatToolStep {
    id: string;
    toolName: string;
    afterMessageId: string | null;
    startedAt: number;
    endedAt: number | null;
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
    toolSteps: ChatToolStep[];
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
    environment?: ProjectEnvironment | null;
    apiSteps?: { number: number; label: string; requests: { method: string; url: string; status: number | null; requestHeaders: Record<string, string>; requestBody?: string; responseHeaders?: Record<string, string>; responseBody?: string; error?: string }[] }[];
    expectedResult: string;
    steps: { number: number; label: string; file: string }[];
    video: string | null;
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
    environment?: ProjectEnvironment;
    baseUrl?: string;
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

export interface InboxItem {
    id: string;
    jobId: string;
    kind: "spec_batch" | "new_spec" | "spec_fix" | "feature" | "question" | "bug_report" | "note";
    status: "pending" | "applying" | "approved" | "rejected" | "answered" | "dismissed";
    title: string;
    body: string;
    payload: { specBatch?: { sourceChatId: string; contextRevisionId?: string; contextStatus?: ProjectContextStatus; contextReviewRequired?: boolean; candidates: SpecCandidate[] }; files?: { path: string; before: string | null; after: string }[]; regressionIntentId?: string; checkTitles?: string[]; specId?: string; runId?: string; before?: { yaml?: string; testSource?: string }; params?: Record<string, unknown> & { humanSpec?: HumanSpec; description?: string }; requiresVerification?: boolean; verification?: { status: string; failReason: string | null; durationMs: number | null; screenshots: string[] } };
    answer: string | null;
    commitSha: string | null;
    createdAt: string;
}

export interface AgentSummary {
    projectName: string;
    attentionCount: number;
    lastCheckedAt: string | null;
    paused: boolean;
    globallyPaused: boolean;
    systemHealth?: { message: string };
}

export interface PresentedInboxItem extends InboxItem {
    presentation: {
        type: "batch" | "update" | "new_check" | "feature" | "bug" | "question" | "help";
        title: string;
        summary: string;
        workDone: string;
        consequence: string;
        screenshots: { before?: { url: string; label: string }; after?: { url: string; label: string } };
        credentialRequest: boolean;
        specId?: string;
        chatId?: string;
        activityId: string;
    };
}

export interface ActivityStory {
    id: string;
    subject: { type: "spec" | "feature" | "deployment" | "project"; id?: string; name: string };
    title: string;
    summary: string;
    status: "working" | "queued" | "waiting" | "needs_attention" | "paused" | "completed" | "observing" | "stopped";
    outcome?: "passed" | "failed" | "flaky" | "reviewed" | "stopped";
    nextStep: string;
    updatedAt: string;
    createdAt: string;
    timeline: { id: string; label: string; detail: string; createdAt: string; specId?: string; runId?: string }[];
    jobIds: string[];
    specId?: string;
    runId?: string;
    inboxIds: string[];
}

export interface SpecHealth {
    status: "passing" | "failing" | "flaky" | "not_checked" | "running" | "repairing" | "invalid";
    label: string;
    runId?: string;
    lastCheckedAt: string | null;
}

export interface FailingSpec {
    specId: string;
    title: string;
    triageStatus: string;
    runId?: string;
    updatedAt: string;
    storyId?: string;
    inboxIds: string[];
}

export interface RecentRun extends ActivityStory {
    environment?: ProjectEnvironment;
    trigger: "deploy" | "ci" | "schedule" | "manual" | "spec_change";
    occurrences: number;
    counts: { total: number; passed: number; failed: number; flaky: number; running: number };
}

export interface OverviewResponse {
    summary: AgentSummary & {
        verdict: string;
        nextCheck: string;
        nextCheckAt: string | null;
        specHealth: { total: number; passing: number; failing: number; flaky: number; not_checked: number; running: number; repairing: number; invalid: number };
    };
    specHealth: Record<string, SpecHealth>;
    needsYou: PresentedInboxItem[];
    failing: FailingSpec[];
    recentRuns: RecentRun[];
    items: PresentedInboxItem[];
    stories: ActivityStory[];
}

export interface CoverageArea {
    name: string;
    routes: string[];
    coverage: "covered" | "partial" | "uncovered";
    reason: string;
    featureId: string | null;
    specs: { id: string; title: string }[];
    uncoveredRoutes: string[];
}

export interface CoverageResponse {
    confirmed: boolean;
    basis: string;
    areas: CoverageArea[];
}

export interface SetupStatus {
    needsAdmin: boolean;
    authenticated?: boolean;
    modelReady?: boolean;
    needsProject?: boolean;
    completed?: boolean;
}

export interface SystemReadiness {
    ok: boolean;
    checkedAt: string;
    checks: { id: string; label: string; ok: boolean; message: string; nextStep?: string }[];
}

export interface AuthUser {
    id: string;
    name: string;
    email: string;
    role: "admin" | "editor" | "viewer";
}
