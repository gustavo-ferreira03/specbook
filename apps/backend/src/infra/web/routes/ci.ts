import { access } from "../access";
import { publicFrontendOrigin } from "../security";
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
import { resolveRunEnvironment } from "../../../core/environments";
import { environmentsRepository } from "../../repositories/environments";
import { projectRunPolicy } from "../../../core/ci/targets";
import { NetworkTargetError } from "../../../core/network/targets";
import { backendRoot } from "../../../core/paths";
import { ResourceBusyError } from "../../../core/specs/lifecycle";
import { getRunBatch, listCiBatches, startSpecBatch } from "../../../core/runner/batch";
import { ciRepository } from "../../repositories/ci";
import { featuresRepository } from "../../repositories/features";
import { projectsRepository } from "../../repositories/projects";
import { specsRepository } from "../../repositories/specs";
import { stewardRepository } from "../../repositories/steward";

async function requireProject(id: string) {
    const project = await projectsRepository.getProject(id);
    if (!project) throw new HTTPException(404, { message: "Project not found" });
    return project;
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

async function acceptTrigger(c: Context, projectId: string, target?: string, name?: string) {
    const token = c.req.header("authorization")!.slice("Bearer ".length);
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    if (!await ciRepository.consumeRequest(projectId, tokenHash)) {
        c.header("Retry-After", String(60 - Math.floor(Date.now() / 1000) % 60));
        throw new HTTPException(429, { message: "CI trigger limit reached. Retry after the current minute." });
    }
    const project = await requireProject(projectId);
    try { const environment = await resolveRunEnvironment(projectId, name, target); await projectRunPolicy(project, environment.baseUrl, undefined, environment); return environment; }
    catch (error) {
        if (error instanceof NetworkTargetError) throw new HTTPException(400, { message: error.message });
        throw error;
    }
}

export function createCiSettingsRouter(): Hono {
    const router = new Hono();
    router.get("/projects/:id/ci", access("viewer"), async (c) => {
        const id = c.req.param("id");
        const project = await requireProject(id);
        c.header("Cache-Control", "no-store");
        return c.json({ environments: await environmentsRepository.list(id), token: await ciTokenInfo(id), batches: await Promise.all((await listCiBatches(id)).map((batch) => ciResult(batch, publicFrontendOrigin(c)))) });
    });
    router.post("/projects/:id/ci/token", access("editor"), async (c) => {
        const id = c.req.param("id");
        await requireProject(id);
        c.header("Cache-Control", "no-store");
        return c.json(await issueCiToken(id));
    });
    router.delete("/projects/:id/ci/token", access("editor"), async (c) => {
        await requireProject(c.req.param("id"));
        await ciRepository.revokeToken(c.req.param("id"));
        return c.body(null, 204);
    });
    return router;
}

export function createCiRouter(): Hono {
    const router = new Hono();
    router.get("/ci/projects/:id/client.mjs", access("ci-token"), projectAuth, async (c) => {
        c.header("Content-Type", "text/javascript; charset=utf-8");
        c.header("X-Content-Type-Options", "nosniff");
        return c.body(await fs.readFile(path.join(backendRoot, "scripts", "specbook-ci.mjs"), "utf8"));
    });
    router.post("/ci/projects/:id/runs", access("ci-token"), projectAuth, zValidator("json", ciRunSchema), async (c) => {
        const projectId = c.req.param("id");
        const input = c.req.valid("json");
        const environment = await acceptTrigger(c, projectId, input.baseUrl, input.environment);
        let specs = (await specsRepository.listSpecs(projectId)).filter((spec) => spec.lifecycle === "active");
        if (input.featureId) {
            const feature = await featuresRepository.getFeature(input.featureId);
            if (!feature || feature.projectId !== projectId) throw new HTTPException(400, { message: "Feature not found in this project" });
            const selected = new Set(await featuresRepository.getFeatureDeletionSpecIds(feature.id));
            specs = specs.filter((spec) => selected.has(spec.id));
        }
        if (input.specIds) {
            if (input.specIds.some((id) => !specs.some((spec) => spec.id === id))) throw new HTTPException(400, { message: "Selected checks must be active and belong to this project" });
            specs = specs.filter((spec) => input.specIds!.includes(spec.id));
        }
        // All/Feature runs include runnable Specs. Explicitly selected invalid Specs report their validation error.
        if (!input.specIds) specs = specs.filter((spec) => spec.status !== "invalid");
        try {
            const batch = await startSpecBatch(projectId, specs.map((spec) => spec.id), "CI run", {
                trigger: "ci",
                environment,
                rejectIfBusy: true,
                ci: { commitSha: input.commitSha, ref: input.ref, buildUrl: input.buildUrl, qualityGate: input.qualityGate, knownBugSpecIds: await knownBugSpecIds(projectId) },
            });
            c.header("Location", `/ci/runs/${batch.id}`);
            return c.json(await ciResult(batch, publicFrontendOrigin(c)), 202);
        } catch (error) {
            throw new HTTPException(error instanceof ResourceBusyError ? 409 : 400, { message: error instanceof Error ? error.message : String(error) });
        }
    });
    router.get("/ci/runs/:batchId", access("ci-token"), async (c) => {
        if (!c.req.header("authorization")) throw new HTTPException(401, { message: "A valid project CI bearer token is required" });
        const id = c.req.param("batchId");
        if (!z.string().uuid().safeParse(id).success) throw new HTTPException(404, { message: "CI batch not found" });
        let batch = await getRunBatch(id);
        if (!batch?.ci) throw new HTTPException(404, { message: "CI batch not found" });
        await authenticate(c, batch.projectId);
        const query = ciResultQuerySchema.safeParse(c.req.query());
        if (!query.success) throw new HTTPException(400, { message: "Invalid CI result query" });
        const { wait, format } = query.data;
        let result = await ciResult(batch, publicFrontendOrigin(c));
        const deadline = Date.now() + 25_000;
        while (wait === "true" && !result.complete && Date.now() < deadline && !c.req.raw.signal.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            await authenticate(c, batch.projectId);
            batch = await getRunBatch(id);
            if (!batch) throw new HTTPException(404, { message: "CI batch not found" });
            result = await ciResult(batch, publicFrontendOrigin(c));
        }
        if (format === "junit") return c.body(junitResult(result), 200, { "Content-Type": "application/xml; charset=utf-8" });
        if (format === "markdown") return c.body(markdownResult(result), 200, { "Content-Type": "text/markdown; charset=utf-8" });
        return c.json(result);
    });
    router.post("/ci/projects/:id/deploy", access("ci-token"), projectAuth, zValidator("json", deploySchema), async (c) => {
        const projectId = c.req.param("id");
        const input = c.req.valid("json");
        const environment = await acceptTrigger(c, projectId, input.url, input.environment);
        const hash = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
        const now = Date.now();
        const windowMs = 5 * 60_000;
        const key = input.commitSha ? hash : `${hash}:${Math.floor(now / windowMs)}`;
        if (!input.commitSha) {
            const recent = await stewardRepository.signals(projectId);
            if (recent.some((signal) => signal.key.startsWith(`deploy:${hash}:`) && Date.parse(signal.createdAt) > now - windowMs)) {
                return c.json({ accepted: true, duplicate: true }, 202);
            }
        }
        await stewardRepository.signal({ projectId, key: `deploy:${key}`, kind: "deployment",
            title: `Deployment completed${input.environment ? `: ${input.environment}` : ""}`,
            body: `A deployment completed. Run the relevant Specs, then investigate failures. ${input.url ? `Deployment URL: ${input.url}.` : ""}`,
            payload: { ...input, environment: environment.name, url: environment.baseUrl, environmentSnapshot: environment } });
        return c.json({ accepted: true }, 202);
    });
    return router;
}
