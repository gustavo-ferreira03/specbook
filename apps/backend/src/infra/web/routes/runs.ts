import fs from "node:fs/promises";
import path from "node:path";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { runsDir } from "../../../core/paths";
import { parseSpecYaml } from "../../../core/repo/yaml";
import { getRunBatch, getRunBatchDirectory, startSpecBatch } from "../../../core/runner/batch";
import { executeSpec } from "../../../core/runner/run";
import { MAX_RUN_LIST_LIMIT, runsRepository } from "../../repositories/runs";
import { specsRepository } from "../../repositories/specs";

/** Run artifacts, including the files of Playwright's HTML report (report/). */
const CONTENT_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webm": "video/webm",
    ".zip": "application/zip",
    ".ttf": "font/ttf",
    ".webmanifest": "application/manifest+json",
    ".md": "text/plain; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".ts": "text/plain; charset=utf-8",
    ".yml": "text/plain; charset=utf-8",
};

/** Entry page of the Playwright HTML report inside a run or batch directory. */
export const REPORT_FILE = "report/index.html";

const runListSchema = z.object({
    limit: z.coerce.number().int().min(1).max(MAX_RUN_LIST_LIMIT).optional(),
    before: z.string().uuid().optional(),
});

/**
 * Artifacts may contain page content from the application under test: never run it with
 * the API origin. The sandbox (without allow-same-origin) gives HTML an opaque origin;
 * allow-scripts is needed because Playwright's HTML report is a script-rendered page.
 */
function artifactHeaders(type: string): Record<string, string> {
    return {
        "Content-Type": type,
        "Content-Security-Policy": type.startsWith("text/html") ? "sandbox allow-scripts" : "sandbox",
        "X-Content-Type-Options": "nosniff",
    };
}

// The sandboxed report has an opaque origin, where reading localStorage throws, and
// Playwright's report reads it while booting. Give HTML artifacts in-memory storage
// instead of granting allow-same-origin.
const STORAGE_SHIM = Buffer.from(
    "<script>(function(){function m(){var d={};return{get length(){return Object.keys(d).length},key:function(i){return Object.keys(d)[i]??null},getItem:function(k){return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}}}}" +
        "[\"localStorage\",\"sessionStorage\"].forEach(function(n){try{window[n].length}catch(e){Object.defineProperty(window,n,{value:m(),configurable:true})}})})()</script>",
);

function withStorageShim(data: Buffer, type: string): Buffer {
    if (!type.startsWith("text/html")) return data;
    // Insert right after <head> so the doctype stays first and the page keeps standards mode.
    const head = /<head[^>]*>/i.exec(data.toString("latin1"));
    if (!head) return Buffer.concat([STORAGE_SHIM, data]);
    const at = head.index + head[0].length;
    return Buffer.concat([data.subarray(0, at), STORAGE_SHIM, data.subarray(at)]);
}

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
        ? fs.stat(path.join(directory, REPORT_FILE)).then((stat) => stat.isFile()).catch(() => false)
        : false;
}

export function createRunsRouter(): Hono {
    const router = new Hono();

    router.post("/specs/:id/run", async (c) => {
        try {
            const run = await executeSpec(c.req.param("id"), { automate: true });
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
            reportUrl: reportAvailable ? `/run-batches/${encodeURIComponent(batch.id)}/artifacts/${REPORT_FILE}` : null,
        });
    });

    router.get("/specs/:id/runs", zValidator("query", runListSchema), async (c) => {
        const spec = await specsRepository.getSpec(c.req.param("id"));
        if (!spec) throw new HTTPException(404, { message: "Spec not found" });
        const { limit, before } = c.req.valid("query");
        return c.json({ runs: await runsRepository.listRuns(spec.id, { limit, before }) });
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
        const humanSpec = directory && available.has("spec.yml")
            ? await fs.readFile(path.join(directory, "spec.yml"), "utf8").then((source) => parseSpecYaml(source).humanSpec).catch(() => null)
            : null;
        let manifest: {
            steps?: { number?: number; label?: string; file?: string }[];
            video?: string | null;
            failedStep?: string | null;
            diagnostics?: import("../../../core/runner/evidence").RunDiagnostic[];
            errorContext?: string;
        } = {};
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
        return c.json({
            expectedResult: humanSpec?.expectedResult ?? "",
            steps,
            video,
            failedStep: typeof manifest?.failedStep === "string" ? manifest.failedStep : null,
            reportAvailable: reportUrl !== null,
            reportUrl,
            diagnostics: manifest.diagnostics ?? [],
            errorContext: manifest.errorContext ?? null,
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
        return c.body(new Uint8Array(withStorageShim(data, type)), 200, artifactHeaders(type));
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
        return c.body(new Uint8Array(withStorageShim(data, type)), 200, artifactHeaders(type));
    });

    return router;
}
