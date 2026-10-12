import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { runnerClaimRequestSchema, runnerCompleteRequestSchema, runnerHeartbeatSchema, runnerReleaseSchema } from "@specbook/runtime/runner-protocol";
import { recordAudit } from "../../../core/accounts/audit";
import { authenticateRunnerToken, issueRunnerToken, publicRunner, runnerTokenSchema } from "../../../core/private-runner/tokens";
import { claimRunnerWork, completeRunnerWork, heartbeatRunnerWork, releaseRunnerWork, revokeRunnerToken, runnerLeaseMs } from "../../../core/private-runner/queue";
import { runnersRepository, type RunnerToken } from "../../repositories/runners";
import { access } from "../access";

declare module "hono" {
    interface ContextVariableMap { runner: RunnerToken }
}

async function verifyRunner(c: Context): Promise<true> {
    const runner = await authenticateRunnerToken(c.req.header("authorization"));
    if (!runner) throw new HTTPException(401, { message: "Provide a valid runner token. Create one in Settings → Runners." });
    c.set("runner", runner);
    return true;
}

function requireSession(c: Context): void {
    if (c.get("authentication") !== "session") throw new HTTPException(403, { message: "Sign in to the web app to manage runner tokens." });
}

export function createRunnersRouter(): Hono {
    const router = new Hono();
    router.get("/runners", access("admin"), async (c) => c.json({ runners: (await runnersRepository.list()).map(publicRunner) }));
    router.post("/runners", access("admin"), zValidator("json", runnerTokenSchema), async (c) => {
        requireSession(c);
        const input = c.req.valid("json");
        const created = await issueRunnerToken(input.name, input.group);
        await recordAudit("runner.token.created", { id: created.runner.id, name: created.runner.name, group: created.runner.group });
        c.header("Cache-Control", "no-store");
        return c.json(created, 201);
    });
    router.delete("/runners/:id", access("admin"), async (c) => {
        requireSession(c);
        if (!await revokeRunnerToken(c.req.param("id"))) throw new HTTPException(404, { message: "Runner not found" });
        await recordAudit("runner.token.revoked", { id: c.req.param("id") });
        return c.json({ ok: true });
    });
    router.post("/runner/claim", access("runner-token", verifyRunner), zValidator("json", runnerClaimRequestSchema), async (c) => {
        const runner = c.get("runner");
        const job = await claimRunnerWork(runner, c.req.raw.signal);
        c.header("Cache-Control", "no-store");
        return c.json({ runner: { id: runner.id, name: runner.name, group: runner.group }, lease: job ? {
            jobId: job.id, leaseId: job.leaseId!, leaseExpiresAt: job.leaseExpiresAt!, heartbeatMs: Math.min(60_000, Math.max(1000, Math.floor(runnerLeaseMs() / 4))), work: job.payload,
        } : null });
    });
    router.post("/runner/jobs/:id/heartbeat", access("runner-token", verifyRunner), zValidator("json", runnerHeartbeatSchema), async (c) => {
        const leaseExpiresAt = await heartbeatRunnerWork(c.req.param("id"), c.get("runner").id, c.req.valid("json").leaseId);
        return c.json({ leaseExpiresAt });
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
