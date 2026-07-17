import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { RunStatus } from "../../db/schema";

interface EvidenceManifest {
    steps: PlannedEvidenceStep[];
    video: string | null;
}

export interface PlannedEvidenceStep {
    number: number;
    label: string;
    file: string;
}

const CAPTURE_KEYWORDS = new Set([
    "newpage",
    "goto",
    "goback",
    "reload",
    "filltext",
    "typetext",
    "cleartext",
    "click",
    "checkcheckbox",
    "uncheckcheckbox",
    "selectoptionsby",
    "presskeys",
    "scrolltoelement",
    "hover",
    "waitforelementsstate",
    "getattribute",
    "getcheckboxstate",
    "getelementcount",
    "getelementstates",
    "getproperty",
    "getstyle",
    "gettext",
    "gettitle",
    "geturl",
]);

function cells(line: string): string[] {
    return line.trim().split(/(?: {2,}|\t+)/).filter(Boolean);
}

function normalized(value: string): string {
    return value.replace(/^(?:given|when|then|and|but)\s+/i, "").replace(/^(?:Browser\.|BuiltIn\.)/i, "").replace(/[\s_]+/g, "").toLowerCase();
}

function lineDetails(line: string): { keyword: string; label: string; values: string[] } | null {
    if (!/^\s+/.test(line)) return null;
    const values = cells(line);
    let index = 0;
    while (/^[$@&]\{[^}]+\}=$/.test(values[index] ?? "")) index += 1;
    if (!values[index]) return null;
    return {
        keyword: normalized(values[index]),
        label: values[index].replace(/^(?:Browser\.|BuiltIn\.)/i, ""),
        values: values.slice(index + 1),
    };
}

function evidenceLabel(details: { keyword: string; label: string; values: string[] }): string {
    const hiddenValueKeywords = new Set(["filltext", "typetext", "presskeys", "selectoptionsby"]);
    const values = hiddenValueKeywords.has(details.keyword) ? details.values.slice(0, 1) : details.values;
    return [details.label, ...values].filter(Boolean).join("    ");
}

function customKeywordNames(lines: string[]): Set<string> {
    const names = new Set<string>();
    let inKeywords = false;
    for (const line of lines) {
        const section = /^\*{3}\s*(.*?)\s*\*{3}$/.exec(line.trim());
        if (section) {
            const name = normalized(section[1]);
            inKeywords = name === "keyword" || name === "keywords";
            continue;
        }
        const trimmed = line.trim();
        if (!inKeywords || !trimmed || trimmed.startsWith("#") || /^\s/.test(line)) continue;
        const name = trimmed.startsWith("|") && trimmed.endsWith("|")
            ? trimmed.slice(1, -1).split("|")[0].trim()
            : trimmed;
        if (name) names.add(normalized(name));
    }
    return names;
}

export function namedRobotStepsError(source: string): string | null {
    const lines = source.split(/\r?\n/);
    const customKeywords = customKeywordNames(lines);
    if (customKeywords.size === 0) {
        return "Robot source must define named user keywords in the Keywords section and call them from the Test Case.";
    }
    let inTests = false;
    let calls = 0;
    for (const line of lines) {
        const section = /^\*{3}\s*(.*?)\s*\*{3}$/.exec(line.trim());
        if (section) {
            const name = normalized(section[1]);
            inTests = name === "testcase" || name === "testcases";
            continue;
        }
        if (!inTests || line.trim().startsWith("#")) continue;
        const details = lineDetails(line);
        if (!details || details.label.startsWith("[") || details.label === "...") continue;
        if (!customKeywords.has(details.keyword)) {
            return `Move the top-level Robot command "${details.label}" into a named user keyword. The Test Case body must contain only business-readable user keyword calls.`;
        }
        calls += 1;
    }
    return calls > 0 ? null : "Robot Test Case must call at least one named user keyword.";
}

