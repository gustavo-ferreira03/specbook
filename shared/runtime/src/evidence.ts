import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { RunStatus } from "./types.ts";
import type { SpecFileResult } from "./report.ts";
import { API_STEP_ATTACHMENT_PREFIX, STEP_ATTACHMENT_PREFIX } from "./specbook/guard.ts";
import { encodeReplay, isReplayEvents, MAX_REPLAY_BYTES, MAX_REPLAY_RAW_BYTES, REPLAY_ATTACHMENT, REPLAY_FILE, REPLAY_LIMIT_NOTE, REPLAY_UNAVAILABLE_ATTACHMENT } from "./replay.ts";
import { scrubJson } from "./scrub.ts";

export interface EvidenceStep {
    number: number;
    label: string;
    file: string;
}

const runDiagnosticSchema = z.object({
    kind: z.enum(["console", "pageerror", "requestfailed", "response"]),
    message: z.string().max(2000),
    url: z.string().max(2000).optional(),
    method: z.string().max(30).optional(),
    status: z.number().int().min(400).max(599).optional(),
});

export type RunDiagnostic = z.infer<typeof runDiagnosticSchema>;

const apiRequestEvidenceSchema = z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    url: z.string().max(2000),
    status: z.number().int().min(100).max(599).nullable(),
    requestHeaders: z.record(z.string(), z.string().max(1000)),
    requestBody: z.string().max(4000).optional(),
    responseHeaders: z.record(z.string(), z.string().max(1000)).optional(),
    responseBody: z.string().max(4000).optional(),
    error: z.string().max(2000).optional(),
});
export type ApiStepEvidence = { number: number; label: string; requests: z.infer<typeof apiRequestEvidenceSchema>[] };
export type ApiRequestEvidence = z.infer<typeof apiRequestEvidenceSchema>;

export interface EvidenceManifest {
    steps: EvidenceStep[];
    video: string | null;
    failedStep: string | null;
    diagnostics?: RunDiagnostic[];
    errorContext?: string;
    apiSteps?: ApiStepEvidence[];
    replay?: { file: typeof REPLAY_FILE; bytes: number } | null;
    replayUnavailable?: string;
}

export function stepScreenshotContentType(file: string): "image/png" | "image/webp" {
    return file.endsWith(".webp") ? "image/webp" : "image/png";
}

export function isStepScreenshot(file: string): boolean {
    return /^evidence\/step-\d{2,3}\.(?:png|webp)$/.test(file);
}

const evidenceStepSchema = z.object({
    number: z.number().int().positive().optional(),
    label: z.string().default(""),
    file: z.string().refine(isStepScreenshot),
}).transform((step) => ({ ...step, number: step.number ?? Number(step.file.match(/step-(\d+)/)![1]) }));

const evidenceManifestSchema = z.object({
    steps: z.array(evidenceStepSchema).default([]),
    video: z.string().nullable().default(null),
    failedStep: z.string().nullable().default(null),
    diagnostics: z.array(runDiagnosticSchema).max(100).optional(),
    errorContext: z.string().max(32_000).optional(),
    apiSteps: z.array(z.object({
        number: z.number().int().positive(),
        label: z.string(),
        requests: z.array(apiRequestEvidenceSchema).max(30),
    })).optional(),
    replay: z.object({ file: z.literal(REPLAY_FILE), bytes: z.number().int().positive().max(MAX_REPLAY_BYTES) }).nullable().optional(),
    replayUnavailable: z.string().max(500).optional(),
});

export async function readEvidenceManifest(runDir: string): Promise<EvidenceManifest> {
    try {
        return evidenceManifestSchema.parse(JSON.parse(await fs.readFile(path.join(runDir, "evidence.json"), "utf8")));
    } catch {
        return { steps: [], video: null, failedStep: null };
    }
}

async function readText(source: string, maxBytes: number): Promise<string | null> {
    try {
        const stat = await fs.lstat(source);
        if (!stat.isFile() || stat.size > maxBytes) return null;
        return await fs.readFile(source, "utf8");
    } catch {
        return null;
    }
}

async function copyFile(source: string, destination: string): Promise<boolean> {
    try {
        const stat = await fs.lstat(source);
        if (!stat.isFile()) return false;
        await fs.copyFile(source, destination);
        return true;
    } catch {
        return false;
    }
}

