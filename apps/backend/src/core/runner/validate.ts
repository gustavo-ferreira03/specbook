import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const RUN_TIMEOUT_MS = 120_000;
const ALLOWED_LIBRARIES = new Set(["Browser"]);
const FORBIDDEN_KEYWORDS = new Set([
    "callmethod",
    "continueforloopif",
    "elseif",
    "evaluate",
    "exitforloopif",
    "getlibraryinstance",
    "if",
    "importlibrary",
    "importresource",
    "importvariables",
    "passexecutionif",
    "promisetouploadfile",
    "repeatkeyword",
    "returnfromkeywordif",
    "setvariableif",
    "shouldbetrue",
    "shouldnotbetrue",
    "skipif",
    "uploadfilebyselector",
    "waituntilkeywordsucceeds",
    "while",
]);
const ALLOWED_KEYWORDS = new Set([
    "blurelement",
    "checkcheckbox",
    "cleartext",
    "click",
    "closebrowser",
    "closecontext",
    "closepage",
    "fillsecret",
    "filltext",
    "focus",
    "getattribute",
    "getcheckboxstate",
    "getelementcount",
    "getelementstates",
    "getproperty",
    "getstyle",
    "gettext",
    "gettitle",
    "geturl",
    "goback",
    "goto",
    "hover",
    "lengthshouldbe",
    "log",
    "newbrowser",
    "newpage",
    "presskeys",
    "reload",
    "scrolltoelement",
    "selectoptionsby",
    "setvariable",
    "shouldcontain",
    "shouldendwith",
    "shouldbeequal",
    "shouldbeequalasstrings",
    "shouldmatch",
    "shouldmatchregexp",
    "shouldnotcontain",
    "shouldnotmatch",
    "shouldnotmatchregexp",
    "shouldstartwith",
    "typesecret",
    "typetext",
    "uncheckcheckbox",
    "waitforelementsstate",
]);
const ALLOWED_TEST_SETTINGS = new Set(["[documentation]", "[tags]", "[timeout]"]);
const ALLOWED_KEYWORD_SETTINGS = new Set(["[arguments]", "[documentation]", "[return]", "[tags]", "[timeout]"]);
const SECRET_TOKEN = /%SPECBOOK_SECRET_[A-Z0-9_]+/g;
const SECRET_TOKEN_EXACT = /^%SPECBOOK_SECRET_[A-Z0-9_]+$/;

export function secretEnvRefs(source: string): string[] {
    return [...new Set([...source.matchAll(SECRET_TOKEN)].map((match) => match[0].slice(1)))];
}

type Section = "settings" | "variables" | "tests" | "keywords" | "other";

interface RobotRow {
    section: Section;
    cells: string[];
}

function splitPipeRow(line: string): string[] {
    const cells: string[] = [];
    let cell = "";
    let escaped = false;
    for (const character of line.trim().slice(1, -1)) {
        if (character === "|" && !escaped) {
            cells.push(cell.trim());
            cell = "";
        } else {
            cell += character;
        }
        if (character === "\\") escaped = !escaped;
        else escaped = false;
    }
    cells.push(cell.trim());
    return cells;
}

function splitCells(line: string): string[] {
    const trimmed = line.trim();
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) return splitPipeRow(line);
    return line.split(/(?: {2,}|\t+)/).map((cell) => cell.trim());
}

function robotValue(value: string): string {
    return value.replace(/\\(.)/g, "$1");
}

function normalizedName(value: string): string {
    return robotValue(value).replace(/[\s_]+/g, "").toLowerCase();
}

function sectionFromLine(line: string): Section | null {
    const cells = splitCells(line).filter(Boolean);
    if (cells.length !== 1) return null;
    const match = /^\*{3}\s*(.*?)\s*\*{3}$/.exec(cells[0]);
    if (!match) return null;
    const name = normalizedName(match[1]);
    if (name === "setting" || name === "settings") return "settings";
    if (name === "variable" || name === "variables") return "variables";
    if (name === "testcase" || name === "testcases" || name === "task" || name === "tasks") return "tests";
    if (name === "keyword" || name === "keywords") return "keywords";
    return "other";
}

