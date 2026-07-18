import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export interface HumanSpec {
    preconditions: string[];
    steps: string[];
    expectedResult: string;
    postconditions: string[];
}

export type SpecStatus = "draft" | "unverified" | "passed" | "failed";
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
    createdAt: text("created_at").notNull(),
});

export const features = sqliteTable("features", {
    id: text("id").primaryKey(),
    projectId: text("project_id")
        .notNull()
        .references(() => projects.id),
    parentId: text("parent_id"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    createdAt: text("created_at").notNull(),
});

export const specs = sqliteTable("specs", {
    id: text("id").primaryKey(),
    projectId: text("project_id")
        .notNull()
        .references(() => projects.id),
    featureId: text("feature_id")
        .notNull()
        .references(() => features.id),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").$type<SpecStatus>().notNull().default("draft"),
    currentVersionId: text("current_version_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
});

export const specVersions = sqliteTable("spec_versions", {
    id: text("id").primaryKey(),
    specId: text("spec_id")
        .notNull()
        .references(() => specs.id),
    version: integer("version").notNull(),
    humanSpec: text("human_spec", { mode: "json" }).$type<HumanSpec>().notNull(),
    executablePath: text("executable_path").notNull(),
    executableHash: text("executable_hash").notNull(),
    createdAt: text("created_at").notNull(),
});

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
    actionsUsed: integer("actions_used").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    confirmedAt: text("confirmed_at"),
});

export const runs = sqliteTable("runs", {
    id: text("id").primaryKey(),
    specId: text("spec_id")
        .notNull()
        .references(() => specs.id),
    specVersionId: text("spec_version_id")
        .notNull()
        .references(() => specVersions.id),
    status: text("status").$type<RunStatus>().notNull(),
    startedAt: text("started_at").notNull(),
    durationMs: integer("duration_ms"),
    failReason: text("fail_reason"),
});

export const appSettings = sqliteTable("app_settings", {
    id: integer("id").primaryKey(),
    llm: text("llm", { mode: "json" }).$type<LlmSettings>().notNull(),
    updatedAt: text("updated_at").notNull(),
});
