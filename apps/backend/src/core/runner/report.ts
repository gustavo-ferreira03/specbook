import path from "node:path";
import { FAILED_STEP_ANNOTATION } from "./specbook/guard";

/** Result of the single test in one spec file of a Playwright run. */
export interface SpecFileResult {
    status: "passed" | "failed" | "error";
    durationMs: number | null;
    failReason: string | null;
    /** Title of the step() where the test failed (null when passed or unknown). */
    failedStep: string | null;
    attachments: { name: string; path: string; contentType: string }[];
}

export interface PlaywrightReport {
    /** Keyed by the spec file name without ".spec.ts" (the run id). */
    files: Map<string, SpecFileResult>;
    /** Errors outside any test, such as a file that failed to load. */
    errors: string[];
}

type Json = Record<string, unknown>;

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
    return text.replace(ANSI, "");
}

function records(value: unknown): Json[] {
    return Array.isArray(value) ? value.filter((item): item is Json => !!item && typeof item === "object") : [];
}

function text(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value : null;
}

function errorMessage(error: Json): string | null {
    const message = text(error.message) ?? text(error.value);
    return message ? stripAnsi(message).trim() : null;
}

function failedStepOf(test: Json, result: Json): string | null {
    for (const annotation of [...records(result.annotations), ...records(test.annotations)]) {
        if (annotation.type === FAILED_STEP_ANNOTATION && text(annotation.description)) return String(annotation.description);
    }
    const failed = records(result.steps).find((step) => step.error);
    return failed ? text(failed.title) : null;
}

function fileKey(file: string): string {
    return path.basename(file).replace(/\.spec\.ts$/, "");
}

function testResult(test: Json): SpecFileResult {
    const results = records(test.results);
    const result = results[results.length - 1];
    if (!result) return { status: "error", durationMs: null, failReason: "Playwright did not run the test", failedStep: null, attachments: [] };
    const duration = Number(result.duration);
    const durationMs = Number.isFinite(duration) ? Math.round(duration) : null;
    const attachments = records(result.attachments).flatMap((attachment) =>
        typeof attachment.name === "string" && typeof attachment.path === "string"
            ? [{ name: attachment.name, path: attachment.path, contentType: String(attachment.contentType ?? "") }]
            : [],
    );
    const status = String(result.status ?? "");
    if (status === "passed") return { status: "passed", durationMs, failReason: null, failedStep: null, attachments };
    const messages = records(result.errors).map(errorMessage).filter((message): message is string => !!message);
    const single = result.error && typeof result.error === "object" ? errorMessage(result.error as Json) : null;
    if (messages.length === 0 && single) messages.push(single);
    if (status === "skipped") {
        return { status: "error", durationMs, failReason: messages.join("\n\n") || "The test was skipped", failedStep: null, attachments };
    }
    return {
        status: "failed",
        durationMs,
        failReason: messages.join("\n\n") || (status === "timedOut" ? "The test timed out" : `The test ${status || "failed"}`),
        failedStep: failedStepOf(test, result),
        attachments,
    };
}

function collect(suites: Json[], files: Map<string, SpecFileResult>, file: string | null): void {
    for (const suite of suites) {
        const suiteFile = text(suite.file) ?? file;
        for (const spec of records(suite.specs)) {
            const specFile = text(spec.file) ?? suiteFile;
            if (!specFile) continue;
            const key = fileKey(specFile);
            for (const test of records(spec.tests)) {
                const result = testResult(test);
                const previous = files.get(key);
                // A valid spec.ts holds one test; if a file somehow reports more, any failure wins.
                if (!previous || previous.status === "passed") files.set(key, result);
            }
        }
        collect(records(suite.suites), files, suiteFile);
    }
}

/** Parses the output of Playwright's JSON reporter. */
export function parsePlaywrightReport(json: string): PlaywrightReport {
    const data = JSON.parse(json) as Json;
    if (!data || typeof data !== "object" || !Array.isArray(data.suites)) throw new Error("Playwright report has no suites");
    const files = new Map<string, SpecFileResult>();
    collect(records(data.suites), files, null);
    const errors = records(data.errors).map(errorMessage).filter((message): message is string => !!message);
    return { files, errors };
}
