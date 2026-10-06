import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export interface HumanSpec {
    preconditions: string[];
    steps: string[];
    expectedResult: string;
    postconditions: string[];
}

export type SpecStatus = "unverified" | "passed" | "failed" | "invalid";
export type SpecLifecycle = "draft" | "active";
export type RunStatus = "running" | "passed" | "failed" | "error";

export interface RunEnvironment {
    configuredBaseUrl: string;
    id: string;
    name: string;
    baseUrl: string;
    allowedOrigins: string[];
    credentialOverrides: Record<string, string>;
}

export interface LlmSettings {
    provider: string;
    model: string;
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

export const EMPTY_PROJECT_CONTEXT: ProjectContext = {
    summary: "",
    areas: [],
    terminology: [],
    roles: [],
    businessRules: [],
    uiPatterns: [],
    executionNotes: [],
    unknowns: [],
    sources: [],
};

export const projects = sqliteTable("projects", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    baseUrl: text("base_url").notNull(),
    contextSyncError: text("context_sync_error"),
    gitAccessTokenHash: text("git_access_token_hash"),
    gitAccessTokenPrefix: text("git_access_token_prefix"),
    gitAccessTokenCreatedAt: text("git_access_token_created_at"),
    gitAccessTokenLastUsedAt: text("git_access_token_last_used_at"),
    gitExternalSyncError: text("git_external_sync_error"),
    createdAt: text("created_at").notNull(),
});

export const environments = sqliteTable("environments", {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    baseUrl: text("base_url").notNull(),
    allowedOrigins: text("allowed_origins", { mode: "json" }).$type<string[]>().notNull().default([]),
    credentialOverrides: text("credential_overrides", { mode: "json" }).$type<Record<string, string>>().notNull().default({}),
}, (table) => [uniqueIndex("environments_project_name_idx").on(table.projectId, table.name)]);

export const features = sqliteTable(
    "features",
    {
        id: text("id").primaryKey(),
        projectId: text("project_id")
            .notNull()
            .references(() => projects.id),
        parentId: text("parent_id"),
        title: text("title").notNull(),
        description: text("description").notNull().default(""),
        path: text("path").notNull(),
        createdAt: text("created_at").notNull(),
    },
    (table) => [uniqueIndex("features_project_path_unique").on(table.projectId, table.path)],
);

export const specs = sqliteTable(
    "specs",
    {
        id: text("id").primaryKey(),
        projectId: text("project_id")
            .notNull()
            .references(() => projects.id),
        featureId: text("feature_id")
            .notNull()
            .references(() => features.id),
        title: text("title").notNull(),
        description: text("description").notNull().default(""),
    status: text("status").$type<SpecStatus>().notNull().default("unverified"),
    lifecycle: text("lifecycle").$type<SpecLifecycle>().notNull().default("active"),
        path: text("path").notNull(),
        sourceHash: text("source_hash").notNull(),
        markdownHash: text("markdown_hash").notNull().default(""),
        invalidReason: text("invalid_reason"),
        createdAt: text("created_at").notNull(),
        updatedAt: text("updated_at").notNull(),
    },
    // The unique (project_id, path) index also serves lookups by project_id alone.
    (table) => [uniqueIndex("specs_project_path_unique").on(table.projectId, table.path)],
);

export const chats = sqliteTable("chats", {
    id: text("id").primaryKey(),
    projectId: text("project_id")
        .notNull()
        .references(() => projects.id),
    contextRevisionId: text("context_revision_id"),
    createdAt: text("created_at").notNull(),
});

export const projectContextRevisions = sqliteTable("project_context_revisions", {
    id: text("id").primaryKey(),
    projectId: text("project_id")
        .notNull()
        .references(() => projects.id),
    sourceChatId: text("source_chat_id"),
    status: text("status").$type<ProjectContextStatus>().notNull(),
    brief: text("brief", { mode: "json" }).$type<DiscoveryBrief>().notNull(),
    context: text("context", { mode: "json" }).$type<ProjectContext>().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    confirmedAt: text("confirmed_at"),
});

