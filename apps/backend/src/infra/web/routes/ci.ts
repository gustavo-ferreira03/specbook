import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { zValidator } from "@hono/zod-validator";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { authenticateCiToken, ciTokenInfo, issueCiToken } from "../../../core/ci/tokens";
import { ciRunSchema, ciResultQuerySchema, deploySchema } from "../../../core/ci/schemas";
import { ciResult, junitResult, knownBugSpecIds, markdownResult } from "../../../core/ci/results";
import { backendRoot } from "../../../core/paths";
import { ResourceBusyError } from "../../../core/specs/lifecycle";
import { getRunBatch, listCiBatches, startSpecBatch } from "../../../core/runner/batch";
import { ciRepository } from "../../repositories/ci";
import { featuresRepository } from "../../repositories/features";
import { projectsRepository } from "../../repositories/projects";
import { specsRepository } from "../../repositories/specs";
import { stewardRepository } from "../../repositories/steward";

async function requireProject(id: string) {
    if (!await projectsRepository.getProject(id)) throw new HTTPException(404, { message: "Project not found" });
}

async function authenticate(c: Context, projectId: string) {
    if (!await authenticateCiToken(projectId, c.req.header("authorization"))) {
        throw new HTTPException(401, { message: "A valid project CI bearer token is required" });
    }
    c.header("Cache-Control", "no-store");
}

const projectAuth: MiddlewareHandler = async (c, next) => {
    await authenticate(c, c.req.param("id")!);
    await next();
};

export function createCiSettingsRouter(): Hono {
    const router = new Hono();
    router.get("/projects/:id/ci", async (c) => {
        const id = c.req.param("id");
        await requireProject(id);
        c.header("Cache-Control", "no-store");
        return c.json({ token: await ciTokenInfo(id), batches: await Promise.all((await listCiBatches(id)).map(ciResult)) });
    });
    router.post("/projects/:id/ci/token", async (c) => {
        const id = c.req.param("id");
        await requireProject(id);
        c.header("Cache-Control", "no-store");
        return c.json(await issueCiToken(id));
    });
    router.delete("/projects/:id/ci/token", async (c) => {
        await requireProject(c.req.param("id"));
        await ciRepository.revokeToken(c.req.param("id"));
        return c.body(null, 204);
    });
    return router;
}

export function createCiRouter(): Hono {
    const router = new Hono();
    router.get("/ci/projects/:id/client.mjs", projectAuth, async (c) => {
        c.header("Content-Type", "text/javascript; charset=utf-8");
        c.header("X-Content-Type-Options", "nosniff");
        return c.body(await fs.readFile(path.join(backendRoot, "scripts", "specbook-ci.mjs"), "utf8"));
    });
    router.post("/ci/projects/:id/runs", projectAuth, zValidator("json", ciRunSchema), async (c) => {
        const projectId = c.req.param("id");
        const input = c.req.valid("json");
        let specs = await specsRepository.listSpecs(projectId);
        if (input.featureId) {
            const feature = await featuresRepository.getFeature(input.featureId);
            if (!feature || feature.projectId !== projectId) throw new HTTPException(400, { message: "Feature not found in this project" });
            const selected = new Set(await featuresRepository.getFeatureDeletionSpecIds(feature.id));
            specs = specs.filter((spec) => selected.has(spec.id));
        }
        if (input.specIds) {
            if (input.specIds.some((id) => !specs.some((spec) => spec.id === id))) throw new HTTPException(400, { message: "Selected Specs must belong to this project" });
            specs = specs.filter((spec) => input.specIds!.includes(spec.id));
        }
        // All/Feature runs include runnable Specs. Explicitly selected invalid Specs report their validation error.
        if (!input.specIds) specs = specs.filter((spec) => spec.status !== "invalid");
        try {
            const batch = await startSpecBatch(projectId, specs.map((spec) => spec.id), "CI run", {
                trigger: "ci",
                baseUrl: input.baseUrl,
                rejectIfBusy: true,
                ci: { commitSha: input.commitSha, ref: input.ref, buildUrl: input.buildUrl, qualityGate: input.qualityGate, knownBugSpecIds: await knownBugSpecIds(projectId) },
            });
            c.header("Location", `/ci/runs/${batch.id}`);
            return c.json(await ciResult(batch), 202);
        } catch (error) {
            throw new HTTPException(error instanceof ResourceBusyError ? 409 : 400, { message: error instanceof Error ? error.message : String(error) });
        }
    });
    router.get("/ci/runs/:batchId", async (c) => {
        if (!c.req.header("authorization")) throw new HTTPException(401, { message: "A valid project CI bearer token is required" });
        const id = c.req.param("batchId");
        if (!z.string().uuid().safeParse(id).success) throw new HTTPException(404, { message: "CI batch not found" });
        let batch = await getRunBatch(id);
        if (!batch?.ci) throw new HTTPException(404, { message: "CI batch not found" });
        await authenticate(c, batch.projectId);
        const query = ciResultQuerySchema.safeParse(c.req.query());
        if (!query.success) throw new HTTPException(400, { message: "Invalid CI result query" });
        const { wait, format } = query.data;
        let result = await ciResult(batch);
        const deadline = Date.now() + 25_000;
        while (wait === "true" && !result.complete && Date.now() < deadline && !c.req.raw.signal.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            await authenticate(c, batch.projectId);
            batch = await getRunBatch(id);
            if (!batch) throw new HTTPException(404, { message: "CI batch not found" });
            result = await ciResult(batch);
        }
        if (format === "junit") return c.body(junitResult(result), 200, { "Content-Type": "application/xml; charset=utf-8" });
        if (format === "markdown") return c.body(markdownResult(result), 200, { "Content-Type": "text/markdown; charset=utf-8" });
        return c.json(result);
    });
    router.post("/ci/projects/:id/deploy", projectAuth, zValidator("json", deploySchema), async (c) => {
        const projectId = c.req.param("id");
        const input = c.req.valid("json");
        const key = input.commitSha
            ? crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex")
            : crypto.randomUUID();
        await stewardRepository.signal({ projectId, key: `deploy:${key}`, kind: "deployment",
            title: `Deployment completed${input.environment ? `: ${input.environment}` : ""}`,
            body: `A deployment completed. Run the relevant Specs, then investigate failures. ${input.url ? `Deployment URL: ${input.url}.` : ""}`,
            payload: input });
        return c.json({ accepted: true }, 202);
    });
    return router;
}
