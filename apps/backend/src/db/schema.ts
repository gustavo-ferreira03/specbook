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

export const conversations = sqliteTable("conversations", {
    id: text("id").primaryKey(),
    projectId: text("project_id")
        .notNull()
        .references(() => projects.id),
    createdAt: text("created_at").notNull(),
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