export function instrumentRobotSource(
    source: string,
    paths: { evidence?: string; video?: string } = {},
): { source: string; steps: PlannedEvidenceStep[] } {
    const lines = source.split(/\r?\n/);
    const captures = new Map<number, PlannedEvidenceStep[]>();
    const steps: PlannedEvidenceStep[] = [];
    const customKeywords = customKeywordNames(lines);
    const namedCalls: { line: number; label: string }[] = [];
    const primitiveCalls: { line: number; label: string }[] = [];
    let inTests = false;
    let pageReady = false;
    let browserLine = -1;
    let contextPresent = false;
    const evidencePath = paths.evidence ?? "evidence";
    const videoPath = paths.video ?? "video";

    for (let index = 0; index < lines.length; index += 1) {
        const section = /^\*{3}\s*(.*?)\s*\*{3}$/.exec(lines[index].trim());
        if (section) {
            inTests = normalized(section[1]) === "testcase" || normalized(section[1]) === "testcases";
            continue;
        }
        const details = lineDetails(lines[index]);
        if (!details) continue;
        const { keyword } = details;
        if (keyword === "newbrowser" && browserLine < 0) browserLine = index;
        if (keyword === "newcontext") contextPresent = true;
        if (!inTests) continue;
        if (customKeywords.has(keyword)) namedCalls.push({ line: index, label: details.label });
        if (keyword === "newpage" || keyword === "goto") pageReady = true;
        if (pageReady && CAPTURE_KEYWORDS.has(keyword)) {
            primitiveCalls.push({ line: index, label: evidenceLabel(details) });
        }
    }

    for (const call of namedCalls.length ? namedCalls : primitiveCalls) {
        const number = steps.length + 1;
        const step = {
            number,
            label: call.label,
            file: `evidence/step-${String(number).padStart(2, "0")}.png`,
        };
        steps.push(step);
        captures.set(call.line, [...(captures.get(call.line) ?? []), step]);
    }

    const instrumented: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        instrumented.push(line);
        const indentation = /^\s*/.exec(line)?.[0] || "    ";
        if (index === browserLine && !contextPresent) {
            instrumented.push(`${indentation}Run Keyword And Ignore Error    New Context    recordVideo={'dir': '\${OUTPUT DIR}/${videoPath}', 'size': {'width': 1280, 'height': 720}}`);
        }
        for (const step of captures.get(index) ?? []) {
            const filename = path.posix.basename(step.file);
            instrumented.push(`${indentation}Run Keyword And Ignore Error    Take Screenshot    \${OUTPUT DIR}/${evidencePath}/${filename}`);
        }
    }
    return { source: instrumented.join("\n"), steps };
}

async function firstVideo(directory: string): Promise<string | null> {
    let entries: Dirent[];
    try {
        entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
        return null;
    }
    for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            const nested = await firstVideo(absolute);
            if (nested) return nested;
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".webm")) {
            return absolute;
        }
    }
    return null;
}

export async function finalizeRunEvidence(
    outputDir: string,
    status: Exclude<RunStatus, "running">,
    plannedSteps: PlannedEvidenceStep[],
): Promise<void> {
    const evidenceDir = path.join(outputDir, "evidence");
    await fs.mkdir(evidenceDir, { recursive: true });
    const steps: EvidenceManifest["steps"] = [];
    for (const step of plannedSteps) {
        try {
            if ((await fs.stat(path.join(outputDir, step.file))).isFile()) steps.push(step);
        } catch {}
    }

    const videoDir = path.join(outputDir, "video");
    let video: string | null = null;
    if (status !== "passed") {
        const source = await firstVideo(videoDir);
        if (source) {
            video = "evidence/execution.webm";
            await fs.copyFile(source, path.join(outputDir, video));
        }
    }
    await fs.rm(videoDir, { recursive: true, force: true });
    const manifest: EvidenceManifest = { steps, video };
    await fs.writeFile(path.join(outputDir, "evidence.json"), JSON.stringify(manifest), "utf8");
}