export async function writeRunEvidence(
    outputDir: string,
    status: Exclude<RunStatus, "running">,
    result: Pick<SpecFileResult, "attachments" | "failedStep"> | null,
    stepTitles: string[],
    scrub: (text: string) => string = (text) => text,
): Promise<EvidenceManifest> {
    const evidenceDir = path.join(outputDir, "evidence");
    await fs.mkdir(evidenceDir, { recursive: true });
    await fs.rm(path.join(outputDir, REPLAY_FILE), { force: true });
    const steps: EvidenceStep[] = [];
    for (const attachment of result?.attachments ?? []) {
        const match = new RegExp(`^${STEP_ATTACHMENT_PREFIX}(\\d{2,3})$`).exec(attachment.name);
        if (!match || !["image/png", "image/webp"].includes(attachment.contentType)) continue;
        const number = Number(match[1]);
        if (steps.some((step) => step.number === number)) continue;
        const extension = attachment.contentType === "image/webp" ? "webp" : "png";
        const file = `evidence/step-${match[1]}.${extension}`;
        if (await copyFile(attachment.path, path.join(outputDir, file))) {
            steps.push({ number, label: stepTitles[number - 1] ?? `Step ${number}`, file });
        }
    }
    steps.sort((left, right) => left.number - right.number);
    let video: string | null = null;
    if (status !== "passed") {
        const recording = result?.attachments.find((attachment) => attachment.name === "video" && attachment.path.endsWith(".webm"));
        if (recording && (await copyFile(recording.path, path.join(outputDir, "evidence", "execution.webm")))) {
            video = "evidence/execution.webm";
        }
    }
    const manifest: EvidenceManifest = { steps, video, failedStep: status === "passed" ? null : result?.failedStep ?? null };
    for (const attachment of result?.attachments ?? []) {
        const apiMatch = new RegExp(`^${API_STEP_ATTACHMENT_PREFIX}(\\d{2,3})$`).exec(attachment.name);
        if (apiMatch && attachment.contentType === "application/json") {
            const text = await readText(attachment.path, 1_000_000);
            if (!text) continue;
            try {
                const parsed = z.array(apiRequestEvidenceSchema).max(30).safeParse(scrubJson(JSON.parse(text), scrub));
                const number = Number(apiMatch[1]);
                if (parsed.success && number >= 1 && number <= stepTitles.length && !manifest.apiSteps?.some((step) => step.number === number)) {
                    (manifest.apiSteps ??= []).push({ number, label: stepTitles[number - 1], requests: parsed.data });
                }
            } catch {}
        } else if (attachment.name === REPLAY_ATTACHMENT && attachment.contentType === "application/json") {
            const text = await readText(attachment.path, MAX_REPLAY_RAW_BYTES);
            if (!text) { manifest.replayUnavailable = REPLAY_LIMIT_NOTE; continue; }
            try {
                const events: unknown = scrubJson(JSON.parse(text), scrub);
                if (!isReplayEvents(events)) { manifest.replayUnavailable = "Replay could not be recorded."; continue; }
                const data = await encodeReplay(events);
                if (data) {
                    await fs.writeFile(path.join(outputDir, REPLAY_FILE), data);
                    manifest.replay = { file: REPLAY_FILE, bytes: data.length };
                } else manifest.replayUnavailable = REPLAY_LIMIT_NOTE;
            } catch { manifest.replayUnavailable = "Replay could not be recorded."; }
        } else if (attachment.name === REPLAY_UNAVAILABLE_ATTACHMENT && attachment.contentType === "text/plain") {
            const text = await readText(attachment.path, 500);
            if (text) manifest.replayUnavailable = scrub(text).slice(0, 500);
        } else if (attachment.name === "specbook-diagnostics" && attachment.contentType === "application/json") {
            const text = await readText(attachment.path, 1_000_000);
            if (!text) continue;
            try {
                const diagnostics = z.array(runDiagnosticSchema).max(100).safeParse(scrubJson(JSON.parse(text), scrub));
                if (diagnostics.success) manifest.diagnostics = diagnostics.data;
            } catch {}
        } else if (status !== "passed" && ["specbook-error-context", "error-context"].includes(attachment.name)) {
            if (!attachment.contentType.startsWith("text/")) continue;
            const text = await readText(attachment.path, 1_000_000);
            if (text) manifest.errorContext = [manifest.errorContext, scrub(text)].filter(Boolean).join("\n\n").slice(0, 32_000);
        }
    }
    manifest.apiSteps?.sort((left, right) => left.number - right.number);
    await fs.writeFile(path.join(outputDir, "evidence.json"), JSON.stringify(manifest), "utf8");
    return manifest;
}
