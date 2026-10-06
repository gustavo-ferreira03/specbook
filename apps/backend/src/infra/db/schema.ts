import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export interface HumanSpec {
    preconditions: string[];
    steps: string[];
    expectedResult: string;
    postconditions: string[];
}

export type SpecStatus = "unverified" | "passed" | "failed" | "invalid" | "conflict";
export type RunStatus = "running" | "passed" | "failed" | "error";

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
    gitRemoteUrl: text("git_remote_url"),
    gitToken: text("git_token"),
    gitPushError: text("git_push_error"),
    gitConflictPaths: text("git_conflict_paths", { mode: "json" }).$type<string[] | null>(),
    contextSyncError: text("context_sync_error"),
    gitAccessTokenHash: text("git_access_token_hash"),
    gitAccessTokenPrefix: text("git_access_token_prefix"),
    gitAccessTokenCreatedAt: text("git_access_token_created_at"),
    gitAccessTokenLastUsedAt: text("git_access_token_last_used_at"),
    gitExternalSyncError: text("git_external_sync_error"),
    createdAt: text("created_at").notNull(),
});

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
    },
    (table) => [index("runs_spec_started_idx").on(table.specId, table.startedAt)],
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
    updatedAt: text("updated_at").notNull(),
});
