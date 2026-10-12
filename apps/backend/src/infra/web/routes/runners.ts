import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { RUNNER_PROTOCOL_VERSION, runnerClaimRequestSchema, runnerCompleteRequestSchema, runnerDisconnectSchema, runnerHeartbeatSchema, runnerReleaseSchema } from "@specbook/runtime/runner-protocol";
import { recordAudit } from "../../../core/accounts/audit";
import { authenticateRunnerToken, issueRunnerToken, publicRunner, runnerIsOutdated, runnerTokenSchema } from "../../../core/private-runner/tokens";
import { claimRunnerWork, completeRunnerWork, disconnectRunnerInstance, heartbeatRunnerWork, releaseRunnerWork, reportRunnerInstance, revokeRunnerToken, rotateRunnerToken, runnerLeaseMs } from "../../../core/private-runner/queue";
import { runnersRepository, type RunnerToken } from "../../repositories/runners";
import { access } from "../access";
import { runnerQueueSnapshot } from "../../../core/private-runner/visibility";
import { accessTokenFromHeaders } from "../../../core/accounts/sessions";
import { prometheusQueueMetrics, queueMetrics, runnerMetricsQuerySchema } from "../../../core/private-runner/metrics";

declare module "hono" {
    interface ContextVariableMap { runner: RunnerToken }
}

async function verifyRunner(c: Context): Promise<true> {
    const runner = await authenticateRunnerToken(c.req.header("authorization"));
    if (!runner) throw new HTTPException(401, { message: "Provide a valid runner token. Create one in Settings → Runners." });
    c.set("runner", runner);
    return true;
}

async function verifyMetrics(c: Context): Promise<true> {
    const runner = await authenticateRunnerToken(c.req.header("authorization"), false);
    if (runner) { c.set("runner", runner); return true; }
    const user = await accessTokenFromHeaders(c.req.raw.headers);
    if (!user || user.role !== "admin") throw new HTTPException(401, { message: "Provide a runner token or an admin access token for runner metrics." });
    c.set("user", user);
    c.set("authentication", "token");
    return true;
}

function requireSession(c: Context): void {
    if (c.get("authentication") !== "session") throw new HTTPException(403, { message: "Sign in to the web app to manage runner tokens." });
}

const upgradeMessage = `Runner protocol is incompatible with this server (requires ${RUNNER_PROTOCOL_VERSION}). Upgrade the CLI from this server's /cli/specbook.tgz and restart the runner.`;

function requireProtocol(version: number): void {
    if (version !== RUNNER_PROTOCOL_VERSION) throw new HTTPException(426, { message: upgradeMessage });
}

