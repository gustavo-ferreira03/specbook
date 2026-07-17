import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { RunStatus } from "../../db/schema";

interface EvidenceManifest {
    steps: { number: number; file: string }[];
    video: string | null;
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

function keywordFromLine(line: string): string | null {
    if (!/^\s+/.test(line)) return null;
    const values = cells(line);
    let index = 0;
    while (/^[$@&]\{[^}]+\}=$/.test(values[index] ?? "")) index += 1;
    return values[index] ? normalized(values[index]) : null;
}

export function instrumentRobotSource(source: string, stepCount: number): string {
    if (stepCount === 0) return source;
    const lines = source.split(/\r?\n/);
    const captures = new Map<number, number[]>();
    const candidates: number[] = [];
    let inTests = false;
    let pageReady = false;
    let browserLine = -1;
    let contextPresent = false;

    for (let index = 0; index < lines.length; index += 1) {
        const section = /^\*{3}\s*(.*?)\s*\*{3}$/.exec(lines[index].trim());
        if (section) {
            inTests = normalized(section[1]) === "testcase" || normalized(section[1]) === "testcases";
            continue;
        }
        if (!inTests) continue;
        const keyword = keywordFromLine(lines[index]);
        if (!keyword) continue;
        if (keyword === "newbrowser" && browserLine < 0) browserLine = index;
        if (keyword === "newcontext") contextPresent = true;
        if (keyword === "newpage" || keyword === "goto") pageReady = true;
        if (pageReady && CAPTURE_KEYWORDS.has(keyword)) candidates.push(index);
    }

    if (candidates.length) {
        for (let number = 1; number <= stepCount; number += 1) {
            const line = candidates[Math.min(number - 1, candidates.length - 1)];
            captures.set(line, [...(captures.get(line) ?? []), number]);
        }
    }

    const instrumented: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        instrumented.push(line);
        const indentation = /^\s*/.exec(line)?.[0] || "    ";
        if (index === browserLine && !contextPresent) {
            instrumented.push(`${indentation}Run Keyword And Ignore Error    New Context    recordVideo={'dir': '\${OUTPUT DIR}/video', 'size': {'width': 1280, 'height': 720}}`);
        }
        for (const number of captures.get(index) ?? []) {
            const filename = `step-${String(number).padStart(2, "0")}.png`;
            instrumented.push(`${indentation}Run Keyword And Ignore Error    Take Screenshot    \${OUTPUT DIR}/evidence/${filename}`);
        }
    }
    return instrumented.join("\n");
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
    stepCount: number,
): Promise<void> {
    const evidenceDir = path.join(outputDir, "evidence");
    await fs.mkdir(evidenceDir, { recursive: true });
    const steps: EvidenceManifest["steps"] = [];
    for (let number = 1; number <= stepCount; number += 1) {
        const file = `evidence/step-${String(number).padStart(2, "0")}.png`;
        try {
            if ((await fs.stat(path.join(outputDir, file))).isFile()) steps.push({ number, file });
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
