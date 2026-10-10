import { realRunDirectory, listArtifactFiles, readRunEvidence } from "../../../core/runner/artifacts";
import { access } from "../access";
import fs from "node:fs/promises";
import path from "node:path";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { getRunBatch, startSpecBatch } from "../../../core/runner/batch";
import { executeSpec } from "../../../core/runner/run";
import { MAX_RUN_LIST_LIMIT, runsRepository } from "../../repositories/runs";
import { specsRepository } from "../../repositories/specs";
import { isInside } from "../../../core/repo/safe-fs";
import { batchReport, runReport } from "../../../core/ci/report";
import { publicFrontendOrigin } from "../security";

const REPORT_HEADERS = { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox allow-popups allow-popups-to-escape-sandbox" };

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


const runListSchema = z.object({
    limit: z.coerce.number().int().min(1).max(MAX_RUN_LIST_LIMIT).optional(),
    before: z.string().uuid().optional(),
});

function artifactHeaders(type: string): Record<string, string> {
    return {
        "Content-Type": type,
        "Content-Security-Policy": type.startsWith("text/html") ? "sandbox allow-scripts" : "sandbox",
        "X-Content-Type-Options": "nosniff",
    };
}

const STORAGE_SHIM = Buffer.from(
    "<script>(function(){function m(){var d={};return{get length(){return Object.keys(d).length},key:function(i){return Object.keys(d)[i]??null},getItem:function(k){return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}}}}" +
        "[\"localStorage\",\"sessionStorage\"].forEach(function(n){try{window[n].length}catch(e){Object.defineProperty(window,n,{value:m(),configurable:true})}})})()</script>",
);

function withStorageShim(data: Buffer, type: string): Buffer {
    if (!type.startsWith("text/html")) return data;
    const head = /<head[^>]*>/i.exec(data.toString("latin1"));
    if (!head) return Buffer.concat([STORAGE_SHIM, data]);
    const at = head.index + head[0].length;
    return Buffer.concat([data.subarray(0, at), STORAGE_SHIM, data.subarray(at)]);
}

const batchSchema = z.object({
    environment: z.string().trim().min(1).max(80).optional(),
    specIds: z.array(z.string().uuid()).min(1),
    label: z.string().trim().min(1).max(120),
});

async function requireRun(runId: string): Promise<void> {
    if (!(await runsRepository.getRun(runId))) throw new HTTPException(404, { message: "Run not found" });
}

export function createRunsRouter(): Hono {
    const router = new Hono();

    router.post("/specs/:id/run", access("editor"), async (c) => {
        try {
            const run = await executeSpec(c.req.param("id"), { automate: true, environment: c.req.query("environment") });
            return c.json({ run });
        } catch (error) {
            throw new HTTPException(400, { message: error instanceof Error ? error.message : String(error) });
        }
    });

    router.post("/projects/:id/run-batches", access("editor"), zValidator("json", batchSchema), async (c) => {
        try {
            const { specIds, label, environment } = c.req.valid("json");
            const batch = await startSpecBatch(c.req.param("id"), specIds, label, { environment });
            return c.json({ batch }, 202);
        } catch (error) {
            throw new HTTPException(400, { message: error instanceof Error ? error.message : String(error) });
        }
    });

    router.get("/run-batches/:id", access("viewer"), async (c) => {
        const batch = await getRunBatch(c.req.param("id"));
        if (!batch) throw new HTTPException(404, { message: "Run batch not found" });
        return c.json({ batch, reportUrl: `/run-batches/${encodeURIComponent(batch.id)}/report` });
    });

    router.get("/run-batches/:id/report", access("viewer"), async (c) => {
        const batch = await getRunBatch(c.req.param("id"));
        if (!batch) throw new HTTPException(404, { message: "Run batch not found" });
        return c.body(await batchReport(batch, publicFrontendOrigin(c)), 200, REPORT_HEADERS);
    });

    router.get("/runs/:id/report", access("viewer"), async (c) => {
        const run = await runsRepository.getRun(c.req.param("id"));
        const spec = run ? await specsRepository.getSpec(run.specId) : null;
        if (!run || !spec) throw new HTTPException(404, { message: "Run not found" });
        return c.body(await runReport(run, spec, publicFrontendOrigin(c)), 200, REPORT_HEADERS);
    });

    router.get("/specs/:id/runs", access("viewer"), zValidator("query", runListSchema), async (c) => {
        const spec = await specsRepository.getSpec(c.req.param("id"));
        if (!spec) throw new HTTPException(404, { message: "Spec not found" });
        const { limit, before } = c.req.valid("query");
        return c.json({ runs: await runsRepository.listRuns(spec.id, { limit, before }) });
    });

    router.get("/runs/:id", access("viewer"), async (c) => {
        const run = await runsRepository.getRun(c.req.param("id"));
        if (!run) throw new HTTPException(404, { message: "Run not found" });
        return c.json({ run });
    });

    router.get("/runs/:id/artifacts", access("viewer"), async (c) => {
        const runId = c.req.param("id");
        await requireRun(runId);
        const directory = await realRunDirectory(runId);
        return c.json({ files: directory ? await listArtifactFiles(directory) : [] });
    });

    router.get("/runs/:id/evidence", access("viewer"), async (c) => c.json(await readRunEvidence(c.req.param("id"))));

    router.get("/runs/:id/artifacts/:file{.+}", access("viewer"), async (c) => {
        const runId = c.req.param("id");
        await requireRun(runId);
        const directory = await realRunDirectory(runId);
        if (!directory) throw new HTTPException(404, { message: "Artifact not found" });
        const file = c.req.param("file");
        if (!file || file.includes("\0")) throw new HTTPException(400, { message: "Invalid artifact path" });
        const absolute = path.resolve(directory, file);
        if (!isInside(directory, absolute, { allowRoot: true }) || absolute === directory) {
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
        if (!isInside(directory, realArtifact, { allowRoot: true })) throw new HTTPException(400, { message: "Invalid artifact path" });
        const stat = await fs.stat(realArtifact);
        if (!stat.isFile()) throw new HTTPException(404, { message: "Artifact not found" });
        const data = await fs.readFile(realArtifact);
        const type = CONTENT_TYPES[path.extname(realArtifact).toLowerCase()] ?? "application/octet-stream";
        return c.body(new Uint8Array(withStorageShim(data, type)), 200, artifactHeaders(type));
    });

    return router;
}