function rowsFromSource(source: string): RobotRow[] {
    const rows: RobotRow[] = [];
    let section: Section = "other";
    for (const rawLine of source.split(/\r?\n/)) {
        const trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const nextSection = sectionFromLine(rawLine);
        if (nextSection) {
            section = nextSection;
            continue;
        }
        const cells = splitCells(rawLine);
        const commentIndex = cells.findIndex((cell) => cell.startsWith("#"));
        if (commentIndex >= 0) cells.splice(commentIndex);
        if (cells.some(Boolean)) rows.push({ section, cells });
    }
    return rows;
}

function normalizedKeyword(value: string): string {
    const withoutPrefix = robotValue(value).trim().replace(/^(given|when|then|and|but)\s+/i, "");
    let name = normalizedName(withoutPrefix);
    if (name.startsWith("builtin.")) name = name.slice("builtin.".length);
    if (name.startsWith("browser.")) name = name.slice("browser.".length);
    return name;
}

function forbiddenKeyword(value: string): string | null {
    const name = normalizedKeyword(value);
    return FORBIDDEN_KEYWORDS.has(name) || name.startsWith("runkeyword") ? robotValue(value) : null;
}

function isAssignment(value: string): boolean {
    return /^[$@&]\{[^}]+\}=$/.test(robotValue(value).replace(/\s+/g, ""));
}

function inspectSource(source: string): string | null {
    if (source.includes("${{")) {
        return "Inline Python expressions are not allowed.";
    }
    if (source.includes("%{")) {
        return "Environment variables are not allowed. For secrets, use Fill Secret with a brace-less %SPECBOOK_SECRET_... reference.";
    }
    if (/\$\{[^}\n]*(?:\.|\[|\(|\))[^}\n]*\}/.test(source)) {
        return "Extended variable expressions are not allowed.";
    }
    const rows = rowsFromSource(source);
    const customKeywords = new Set(
        rows
            .filter((row) => row.section === "keywords" && row.cells.findIndex(Boolean) === 0)
            .map((row) => normalizedKeyword(row.cells[0])),
    );
    let pendingSetting: string[] | null = null;

    const inspectSetting = (cells: string[]): string | null => {
        const values = cells.filter(Boolean);
        if (values.length === 0) return null;
        const setting = normalizedName(values[0]);
        if (setting === "resource" || setting === "variables") {
            return `${robotValue(values[0])} imports are not allowed.`;
        }
        if (setting === "library") {
            const library = values[1] ? robotValue(values[1]) : "";
            if (!ALLOWED_LIBRARIES.has(library)) {
                return `Library "${library}" is not allowed. Allowed libraries: ${[...ALLOWED_LIBRARIES].join(", ")}.`;
            }
            if (values.length !== 2) return "The Browser library cannot receive arguments or aliases.";
        }
        if (!["library", "documentation", "metadata", "forcetags", "defaulttags", "testtags"].includes(setting)) {
            return `Setting "${robotValue(values[0])}" is not allowed.`;
        }
        return null;
    };

    for (const row of rows) {
        const firstIndex = row.cells.findIndex(Boolean);
        if (firstIndex < 0) continue;
        const first = row.cells[firstIndex];
        if ((row.section !== "tests" && row.section !== "keywords") || firstIndex === 0) {
            if (row.cells.some((cell) => robotValue(cell).includes("%SPECBOOK_SECRET_"))) {
                return "Secret references are only allowed as Fill Secret / Type Secret arguments.";
            }
        }
        if (row.section === "variables") {
            return "Variables sections are not allowed.";
        }
        if (row.section === "settings") {
            if (first === "...") {
                if (pendingSetting) pendingSetting.push(...row.cells.slice(firstIndex + 1));
                continue;
            }
            if (pendingSetting) {
                const error = inspectSetting(pendingSetting);
                if (error) return error;
            }
            pendingSetting = row.cells.slice(firstIndex);
            continue;
        }
        if (pendingSetting) {
            const error = inspectSetting(pendingSetting);
            if (error) return error;
            pendingSetting = null;
        }
        if ((row.section === "tests" || row.section === "keywords") && firstIndex > 0) {
            let keywordIndex = firstIndex;
            while (keywordIndex < row.cells.length && isAssignment(row.cells[keywordIndex])) keywordIndex += 1;
            const keyword = row.cells[keywordIndex];
            if (!keyword) continue;
            const keywordSetting = normalizedName(keyword);
            const allowedSettings = row.section === "tests" ? ALLOWED_TEST_SETTINGS : ALLOWED_KEYWORD_SETTINGS;
            if (keywordSetting.startsWith("[") && keywordSetting.endsWith("]")) {
                if (!allowedSettings.has(keywordSetting)) {
                    return `Setting "${robotValue(keyword)}" is not allowed.`;
                }
                continue;
            }
            const forbidden = forbiddenKeyword(keyword);
            if (forbidden) return `Keyword "${forbidden}" is not allowed.`;
            const name = normalizedKeyword(keyword);
            if (!ALLOWED_KEYWORDS.has(name) && !customKeywords.has(name)) {
                return `Keyword "${robotValue(keyword)}" is not allowed.`;
            }
            const args = row.cells.slice(keywordIndex + 1).filter(Boolean);
            const secretKeyword = name === "fillsecret" || name === "typesecret";
            for (const arg of args) {
                const value = robotValue(arg);
                if (!value.includes("%SPECBOOK_SECRET_")) continue;
                if (!secretKeyword) {
                    return `Secret references are only allowed as Fill Secret / Type Secret arguments (found in "${robotValue(keyword)}").`;
                }
                if (!SECRET_TOKEN_EXACT.test(value)) {
                    return `Secret argument "${value}" must be exactly one %SPECBOOK_SECRET_... reference.`;
                }
            }
            if (name === "newbrowser") {
                const normalizedArgs = args.map(normalizedName).sort();
                const validArgs =
                    normalizedArgs.length === 2 &&
                    normalizedArgs.includes("headless=true") &&
                    (normalizedArgs.includes("chromium") || normalizedArgs.includes("browser=chromium"));
                if (!validArgs) return "New Browser must use only chromium and headless=true.";
            }
            if ((name === "newpage" || name === "goto") && !robotValue(args[0] ?? "").startsWith("${BASE_URL}")) {
                return `${robotValue(keyword)} must navigate to a URL beginning with \${BASE_URL}.`;
            }
        }
    }
    return pendingSetting ? inspectSetting(pendingSetting) : null;
}