export const runs = sqliteTable(
    "runs",
    {
        id: text("id").primaryKey(),
        specId: text("spec_id")
            .notNull()
            .references(() => specs.id),
        commitSha: text("commit_sha").notNull(),
        sourceHash: text("source_hash").notNull(),
        status: text("status").$type<RunStatus>().notNull(),
        startedAt: text("started_at").notNull(),
        durationMs: integer("duration_ms"),
        failReason: text("fail_reason"),
        automationPending: integer("automation_pending", { mode: "boolean" }).notNull().default(false),
        healOnFailure: integer("heal_on_failure", { mode: "boolean" }).notNull().default(true),
        retryOf: text("retry_of"),
        flaky: integer("flaky", { mode: "boolean" }).notNull().default(false),
    baseUrl: text("base_url"),
    environment: text("environment", { mode: "json" }).$type<RunEnvironment>(),
    },
    (table) => [index("runs_spec_started_idx").on(table.specId, table.startedAt), uniqueIndex("runs_retry_of_unique").on(table.retryOf)],
);

export interface CredentialField {
    key: string;
    value: string;
}

export const credentialProfiles = sqliteTable("credential_profiles", {
    id: text("id").primaryKey(),
    projectId: text("project_id")
        .notNull()
        .references(() => projects.id),
    name: text("name").notNull(),
    allowedOrigins: text("allowed_origins", { mode: "json" }).$type<string[]>().notNull(),
    fields: text("fields", { mode: "json" }).$type<CredentialField[]>().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
});

export const chatSessions = sqliteTable(
    "chat_sessions",
    {
        id: text("id").primaryKey(),
        projectId: text("project_id")
            .notNull()
            .references(() => projects.id),
        profileId: text("profile_id")
            .notNull()
            .references(() => credentialProfiles.id),
        state: text("state").notNull(),
        savedAt: text("saved_at").notNull(),
    },
    (table) => [uniqueIndex("chat_sessions_profile_unique").on(table.projectId, table.profileId)],
);

export const appSettings = sqliteTable("app_settings", {
    id: integer("id").primaryKey(),
    llm: text("llm", { mode: "json" }).$type<LlmSettings>().notNull(),
    agentPaused: integer("agent_paused", { mode: "boolean" }).notNull().default(false),
    sso: text("sso", { mode: "json" }).$type<import("../../core/accounts/schemas").SsoSettings>(),
    retention: text("retention", { mode: "json" }).$type<import("../../core/operations/schemas").RetentionSettings>(),
    retentionLastCleanup: text("retention_last_cleanup", { mode: "json" }).$type<import("../../core/operations/schemas").RetentionCleanup>(),
    security: text("security", { mode: "json" }).$type<import("../../core/chat/safety-settings").SecuritySettings>(),
    updatedAt: text("updated_at").notNull(),
});