export function createRunnersRouter(): Hono {
    const router = new Hono();
    router.get("/runner/metrics", access("runner-token", verifyMetrics), zValidator("query", runnerMetricsQuerySchema), async (c) => {
        const { group, format } = c.req.valid("query");
        const runner = c.get("runner");
        const queues = (await runnerQueueSnapshot()).queues.filter((entry) =>
            (!runner || (entry.group === runner.group && (!runner.projectIds || runner.projectIds.includes(entry.projectId))))
            && (group === undefined || (entry.group ?? "") === group));
        const metrics = queueMetrics(queues);
        c.header("Cache-Control", "no-store");
        if (format === "prometheus") return c.body(prometheusQueueMetrics(metrics), 200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
        return c.json(metrics);
    });
    router.get("/runners/queue", access("admin"), async (c) => {
        c.header("Cache-Control", "no-store");
        return c.json({ queues: (await runnerQueueSnapshot()).queues });
    });
    router.get("/runners", access("admin"), async (c) => {
        const [tokens, instances] = await Promise.all([runnersRepository.list(), runnersRepository.instances()]);
        return c.json({ runners: tokens.map((token) => {
            const current = instances.filter((instance) => instance.runnerId === token.id && !instance.disconnectedAt && Date.now() - Date.parse(instance.lastSeenAt) < 90_000);
            return { ...publicRunner(token), online: current.length > 0, instances: current.map((instance) => ({ ...instance,
                outdated: runnerIsOutdated(instance.cliVersion, instance.protocolVersion) })) };
        }) });
    });
    router.post("/runners", access("admin"), zValidator("json", runnerTokenSchema), async (c) => {
        requireSession(c);
        const input = c.req.valid("json");
        const created = await issueRunnerToken(input.name, input.group, input.projectIds);
        await recordAudit("runner.token.created", { id: created.runner.id, name: created.runner.name, group: created.runner.group });
        c.header("Cache-Control", "no-store");
        return c.json(created, 201);
    });
    router.post("/runners/:id/rotate", access("admin"), async (c) => {
        requireSession(c);
        const created = await rotateRunnerToken(c.req.param("id"));
        await recordAudit("runner.token.rotated", { id: created.runner.id });
        c.header("Cache-Control", "no-store");
        return c.json(created);
    });
    router.delete("/runners/:id", access("admin"), async (c) => {
        requireSession(c);
        if (!await revokeRunnerToken(c.req.param("id"))) throw new HTTPException(404, { message: "Runner not found" });
        await recordAudit("runner.token.revoked", { id: c.req.param("id") });
        return c.json({ ok: true });
    });
    router.post("/runner/claim", access("runner-token", verifyRunner), zValidator("json", runnerClaimRequestSchema, (result) => {
        if (!result.success && result.error.issues.some((issue) => issue.path[0] === "protocolVersion")) throw new HTTPException(426, { message: upgradeMessage });
    }), async (c) => {
        const runner = c.get("runner");
        const input = c.req.valid("json");
        requireProtocol(input.protocolVersion);
        await reportRunnerInstance(runner, input);
        const job = await claimRunnerWork(runner, c.req.raw.signal, input.instanceId);
        c.header("Cache-Control", "no-store");
        return c.json({ runner: { id: runner.id, name: runner.name, group: runner.group }, lease: job ? {
            jobId: job.id, leaseId: job.leaseId!, leaseExpiresAt: job.leaseExpiresAt!, heartbeatMs: Math.min(60_000, Math.max(1000, Math.floor(runnerLeaseMs() / 4))), work: job.payload,
        } : null });
    });
    router.post("/runner/jobs/:id/heartbeat", access("runner-token", verifyRunner), zValidator("json", runnerHeartbeatSchema, (result) => {
        if (!result.success && result.error.issues.some((issue) => issue.path[0] === "protocolVersion")) throw new HTTPException(426, { message: upgradeMessage });
    }), async (c) => {
        const input = c.req.valid("json");
        requireProtocol(input.protocolVersion);
        await reportRunnerInstance(c.get("runner"), input);
        const leaseExpiresAt = await heartbeatRunnerWork(c.req.param("id"), c.get("runner").id, c.req.valid("json").leaseId);
        return c.json({ leaseExpiresAt });
    });
    router.post("/runner/disconnect", access("runner-token", verifyRunner), zValidator("json", runnerDisconnectSchema), async (c) => {
        await disconnectRunnerInstance(c.get("runner"), c.req.valid("json").instanceId);
        return c.json({ ok: true });
    });
    router.post("/runner/jobs/:id/release", access("runner-token", verifyRunner), zValidator("json", runnerReleaseSchema), async (c) => {
        await releaseRunnerWork(c.req.param("id"), c.get("runner").id, c.req.valid("json").leaseId);
        return c.json({ ok: true });
    });
    router.post("/runner/jobs/:id/complete", access("runner-token", verifyRunner), zValidator("json", runnerCompleteRequestSchema), async (c) => {
        await completeRunnerWork(c.req.param("id"), c.get("runner").id, c.req.valid("json"));
        return c.json({ ok: true });
    });
    return router;
}
