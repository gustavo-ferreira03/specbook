import { acceptCiTrigger, CiRequestError, startCiRun } from "../../../core/ci/runs";
import { access, type BearerVerifier } from "../access";
import { loadProject } from "../load-project";
import { publicFrontendOrigin } from "../security";
import fs from "node:fs/promises";
import path from "node:path";
import { zValidator } from "@hono/zod-validator";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { authenticateCiToken, ciTokenInfo, issueCiToken } from "../../../core/ci/tokens";
import { ciRunSchema, ciResultQuerySchema, deploySchema } from "../../../core/ci/schemas";
import { ciResult, junitResult, markdownResult } from "../../../core/ci/results";
import { htmlReport } from "../../../core/ci/report";
import { environmentsRepository } from "../../repositories/environments";
import { backendRoot } from "../../../core/paths";
import { getRunBatch, listCiBatches } from "../../../core/runner/batch";
import { ciRepository } from "../../repositories/ci";
import { stewardRepository } from "../../repositories/steward";
import { fingerprint } from "../../../core/steward/signals";

async function authenticate(c: Context, projectId: string) {
    if (!await authenticateCiToken(projectId, c.req.header("authorization"))) {
        throw new HTTPException(401, { message: "A valid project CI bearer token is required" });
    }
    c.header("Cache-Control", "no-store");
}

const rejectCi = () => Response.json({ error: "A valid project CI bearer token is required" }, { status: 401 });

const verifyCiToken: BearerVerifier = async (c) => {
    const authorization = c.req.header("authorization");
    const projectId = c.req.path.match(/^\/ci\/projects\/([0-9a-f-]{36})\//i)?.[1];
    if (projectId) return await authenticateCiToken(projectId, authorization) ? true : rejectCi();
    const batchId = c.req.path.match(/^\/ci\/runs\/([0-9a-f-]{36})$/i)?.[1];
    const batch = batchId ? await getRunBatch(batchId) : null;
    if (!batch?.ci) return Response.json({ error: "CI batch not found" }, { status: 404 });
    return await authenticateCiToken(batch.projectId, authorization) ? true : rejectCi();
};

const projectAuth: MiddlewareHandler = async (c, next) => {
    await authenticate(c, c.req.param("id")!);
    await next();
};

function ciError(c: Context, error: unknown): never {
    if (error instanceof CiRequestError) {
        if (error.retryAfter) c.header("Retry-After", String(error.retryAfter));
        throw new HTTPException(error.status, { message: error.message });
    }
    throw error;
}

async function acceptTrigger(c: Context, projectId: string, target?: string, name?: string) {
    return acceptCiTrigger(projectId, c.req.header("authorization")!, target, name).catch((error) => ciError(c, error));
}

export function createCiSettingsRouter(): Hono {
    const router = new Hono();
    router.get("/projects/:id/ci", access("viewer"), async (c) => {
        const id = c.req.param("id");
        const project = await loadProject(id);
        c.header("Cache-Control", "no-store");
        return c.json({ environments: await environmentsRepository.list(id), token: await ciTokenInfo(id), batches: await Promise.all((await listCiBatches(id)).map((batch) => ciResult(batch, publicFrontendOrigin(c)))) });
    });
    router.post("/projects/:id/ci/token", access("editor"), async (c) => {
        const id = c.req.param("id");
        await loadProject(id);
        c.header("Cache-Control", "no-store");
        return c.json(await issueCiToken(id));
    });
    router.delete("/projects/:id/ci/token", access("editor"), async (c) => {
        await loadProject(c.req.param("id"));
        await ciRepository.revokeToken(c.req.param("id"));
        return c.body(null, 204);
    });
    return router;
}

export function createCiRouter(): Hono {
    const router = new Hono();
    router.get("/ci/projects/:id/client.mjs", access("ci-token", verifyCiToken), projectAuth, async (c) => {
        c.header("Content-Type", "text/javascript; charset=utf-8");
        c.header("X-Content-Type-Options", "nosniff");
        return c.body(await fs.readFile(path.join(backendRoot, "scripts", "specbook-ci.mjs"), "utf8"));
    });
    router.post("/ci/projects/:id/runs", access("ci-token", verifyCiToken), projectAuth, zValidator("json", ciRunSchema), async (c) => {
        const projectId = c.req.param("id");
        const input = c.req.valid("json");
        const batch = await startCiRun(projectId, c.req.header("authorization")!, input).catch((error) => ciError(c, error));
        c.header("Location", `/ci/runs/${batch.id}`);
        return c.json(await ciResult(batch, publicFrontendOrigin(c)), 202);
    });
    router.get("/ci/runs/:batchId", access("ci-token", verifyCiToken), async (c) => {
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
        if (format === "html") return c.body(await htmlReport(result), 200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox allow-popups allow-popups-to-escape-sandbox" });
        return c.json(result);
    });
    router.post("/ci/projects/:id/deploy", access("ci-token", verifyCiToken), projectAuth, zValidator("json", deploySchema), async (c) => {
        const projectId = c.req.param("id");
        const input = c.req.valid("json");
        const environment = await acceptTrigger(c, projectId, input.url, input.environment);
        const hash = fingerprint(input);
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