export const users = sqliteTable("users", {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    passwordHash: text("password_hash"),
    role: text("role").$type<import("../../core/accounts/schemas").UserRole>().notNull(),
    disabledAt: text("disabled_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
});

export const userSessions = sqliteTable("user_sessions", {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
}, (table) => [index("user_sessions_user").on(table.userId), index("user_sessions_expiry").on(table.expiresAt)]);

export const userInvites = sqliteTable("user_invites", {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    email: text("email").notNull(),
    role: text("role").$type<import("../../core/accounts/schemas").UserRole>().notNull(),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    consumedAt: text("consumed_at"),
});

export const oidcIdentities = sqliteTable("oidc_identities", {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
}, (table) => [uniqueIndex("oidc_issuer_subject").on(table.issuer, table.subject), index("oidc_user").on(table.userId)]);

export const oidcStates = sqliteTable("oidc_states", {
    stateHash: text("state_hash").primaryKey(),
    browserHash: text("browser_hash").notNull(),
    pkceVerifier: text("pkce_verifier").notNull(),
    nonce: text("nonce").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    issuer: text("issuer").notNull(),
    clientId: text("client_id").notNull(),
    linkUserId: text("link_user_id").references(() => users.id, { onDelete: "cascade" }),
    expiresAt: text("expires_at").notNull(),
});

export const auditEvents = sqliteTable("audit_events", {
    id: text("id").primaryKey(),
    actorId: text("actor_id"),
    actorName: text("actor_name").notNull(),
    actorKind: text("actor_kind").$type<"user" | "agent" | "ci" | "git" | "system">().notNull(),
    action: text("action").notNull(),
    projectId: text("project_id"),
    details: text("details", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    createdAt: text("created_at").notNull(),
}, (table) => [index("audit_created").on(table.createdAt, table.id), index("audit_project").on(table.projectId)]);

export const jobs = sqliteTable("jobs", {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    chatId: text("chat_id").notNull().unique(),
    trigger: text("trigger").notNull(),
    kind: text("kind").notNull().default("review"),
    specId: text("spec_id"),
    runId: text("run_id").unique(),
    classification: text("classification").$type<"test_drift" | "application_bug" | "environment">(),
    goal: text("goal").notNull(),
    status: text("status").$type<import("../../core/jobs/schemas").JobStatus>().notNull(),
    limits: text("limits", { mode: "json" }).$type<import("../../core/jobs/schemas").JobLimits>().notNull(),
    tokensUsed: integer("tokens_used").notNull().default(0),
    actionsUsed: integer("actions_used").notNull().default(0),
    elapsedMs: integer("elapsed_ms").notNull().default(0),
    stopReason: text("stop_reason"),
    safetyRetries: integer("safety_retries").notNull().default(0),
    retryAt: text("retry_at"),
    systemError: text("system_error"),
    infrastructureRetries: integer("infrastructure_retries").notNull().default(0),
    startedAt: text("started_at"),
    heartbeatAt: text("heartbeat_at"),
    pendingMessage: text("pending_message").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
}, (table) => [index("jobs_project_status").on(table.projectId, table.status)]);

export const inboxItems = sqliteTable("inbox_items", {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    jobId: text("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    kind: text("kind").$type<import("../../core/jobs/schemas").InboxKind>().notNull(),
    status: text("status").$type<"pending" | "applying" | "approved" | "rejected" | "answered" | "dismissed">().notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    answer: text("answer"),
    commitSha: text("commit_sha"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
}, (table) => [index("inbox_project_status").on(table.projectId, table.status)]);

export const jobActions = sqliteTable("job_actions", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: text("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    detail: text("detail").notNull(),
    createdAt: text("created_at").notNull(),
}, (table) => [index("job_actions_job").on(table.jobId)]);

export const projectAutomations = sqliteTable("project_automations", {
    projectId: text("project_id").primaryKey().references(() => projects.id, { onDelete: "cascade" }),
    cron: text("cron"),
    specIds: text("spec_ids", { mode: "json" }).$type<string[]>().notNull().default([]),
    healFailures: integer("heal_failures", { mode: "boolean" }).notNull().default(true),
    webhookUrl: text("webhook_url"),
    allowPrivateWebhook: integer("allow_private_webhook", { mode: "boolean" }).notNull().default(false),
    nextRunAt: text("next_run_at"),
    lastBatchId: text("last_batch_id"),
    lastBatchStatus: text("last_batch_status").$type<RunStatus>(),
    lastError: text("last_error"),
    updatedAt: text("updated_at").notNull(),
});

export const webhookNotifications = sqliteTable("webhook_notifications", {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    batchId: text("batch_id").notNull(),
    status: text("status").$type<RunStatus>().notNull(),
    webhookUrl: text("webhook_url").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: text("next_attempt_at"),
    deliveredAt: text("delivered_at"),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("webhook_batch_status_unique").on(table.batchId, table.status), index("webhook_retry_idx").on(table.nextAttemptAt)]);

export const projectStewards = sqliteTable("project_stewards", {
    projectId: text("project_id").primaryKey().references(() => projects.id, { onDelete: "cascade" }),
    autonomy: text("autonomy").$type<"observe" | "propose" | "act">().notNull().default("propose"),
    autoApproveFixes: integer("auto_approve_fixes", { mode: "boolean" }).notNull().default(false),
    paused: integer("paused", { mode: "boolean" }).notNull().default(false),
    observation: text("observation", { mode: "json" }).$type<import("../../core/steward/signals").ProjectObservation>().notNull().default({}),
    updatedAt: text("updated_at").notNull(),
});

export const projectSignals = sqliteTable("project_signals", {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").$type<"pending" | "handled" | "observed">().notNull().default("pending"),
    createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("project_signal_key").on(table.projectId, table.key)]);

export const stewardIntents = sqliteTable("steward_intents", {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    source: text("source").$type<"user" | "event">().notNull().default("event"),
    intent: text("intent", { mode: "json" }).$type<import("../../core/steward/schemas").StewardIntent>().notNull(),
    priority: integer("priority").notNull(),
    status: text("status").$type<"pending" | "running" | "completed" | "ignored" | "failed">().notNull().default("pending"),
    reason: text("reason").notNull(),
    jobId: text("job_id"),
    batchId: text("batch_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("steward_intent_key").on(table.projectId, table.key)]);

export const projectCiTokens = sqliteTable("project_ci_tokens", {
    projectId: text("project_id").primaryKey().references(() => projects.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash"),
    tokenPrefix: text("token_prefix"),
    createdAt: text("created_at"),
    lastUsedAt: text("last_used_at"),
    requestWindowStartedAt: text("request_window_started_at"),
    requestCount: integer("request_count").notNull().default(0),
});
