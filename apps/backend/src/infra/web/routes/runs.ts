import fs from "node:fs/promises";
import path from "node:path";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { runsDir } from "../../../core/paths";
import { parseSpecMarkdown } from "../../../core/repo/markdown";
import { getRunBatch, getRunBatchDirectory, startSpecBatch } from "../../../core/runner/batch";
import { executeSpec } from "../../../core/runner/robot";
import { runsRepository } from "../../repositories/runs";
import { specsRepository } from "../../repositories/specs";

const CONTENT_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".xml": "text/xml; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webm": "video/webm",
    ".txt": "text/plain; charset=utf-8",
    ".robot": "text/plain; charset=utf-8",
};

const batchSchema = z.object({
    specIds: z.array(z.string().uuid()).min(1),
    label: z.string().trim().min(1).max(120),
});

function isInside(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function runDirectory(runId: string): string {
    const root = path.resolve(runsDir);
    const directory = path.resolve(root, runId);
    if (path.dirname(directory) !== root) throw new HTTPException(400, { message: "Invalid run id" });
    return directory;
}

async function realRunDirectory(runId: string): Promise<string | null> {
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

async function listArtifactFiles(directory: string, relative = ""): Promise<string[]> {
    const entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const artifact = relative ? path.posix.join(relative, entry.name) : entry.name;
        if (entry.isDirectory()) files.push(...(await listArtifactFiles(directory, artifact)));
        else if (entry.isFile()) files.push(artifact);
    }
    return files;
}

async function requireRun(runId: string): Promise<void> {
    if (!(await runsRepository.getRun(runId))) throw new HTTPException(404, { message: "Run not found" });
}

async function realBatchDirectory(batchId: string): Promise<string | null> {
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

async function batchReportAvailable(batchId: string): Promise<boolean> {
    const directory = await realBatchDirectory(batchId);
    return directory
        ? fs.stat(path.join(directory, "report.html")).then((stat) => stat.isFile()).catch(() => false)
        : false;
}

export function createRunsRouter(): Hono {
    const router = new Hono();

    router.post("/specs/:id/run", async (c) => {
        try {
            const run = await executeSpec(c.req.param("id"));
            return c.json({ run });
        } catch (error) {
            throw new HTTPException(400, { message: error instanceof Error ? error.message : String(error) });
        }
    });

    router.post("/projects/:id/run-batches", zValidator("json", batchSchema), async (c) => {
        try {
            const { specIds, label } = c.req.valid("json");
            const batch = await startSpecBatch(c.req.param("id"), specIds, label);
            return c.json({ batch }, 202);
        } catch (error) {
            throw new HTTPException(400, { message: error instanceof Error ? error.message : String(error) });
        }
    });

    router.get("/run-batches/:id", async (c) => {
        const batch = await getRunBatch(c.req.param("id"));
        if (!batch) throw new HTTPException(404, { message: "Run batch not found" });
        const reportAvailable = await batchReportAvailable(batch.id);
        return c.json({
            batch,
            reportUrl: reportAvailable ? `/run-batches/${encodeURIComponent(batch.id)}/artifacts/report.html` : null,
        });
    });

    router.get("/runs/:id", async (c) => {
        const run = await runsRepository.getRun(c.req.param("id"));
        if (!run) throw new HTTPException(404, { message: "Run not found" });
        return c.json({ run });
    });

    router.get("/runs/:id/artifacts", async (c) => {
        const runId = c.req.param("id");
        await requireRun(runId);
        const directory = await realRunDirectory(runId);
        return c.json({ files: directory ? await listArtifactFiles(directory) : [] });
    });

    router.get("/runs/:id/evidence", async (c) => {
        const runId = c.req.param("id");
        const run = await runsRepository.getRun(runId);
        if (!run) throw new HTTPException(404, { message: "Run not found" });
        const directory = await realRunDirectory(runId);
        const files = directory ? await listArtifactFiles(directory) : [];
        const available = new Set(files);
        const humanSpec = directory && available.has("spec.md")
            ? await fs.readFile(path.join(directory, "spec.md"), "utf8").then((source) => parseSpecMarkdown(source).humanSpec).catch(() => null)
            : null;
        let manifest: { steps?: { number?: number; label?: string; file?: string }[]; video?: string | null } = {};
        if (directory && available.has("evidence.json")) {
            try {
                manifest = JSON.parse(await fs.readFile(path.join(directory, "evidence.json"), "utf8"));
            } catch {}
        }
        const manifestSteps = Array.isArray(manifest?.steps) ? manifest.steps : [];
        const steps = manifestSteps.flatMap((item) => {
            if (!Number.isInteger(item.number) || !item.file || !available.has(item.file)) return [];
            const number = item.number as number;
            return [{
                number,
                label: typeof item.label === "string" && item.label.trim()
                    ? item.label
                    : humanSpec?.steps[number - 1] ?? `Step ${number}`,
                file: item.file,
            }];
        });
        const video = typeof manifest?.video === "string" && available.has(manifest.video) ? manifest.video : null;
        let reportUrl = available.has("report.html")
            ? `/runs/${encodeURIComponent(run.id)}/artifacts/report.html`
            : null;
        if (!reportUrl && directory && available.has("batch.json")) {
            try {
                const link = JSON.parse(await fs.readFile(path.join(directory, "batch.json"), "utf8")) as { batchId?: unknown };
                if (
                    typeof link.batchId === "string" &&
                    await getRunBatch(link.batchId) &&
                    await batchReportAvailable(link.batchId)
                ) {
                    reportUrl = `/run-batches/${encodeURIComponent(link.batchId)}/artifacts/report.html`;
                }
            } catch {}
        }
        return c.json({
            expectedResult: humanSpec?.expectedResult ?? "",
            steps,
            video,
            reportAvailable: reportUrl !== null,
            reportUrl,
        });
    });

    router.get("/run-batches/:id/artifacts/:file{.+}", async (c) => {
        const batchId = c.req.param("id");
        if (!(await getRunBatch(batchId))) throw new HTTPException(404, { message: "Run batch not found" });
        const directory = await realBatchDirectory(batchId);
        if (!directory) throw new HTTPException(404, { message: "Artifact not found" });
        const file = c.req.param("file");
        if (!file || file.includes("\0")) throw new HTTPException(400, { message: "Invalid artifact path" });
        const absolute = path.resolve(directory, file);
        if (!isInside(directory, absolute) || absolute === directory) {
            throw new HTTPException(400, { message: "Invalid artifact path" });
        }
        let realArtifact: string;
        try {
            realArtifact = await fs.realpath(absolute);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HTTPException(404, { message: "Artifact not found" });
            throw error;
        }
        if (!isInside(directory, realArtifact)) throw new HTTPException(400, { message: "Invalid artifact path" });
        const stat = await fs.stat(realArtifact);
        if (!stat.isFile()) throw new HTTPException(404, { message: "Artifact not found" });
        const data = await fs.readFile(realArtifact);
        const type = CONTENT_TYPES[path.extname(realArtifact).toLowerCase()] ?? "application/octet-stream";
        return c.body(new Uint8Array(data), 200, { "Content-Type": type });
    });

    router.get("/runs/:id/artifacts/:file{.+}", async (c) => {
        const runId = c.req.param("id");
        await requireRun(runId);
        const directory = await realRunDirectory(runId);
        if (!directory) throw new HTTPException(404, { message: "Artifact not found" });
        const file = c.req.param("file");
        if (!file || file.includes("\0")) throw new HTTPException(400, { message: "Invalid artifact path" });
        const absolute = path.resolve(directory, file);
        if (!isInside(directory, absolute) || absolute === directory) {
            throw new HTTPException(400, { message: "Invalid artifact path" });
        }
        let realArtifact: string;
        try {
            realArtifact = await fs.realpath(absolute);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                throw new HTTPException(404, { message: "Artifact not found" });
            }
            throw error;
        }
        if (!isInside(directory, realArtifact)) throw new HTTPException(400, { message: "Invalid artifact path" });
        const stat = await fs.stat(realArtifact);
        if (!stat.isFile()) throw new HTTPException(404, { message: "Artifact not found" });
        const data = await fs.readFile(realArtifact);
        const type = CONTENT_TYPES[path.extname(realArtifact).toLowerCase()] ?? "application/octet-stream";
        return c.body(new Uint8Array(data), 200, { "Content-Type": type });
    });

    return router;
}
