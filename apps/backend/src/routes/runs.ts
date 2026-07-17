import fs from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { runsDir } from "../core/paths";
import { executeSpec } from "../core/runner/robot";
import { getRun } from "../repositories/runs";
import { getSpecVersion } from "../repositories/specs";

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
    if (!(await getRun(runId))) throw new HTTPException(404, { message: "Run not found" });
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

    router.get("/runs/:id", async (c) => {
        const run = await getRun(c.req.param("id"));
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
        const run = await getRun(runId);
        if (!run) throw new HTTPException(404, { message: "Run not found" });
        const [version, directory] = await Promise.all([
            getSpecVersion(run.specVersionId),
            realRunDirectory(runId),
        ]);
        const files = directory ? await listArtifactFiles(directory) : [];
        const available = new Set(files);
        let manifest: { steps?: { number?: number; file?: string }[]; video?: string | null } = {};
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
                label: version?.humanSpec.steps[number - 1] ?? `Step ${number}`,
                file: item.file,
            }];
        });
        const video = typeof manifest?.video === "string" && available.has(manifest.video) ? manifest.video : null;
        return c.json({
            expectedResult: version?.humanSpec.expectedResult ?? "",
            steps,
            video,
            reportAvailable: available.has("report.html"),
        });
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
