import { parse, stringify } from "yaml";
import { EMPTY_PROJECT_CONTEXT, type HumanSpec, type ProjectContext } from "../../infra/db/schema";

export class YamlParseError extends Error {}

export interface SpecYaml {
    id: string | null;
    title: string | null;
    description: string;
    humanSpec: HumanSpec;
}

export interface FeatureYaml {
    id: string | null;
    title: string | null;
    description: string;
}

function parseDocument(source: string): Record<string, unknown> {
    let data: unknown;
    try {
        data = parse(source);
    } catch (error) {
        throw new YamlParseError(`Invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (data === null || data === undefined) return {};
    if (typeof data !== "object" || Array.isArray(data)) {
        throw new YamlParseError("Invalid YAML: the document must be a mapping of keys to values");
    }
    return data as Record<string, unknown>;
}

function rejectUnknownKeys(data: Record<string, unknown>, allowed: string[], label: string): void {
    for (const key of Object.keys(data)) {
        if (!allowed.includes(key)) {
            throw new YamlParseError(`Unknown key "${key}" in ${label} (allowed: ${allowed.join(", ")})`);
        }
    }
}

function optionalString(data: Record<string, unknown>, key: string): string | null {
    const value = data[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") throw new YamlParseError(`"${key}" must be a string`);
    return value.trim() || null;
}

function stringWithDefault(data: Record<string, unknown>, key: string): string {
    const value = data[key];
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    throw new YamlParseError(`"${key}" must be a string`);
}

function stringArray(data: Record<string, unknown>, key: string): string[] {
    const value = data[key];
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new YamlParseError(`"${key}" must be a list`);
    return value.map((item, index) => {
        if (typeof item === "string") return item.trim();
        if (typeof item === "number" || typeof item === "boolean") return String(item);
        throw new YamlParseError(`"${key}[${index}]" must be a string`);
    });
}

function recordArray(data: Record<string, unknown>, key: string): Record<string, unknown>[] {
    const value = data[key];
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new YamlParseError(`"${key}" must be a list`);
    return value.map((item, index) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw new YamlParseError(`"${key}[${index}]" must be a mapping`);
        }
        return item as Record<string, unknown>;
    });
}

const SPEC_KEYS = ["id", "title", "description", "preconditions", "steps", "expectedResult", "postconditions"];

export function serializeSpecYaml(doc: {
    id: string;
    title: string;
    description: string;
    humanSpec: HumanSpec;
}): string {
    return stringify({
        id: doc.id,
        title: doc.title,
        description: doc.description,
        preconditions: doc.humanSpec.preconditions,
        steps: doc.humanSpec.steps,
        expectedResult: doc.humanSpec.expectedResult,
        postconditions: doc.humanSpec.postconditions,
    });
}

export function parseSpecYaml(source: string): SpecYaml {
    const data = parseDocument(source);
    rejectUnknownKeys(data, SPEC_KEYS, "spec.yml");
    return {
        id: optionalString(data, "id"),
        title: optionalString(data, "title"),
        description: stringWithDefault(data, "description"),
        humanSpec: {
            preconditions: stringArray(data, "preconditions"),
            steps: stringArray(data, "steps"),
            expectedResult: stringWithDefault(data, "expectedResult"),
            postconditions: stringArray(data, "postconditions"),
        },
    };
}

const FEATURE_KEYS = ["id", "title", "description"];

export function serializeFeatureYaml(doc: { id: string; title: string; description: string }): string {
    return stringify({ id: doc.id, title: doc.title, description: doc.description });
}

export function parseFeatureYaml(source: string): FeatureYaml {
    const data = parseDocument(source);
    rejectUnknownKeys(data, FEATURE_KEYS, "feature.yml");
    return {
        id: optionalString(data, "id"),
        title: optionalString(data, "title"),
        description: stringWithDefault(data, "description"),
    };
}

const CONTEXT_KEYS = [
    "summary",
    "areas",
    "terminology",
    "roles",
    "businessRules",
    "uiPatterns",
    "executionNotes",
    "unknowns",
    "sources",
];

export function serializeContextYaml(context: ProjectContext): string {
    return stringify({
        summary: context.summary,
        areas: context.areas,
        terminology: context.terminology,
        roles: context.roles,
        businessRules: context.businessRules,
        uiPatterns: context.uiPatterns,
        executionNotes: context.executionNotes,
        unknowns: context.unknowns,
        sources: context.sources,
    });
}

export function parseContextYaml(source: string): ProjectContext {
    const data = parseDocument(source);
    rejectUnknownKeys(data, CONTEXT_KEYS, "context.yml");
    const areas = recordArray(data, "areas").map((area, index) => {
        rejectUnknownKeys(area, ["name", "routes", "description"], `areas[${index}]`);
        return {
            name: stringWithDefault(area, "name"),
            routes: stringArray(area, "routes"),
            description: stringWithDefault(area, "description"),
        };
    });
    const terminology = recordArray(data, "terminology").map((entry, index) => {
        rejectUnknownKeys(entry, ["term", "meaning"], `terminology[${index}]`);
        return { term: stringWithDefault(entry, "term"), meaning: stringWithDefault(entry, "meaning") };
    });
    const roles = recordArray(data, "roles").map((role, index) => {
        rejectUnknownKeys(role, ["name", "capabilities"], `roles[${index}]`);
        return { name: stringWithDefault(role, "name"), capabilities: stringArray(role, "capabilities") };
    });
    const sources = recordArray(data, "sources").map((entry, index) => {
        rejectUnknownKeys(entry, ["url", "note"], `sources[${index}]`);
        return { url: stringWithDefault(entry, "url"), note: stringWithDefault(entry, "note") };
    });
    return {
        ...EMPTY_PROJECT_CONTEXT,
        summary: stringWithDefault(data, "summary"),
        areas,
        terminology,
        roles,
        businessRules: stringArray(data, "businessRules"),
        uiPatterns: stringArray(data, "uiPatterns"),
        executionNotes: stringArray(data, "executionNotes"),
        unknowns: stringArray(data, "unknowns"),
        sources,
    };
}

export function parseYamlIdentity(source: string): { id: string | null; title: string | null } {
    try {
        const data = parseDocument(source);
        return {
            id: typeof data.id === "string" && data.id.trim() ? data.id.trim() : null,
            title: typeof data.title === "string" && data.title.trim() ? data.title.trim() : null,
        };
    } catch {
        return { id: null, title: null };
    }
}
