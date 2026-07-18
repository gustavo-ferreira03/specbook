import matter from "gray-matter";
import type { HumanSpec } from "../../infra/db/schema";

export class MarkdownParseError extends Error {}

export interface SpecDocument {
    id: string | null;
    title: string | null;
    description: string;
    humanSpec: HumanSpec;
}

export interface FeatureDocument {
    id: string | null;
    title: string | null;
    description: string;
}

const KNOWN_SECTIONS = new Set(["preconditions", "steps", "expected result", "postconditions"]);

function frontmatter(source: string): { data: Record<string, unknown>; content: string } {
    try {
        const parsed = matter(source);
        return { data: parsed.data as Record<string, unknown>, content: parsed.content };
    } catch (error) {
        throw new MarkdownParseError(`Invalid frontmatter: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function stringField(data: Record<string, unknown>, key: string): string | null {
    const value = data[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseMarkdownIdentity(source: string): { id: string | null; title: string | null } {
    const { data } = frontmatter(source);
    return { id: stringField(data, "id"), title: stringField(data, "title") };
}

function splitSections(content: string): { intro: string; sections: Map<string, string> } {
    const parts = content.split(/^##\s+/m);
    const sections = new Map<string, string>();
    for (const part of parts.slice(1)) {
        const newline = part.indexOf("\n");
        const heading = (newline === -1 ? part : part.slice(0, newline)).trim().toLowerCase();
        sections.set(heading, newline === -1 ? "" : part.slice(newline + 1));
    }
    return { intro: parts[0] ?? "", sections };
}

function listItems(block: string): string[] {
    return block
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const match = /^(?:[-*]|\d+[.)])\s+(.*)$/.exec(line);
            if (!match) throw new MarkdownParseError(`Expected a list item, got: "${line}"`);
            return match[1].trim();
        });
}

export function serializeSpecMarkdown(doc: {
    id: string;
    title: string;
    description: string;
    humanSpec: HumanSpec;
}): string {
    const lines: string[] = [];
    if (doc.description.trim()) lines.push(doc.description.trim(), "");
    lines.push("## Preconditions", "");
    lines.push(...doc.humanSpec.preconditions.map((item) => `- ${item}`));
    lines.push("", "## Steps", "");
    lines.push(...doc.humanSpec.steps.map((item, index) => `${index + 1}. ${item}`));
    lines.push("", "## Expected Result", "");
    if (doc.humanSpec.expectedResult.trim()) lines.push(doc.humanSpec.expectedResult.trim());
    lines.push("", "## Postconditions", "");
    lines.push(...doc.humanSpec.postconditions.map((item) => `- ${item}`));
    const body = `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
    return matter.stringify(body, { id: doc.id, title: doc.title });
}

export function parseSpecMarkdown(source: string): SpecDocument {
    const { data, content } = frontmatter(source);
    const { intro, sections } = splitSections(content);
    for (const name of sections.keys()) {
        if (!KNOWN_SECTIONS.has(name)) throw new MarkdownParseError(`Unknown section "## ${name}"`);
    }
    return {
        id: stringField(data, "id"),
        title: stringField(data, "title"),
        description: intro.trim(),
        humanSpec: {
            preconditions: listItems(sections.get("preconditions") ?? ""),
            steps: listItems(sections.get("steps") ?? ""),
            expectedResult: (sections.get("expected result") ?? "").trim(),
            postconditions: listItems(sections.get("postconditions") ?? ""),
        },
    };
}

export function serializeFeatureMarkdown(doc: { id: string; title: string; description: string }): string {
    const body = doc.description.trim() ? `${doc.description.trim()}\n` : "";
    return matter.stringify(body, { id: doc.id, title: doc.title });
}

export function parseFeatureMarkdown(source: string): FeatureDocument {
    const { data, content } = frontmatter(source);
    return {
        id: stringField(data, "id"),
        title: stringField(data, "title"),
        description: content.trim(),
    };
}
