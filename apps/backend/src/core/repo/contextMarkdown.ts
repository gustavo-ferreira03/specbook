import type { ProjectContext } from "../../infra/db/schema";
import { MarkdownParseError } from "./markdown";

function bulletList(items: string[]): string {
    return items.map((item) => `- ${item}`).join("\n");
}

function parseBullets(block: string): string[] {
    return block
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const match = /^-\s+(.*)$/.exec(line);
            if (!match) throw new MarkdownParseError(`Expected a bullet item, got: "${line}"`);
            return match[1].trim();
        });
}

function splitTopSections(source: string): Map<string, string> {
    const withoutTitle = source.replace(/^#\s+Project Context\s*\n/, "");
    const sections = new Map<string, string>();
    for (const part of withoutTitle.split(/^##\s+/m).slice(1)) {
        const newline = part.indexOf("\n");
        const heading = (newline === -1 ? part : part.slice(0, newline)).trim().toLowerCase();
        sections.set(heading, newline === -1 ? "" : part.slice(newline + 1));
    }
    return sections;
}

function splitSubSections(block: string): { name: string; body: string }[] {
    return block.split(/^###\s+/m).slice(1).map((part) => {
        const newline = part.indexOf("\n");
        return {
            name: (newline === -1 ? part : part.slice(0, newline)).trim(),
            body: newline === -1 ? "" : part.slice(newline + 1),
        };
    });
}

export function serializeContextMarkdown(context: ProjectContext): string {
    const areas = context.areas
        .map((area) => {
            const lines = [`### ${area.name}`, "", `Routes: ${area.routes.join(", ")}`];
            if (area.description.trim()) lines.push("", area.description.trim());
            return lines.join("\n");
        })
        .join("\n\n");
    const roles = context.roles
        .map((role) => [`### ${role.name}`, "", bulletList(role.capabilities)].join("\n").trimEnd())
        .join("\n\n");
    const terminology = bulletList(context.terminology.map((entry) => `**${entry.term}** — ${entry.meaning}`));
    const sources = bulletList(
        context.sources.map((entry) => (entry.note.trim() ? `${entry.url} — ${entry.note}` : entry.url)),
    );
    const sections = [
        ["Summary", context.summary.trim()],
        ["Areas", areas],
        ["Terminology", terminology],
        ["Roles", roles],
        ["Business Rules", bulletList(context.businessRules)],
        ["UI Patterns", bulletList(context.uiPatterns)],
        ["Execution Notes", bulletList(context.executionNotes)],
        ["Unknowns", bulletList(context.unknowns)],
        ["Sources", sources],
    ] as const;
    const body = sections
        .map(([heading, content]) => (content ? `## ${heading}\n\n${content}` : `## ${heading}`))
        .join("\n\n");
    return `# Project Context\n\n${body}\n`;
}

export function parseContextMarkdown(source: string): ProjectContext {
    const sections = splitTopSections(source);
    const areas = splitSubSections(sections.get("areas") ?? "").map((sub) => {
        const routesMatch = /^Routes:\s*(.*)$/m.exec(sub.body);
        const routes = (routesMatch?.[1] ?? "")
            .split(",")
            .map((route) => route.trim())
            .filter(Boolean);
        const description = sub.body.replace(/^Routes:.*$/m, "").trim();
        return { name: sub.name, routes, description };
    });
    const roles = splitSubSections(sections.get("roles") ?? "").map((sub) => ({
        name: sub.name,
        capabilities: parseBullets(sub.body),
    }));
    const terminology = parseBullets(sections.get("terminology") ?? "").map((item) => {
        const match = /^\*\*(.+?)\*\*\s+—\s+(.*)$/.exec(item);
        if (!match) throw new MarkdownParseError(`Terminology entry must be "**term** — meaning", got: "${item}"`);
        return { term: match[1], meaning: match[2] };
    });
    const sources = parseBullets(sections.get("sources") ?? "").map((item) => {
        const match = /^(\S+)(?:\s+—\s+(.*))?$/.exec(item);
        if (!match) throw new MarkdownParseError(`Source entry must be "url — note", got: "${item}"`);
        return { url: match[1], note: match[2] ?? "" };
    });
    return {
        summary: (sections.get("summary") ?? "").trim(),
        areas,
        terminology,
        roles,
        businessRules: parseBullets(sections.get("business rules") ?? ""),
        uiPatterns: parseBullets(sections.get("ui patterns") ?? ""),
        executionNotes: parseBullets(sections.get("execution notes") ?? ""),
        unknowns: parseBullets(sections.get("unknowns") ?? ""),
        sources,
    };
}
