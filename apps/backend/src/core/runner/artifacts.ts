import fs from "node:fs/promises";
import path from "node:path";
import { HTTPException } from "hono/http-exception";
import { runsRepository } from "../../infra/repositories/runs";
import { runsDir } from "../paths";
import { parseSpecYaml } from "../repo/yaml";
import { getRunBatch, getRunBatchDirectory } from "./batch";
import { readEvidenceManifest, type EvidenceManifest } from "./evidence";
export { isInside } from "../repo/safe-fs";

export const REPORT_FILE = "report/index.html";

function runDirectory(runId: string): string {
    const root = path.resolve(runsDir);
    const directory = path.resolve(root, runId);
    if (path.dirname(directory) !== root) throw new HTTPException(400, { message: "Invalid run id" });
    return directory;
}

export async function realRunDirectory(runId: string): Promise<string | null> {
    const directory = runDirectory(runId);
    try {
        const [root, realDirectory] = await Promise.all([fs.realpath(runsDir), fs.realpath(directory)]);
        if (realDirectory !== path.join(root, runId)) throw new HTTPException(400, { message: "Invalid artifact path" });
        return realDirectory;
    } catch (error) {
        if (error instanceof HTTPException) throw error;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

export async function listArtifactFiles(directory: string, relative = ""): Promise<string[]> {
    const entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const artifact = relative ? path.posix.join(relative, entry.name) : entry.name;
        if (entry.isDirectory()) files.push(...(await listArtifactFiles(directory, artifact)));
        else if (entry.isFile()) files.push(artifact);
    }
    return files;
}

export async function realBatchDirectory(batchId: string): Promise<string | null> {
    const directory = getRunBatchDirectory(batchId);
    try {
        const [root, realDirectory] = await Promise.all([fs.realpath(path.dirname(directory)), fs.realpath(directory)]);
        if (realDirectory !== path.join(root, batchId)) throw new HTTPException(400, { message: "Invalid artifact path" });
        return realDirectory;
    } catch (error) {
        if (error instanceof HTTPException) throw error;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

export async function batchReportAvailable(batchId: string): Promise<boolean> {
    const directory = await realBatchDirectory(batchId);
    return directory
        ? fs.stat(path.join(directory, REPORT_FILE)).then((stat) => stat.isFile()).catch(() => false)
        : false;
}

export async function readRunEvidence(runId: string) {
    const run = await runsRepository.getRun(runId);
    if (!run) throw new HTTPException(404, { message: "Run not found" });
    const directory = await realRunDirectory(runId);
    const files = directory ? await listArtifactFiles(directory) : [];
    const available = new Set(files);
    const humanSpec = directory && available.has("spec.yml")
        ? await fs.readFile(path.join(directory, "spec.yml"), "utf8").then((source) => parseSpecYaml(source).humanSpec).catch(() => null)
        : null;
    const manifest: EvidenceManifest = directory ? await readEvidenceManifest(directory) : { steps: [], video: null, failedStep: null };
    const steps = manifest.steps.flatMap((item) => {
        if (!available.has(item.file)) return [];
        const number = item.number;
        return [{
            number,
            label: item.label.trim()
                ? item.label
                : humanSpec?.steps[number - 1] ?? `Step ${number}`,
            file: item.file,
        }];
    });
    const video = manifest.video !== null && available.has(manifest.video) ? manifest.video : null;
    let reportUrl = available.has(REPORT_FILE)
        ? `/runs/${encodeURIComponent(run.id)}/artifacts/${REPORT_FILE}`
        : null;
    if (!reportUrl && directory && available.has("batch.json")) {
        try {
            const link = JSON.parse(await fs.readFile(path.join(directory, "batch.json"), "utf8")) as { batchId?: unknown };
            if (
                typeof link.batchId === "string" &&
                await getRunBatch(link.batchId) &&
                await batchReportAvailable(link.batchId)
            ) {
                reportUrl = `/run-batches/${encodeURIComponent(link.batchId)}/artifacts/${REPORT_FILE}`;
            }
        } catch {}
    }
    return {
        expectedResult: humanSpec?.expectedResult ?? "",
        steps,
        video,
        failedStep: manifest.failedStep,
        reportAvailable: reportUrl !== null,
        reportUrl,
        diagnostics: manifest.diagnostics ?? [],
        apiSteps: manifest.apiSteps ?? [],
        environment: run.environment,
        errorContext: manifest.errorContext ?? null,
    };
}

