import { readFileSync } from "node:fs";
import type { ProjectContextRevisionRow } from "../../infra/repositories/project-contexts";
import type { Project } from "../../infra/repositories/projects";
import { projectContextJsonSchema } from "./context-tools";

const promptsDir = new URL("./prompts/", import.meta.url);

function loadPrompt(name: string): string {
    return readFileSync(new URL(name, promptsDir), "utf8").trimEnd();
}

export function fillTemplate(template: string, values: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
        if (!(key in values)) throw new Error(`Missing template value: ${key}`);
        return values[key];
    });
}

const PROJECT_CONTEXT_SCHEMA_TEXT = JSON.stringify(projectContextJsonSchema, null, 2);
const STANDARD_SYSTEM_PROMPT_TEMPLATE = loadPrompt("standard-system-prompt.txt");
const DISCOVERY_SYSTEM_PROMPT_TEMPLATE = loadPrompt("discovery-system-prompt.txt");
const CREDENTIAL_RULES = loadPrompt("credential-rules.txt");

function standardSystemPrompt(
    project: Project,
    confirmedContext: ProjectContextRevisionRow | null,
): string {
    const base = fillTemplate(STANDARD_SYSTEM_PROMPT_TEMPLATE, {
        baseUrl: project.baseUrl,
        credentialRules: CREDENTIAL_RULES,
    });
    if (confirmedContext) {
        return [
            base,
            "",
            `The following project context is confirmed (revision ${confirmedContext.id}, confirmed at ${confirmedContext.confirmedAt}). Treat it as background knowledge about the application.`,
            "<confirmed-project-context>",
            JSON.stringify(confirmedContext.context, null, 2),
            "</confirmed-project-context>",
        ].join("\n");
    }
    return [base, "", "No confirmed project context exists for this project yet."].join("\n");
}

function discoverySystemPrompt(project: Project, revision: ProjectContextRevisionRow): string {
    const { brief } = revision;
    const safetyNotes = brief.safetyNotes.length
        ? brief.safetyNotes.map((note) => `- ${note}`).join("\n")
        : "- (none provided)";
    return fillTemplate(DISCOVERY_SYSTEM_PROMPT_TEMPLATE, {
        projectName: project.name,
        origin: new URL(project.baseUrl).origin,
        startUrl: brief.startUrl,
        goal: brief.goal,
        safetyNotes,
        schema: PROJECT_CONTEXT_SCHEMA_TEXT,
        credentialRules: CREDENTIAL_RULES,
    });
}

export function buildSystemPrompt(
    project: Project,
    discoveryRevision: ProjectContextRevisionRow | null,
    confirmedContext: ProjectContextRevisionRow | null,
): string {
    return discoveryRevision
        ? discoverySystemPrompt(project, discoveryRevision)
        : standardSystemPrompt(project, confirmedContext);
}
