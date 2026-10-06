import fs from "node:fs/promises";
import path from "node:path";
import type { RunStatus } from "../../infra/db/schema";
import type { SpecFileResult } from "./report";
import { STEP_ATTACHMENT_PREFIX } from "./specbook/guard";

export interface EvidenceStep {
    number: number;
    label: string;
    file: string;
}

/** evidence.json, read by GET /runs/:id/evidence. */
export interface EvidenceManifest {
    steps: EvidenceStep[];
    video: string | null;
    /** Title of the step() where the run failed, when known. */
    failedStep: string | null;
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

/**
 * Copies the screenshots the step fixture took (and the failure video) out of the
 * Playwright output into <outputDir>/evidence and writes <outputDir>/evidence.json.
 * Step labels are the step() titles of spec.ts.
 */
export async function writeRunEvidence(
    outputDir: string,
    status: Exclude<RunStatus, "running">,
    result: Pick<SpecFileResult, "attachments" | "failedStep"> | null,
    stepTitles: string[],
): Promise<EvidenceManifest> {
    const evidenceDir = path.join(outputDir, "evidence");
    await fs.mkdir(evidenceDir, { recursive: true });
    const steps: EvidenceStep[] = [];
    for (const attachment of result?.attachments ?? []) {
        const match = new RegExp(`^${STEP_ATTACHMENT_PREFIX}(\\d{2,3})$`).exec(attachment.name);
        if (!match || attachment.contentType !== "image/png") continue;
        const number = Number(match[1]);
        if (steps.some((step) => step.number === number)) continue;
        const file = `evidence/step-${match[1]}.png`;
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
    await fs.writeFile(path.join(outputDir, "evidence.json"), JSON.stringify(manifest), "utf8");
    return manifest;
}