function terminateProcessTree(proc: ChildProcess): void {
    if (process.platform === "linux" && proc.pid) {
        try {
            process.kill(-proc.pid, "SIGKILL");
            return;
        } catch {}
    }
    try {
        proc.kill("SIGKILL");
    } catch {}
}

function runRobot(args: string[], cwd: string): Promise<{ code: number | null; output: string; timedOut: boolean }> {
    return new Promise((resolve, reject) => {
        const proc = spawn("robot", args, {
            cwd,
            detached: process.platform === "linux",
            stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        let settled = false;
        const finish = (result: { code: number | null; output: string; timedOut: boolean }) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const timer = setTimeout(() => {
            terminateProcessTree(proc);
            finish({ code: null, output, timedOut: true });
        }, RUN_TIMEOUT_MS);
        proc.stdout.on("data", (data: Buffer) => (output += data.toString()));
        proc.stderr.on("data", (data: Buffer) => (output += data.toString()));
        proc.once("error", (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        proc.once("exit", (code) => finish({ code, output, timedOut: false }));
    });
}

export async function validateRobotSource(source: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const inspectionError = inspectSource(source);
    if (inspectionError) return { ok: false, error: inspectionError };

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "specbook-dryrun-"));
    try {
        await fs.writeFile(path.join(dir, "spec.robot"), source, "utf8");
        const result = await runRobot(
            ["--dryrun", "--output", "NONE", "--report", "NONE", "--log", "NONE", "--variable", "BASE_URL:http://localhost", "spec.robot"],
            dir,
        );
        if (result.timedOut) return { ok: false, error: `robot --dryrun timed out after ${RUN_TIMEOUT_MS / 1000}s` };
        if (result.code === 0) return { ok: true };
        return { ok: false, error: result.output.trim().slice(0, 2000) || `robot --dryrun exited with code ${result.code}` };
    } catch (error) {
        return { ok: false, error: `robot is not available: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}
