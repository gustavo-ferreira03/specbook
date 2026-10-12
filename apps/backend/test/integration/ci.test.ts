import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { before, describe, test } from "node:test";
import { Hono } from "hono";
import { HUMAN_SPEC, useTempStorage, VALID_SPEC } from "../helpers/storage";

const storage = useTempStorage();
const { runMigrations } = await import("../../src/infra/db/migrate");
const { projectsRepository } = await import("../../src/infra/repositories/projects");
const { environmentsRepository } = await import("../../src/infra/repositories/environments");
const { featuresRepository } = await import("../../src/infra/repositories/features");
const { specsRepository } = await import("../../src/infra/repositories/specs");
const { runsRepository } = await import("../../src/infra/repositories/runs");
const { ciRepository } = await import("../../src/infra/repositories/ci");
const { stewardRepository } = await import("../../src/infra/repositories/steward");
const { issueGitAccessToken } = await import("../../src/core/repo/access");
const { issueCiToken, authenticateCiToken } = await import("../../src/core/ci/tokens");
const { ciResult, junitResult, markdownResult } = await import("../../src/core/ci/results");
const { ciRunSchema } = await import("../../src/core/ci/schemas");
const { environmentSchema } = await import("../../src/core/environments");
const { getRunBatchDirectory, getRunBatch, listRunBatches, listCiBatches } = await import("../../src/core/runner/batch");
const { createCiRouter, createCiSettingsRouter } = await import("../../src/infra/web/routes/ci");
const { createEnvironmentsRouter } = await import("../../src/infra/web/routes/environments");
const { buildHostAllowlist, csrfGuard, hostGuard, jsonBodyLimit } = await import("../../src/infra/web/security");
const { runnersRepository } = await import("../../src/infra/repositories/runners");
const { issueRunnerToken, authenticateRunnerToken, publicRunner } = await import("../../src/core/private-runner/tokens");
const { enqueueRunnerBatch, completeRunnerWork, heartbeatRunnerWork, pendingRunnerBatchIds, releaseRunnerWork, revokeRunnerToken } = await import("../../src/core/private-runner/queue");

before(runMigrations);
const app = new Hono();
app.use("*", hostGuard(buildHostAllowlist(4000, {})), csrfGuard(), jsonBodyLimit());
app.route("/", createCiRouter());
app.route("/", createCiSettingsRouter());
app.route("/", createEnvironmentsRouter());
const browserHeaders = { Host: "localhost:4000", "X-Specbook-Request": "1" };

async function fixture() {
    const project = await projectsRepository.createProject("CI", "https://8.8.8.8");
    const feature = await featuresRepository.createFeature(project.id, null, "Checkout", "", "features/checkout");
    const spec = await specsRepository.createSpecRecord({ projectId: project.id, featureId: feature.id, title: "A <checkout> | test", description: "", path: "specs/checkout", sourceHash: "source", markdownHash: "markdown" });
    const run = await runsRepository.createRun({ specId: spec.id, sourceHash: "source", commitSha: "sha", automate: true });
    await runsRepository.finishRun(run.id, "failed", 100, 'Expected <heading> & "checkout"');
    const batch = { id: crypto.randomUUID(), projectId: project.id, label: "CI", baseUrl: "https://preview.example.com", status: "failed" as const, startedAt: new Date().toISOString(), durationMs: 100, failReason: null,
        ci: { commitSha: "abc123", ref: "refs/heads/main", qualityGate: { failOnFlaky: false, failOnKnownBugs: false }, knownBugSpecIds: [] as string[] },
        specs: [{ runId: run.id, specId: spec.id, commitSha: "sha", sourceHash: "source", markdownHash: "markdown", title: spec.title, status: "failed" as const, durationMs: 100, failReason: run.failReason }] };
    const directory = getRunBatchDirectory(batch.id);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "batch.json"), JSON.stringify(batch));
    return { project, spec, run, batch };
}

describe("CI access and quality gates", () => {
    test("tunnel environments keep vault access and require matching group and project token scope", async () => {
        const { configuredTunnel, waitForTunnel, tunnelQueueEntries } = await import("../../src/core/tunnel/registry");
        const { resolveRunEnvironment } = await import("../../src/core/environments");
        const project = await projectsRepository.createProject("Private tunnel", "http://internal.example.test:4598");
        assert.equal(environmentSchema.safeParse({ name: "Private", baseUrl: project.baseUrl, executor: "tunnel" }).success, false);
        const input = environmentSchema.parse({ name: "Production", baseUrl: project.baseUrl, executor: "tunnel", runnerGroup: "tunnel", credentialOverrides: { shop: crypto.randomUUID() } });
        const previous = (await environmentsRepository.list(project.id))[0]!;
        await environmentsRepository.update(previous, input);
        const environment = await resolveRunEnvironment(project.id);
        assert.deepEqual(environment.credentialOverrides, input.credentialOverrides);
        const allowed = await issueRunnerToken("Tunnel", "tunnel", [project.id]);
        const wrongGroup = await issueRunnerToken("Other group", "other", [project.id]);
        const anotherProject = await projectsRepository.createProject("Another project", "https://example.com");
        const wrongProject = await issueRunnerToken("Other project", "tunnel", [anotherProject.id]);
        const runner = (await runnersRepository.get(allowed.runner.id))!;
        const configured = await configuredTunnel(runner, project.id, environment.id);
        assert.deepEqual(configured.origins, ["http://internal.example.test:4598"]);
        await assert.rejects(async () => configuredTunnel((await runnersRepository.get(wrongGroup.runner.id))!, project.id, environment.id), /runner group/);
        await assert.rejects(async () => configuredTunnel((await runnersRepository.get(wrongProject.runner.id))!, project.id, environment.id), /project/);
        const abort = new AbortController();
        const runId = crypto.randomUUID();
        const waiting = waitForTunnel(environment, project.id, [runId], abort.signal);
        const queue = (await tunnelQueueEntries()).find((entry) => entry.environmentId === environment.id)!;
        assert.equal(queue.queued, 1);
        assert.equal(queue.reason, "No tunnel connected in group tunnel.");
        abort.abort(new Error("Verification stopped"));
        await assert.rejects(waiting, /Verification stopped/);
        assert.ok(!(await tunnelQueueEntries()).some((entry) => entry.environmentId === environment.id));
        for (const token of [allowed, wrongGroup, wrongProject]) await revokeRunnerToken(token.runner.id);
    });

    test("restart preserves tunnel runs queued before browser execution", async () => {
        const { pendingTunnelBatchRunIds } = await import("../../src/core/runner/batch");
        const { resolveRunEnvironment } = await import("../../src/core/environments");
        const { project, spec } = await fixture();
        const configured = (await environmentsRepository.list(project.id))[0]!;
        await environmentsRepository.update(configured, { ...configured, executor: "tunnel", runnerGroup: "restart" });
        const environment = await resolveRunEnvironment(project.id);
        const run = await runsRepository.createRun({ specId: spec.id, sourceHash: "source", commitSha: "sha", environment });
        const batch = { id: crypto.randomUUID(), projectId: project.id, label: "Queued tunnel", environment, baseUrl: environment.baseUrl,
            status: "running" as const, startedAt: new Date().toISOString(), durationMs: null, failReason: null, waitingForTunnelAt: new Date().toISOString(),
            specs: [{ runId: run.id, specId: spec.id, title: spec.title, sourceHash: "source", markdownHash: "markdown", commitSha: "sha", status: "running", durationMs: null, failReason: null }] };
        const file = path.join(getRunBatchDirectory(batch.id), "batch.json");
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify(batch));
        assert.ok((await pendingTunnelBatchRunIds()).includes(run.id));
        await runsRepository.markInterruptedRuns();
        assert.equal((await runsRepository.getRun(run.id))!.status, "running");
        await fs.writeFile(file, JSON.stringify({ ...batch, waitingForTunnelAt: undefined }));
        await runsRepository.markInterruptedRuns();
        assert.equal((await runsRepository.getRun(run.id))!.status, "error");
        await fs.writeFile(file, JSON.stringify({ ...batch, status: "error", waitingForTunnelAt: undefined }));
    });

    test("queue visibility counts waiting Specs per environment and explains runner availability", async () => {
        const { resolveRunEnvironment } = await import("../../src/core/environments");
        const { runnerQueueSnapshot, visibleRuns } = await import("../../src/core/private-runner/visibility");
        const { project, spec } = await fixture();
        const configured = (await environmentsRepository.list(project.id))[0]!;
        await environmentsRepository.update(configured, { ...configured, executor: "runner", runnerGroup: "visibility" });
        const environment = await resolveRunEnvironment(project.id);
        const run = await runsRepository.createRun({ specId: spec.id, commitSha: "sha", sourceHash: "source", environment });
        const batchId = crypto.randomUUID();
        await enqueueRunnerBatch(batchId, project.id, "visibility", { batchId, projectId: project.id, baseUrl: environment.baseUrl,
            networkPolicy: { origins: [environment.baseUrl], allowPrivate: true }, timeoutMs: 60_000,
            specs: [{ runId: run.id, specId: spec.id, title: spec.title, files: { "spec.ts": VALID_SPEC, "spec.yml": JSON.stringify(HUMAN_SPEC) } }] });
        const first = (await runnerQueueSnapshot()).batchQueues.get(batchId)!;
        assert.equal(first.queued, 1);
        assert.equal(first.environmentId, environment.id);
        assert.equal(first.reason, "No runner online in group visibility.");
        const { queueMetrics, prometheusQueueMetrics, runnerMetricsSchema } = await import("../../src/core/private-runner/metrics");
        const metrics = queueMetrics([first]);
        assert.ok(runnerMetricsSchema.safeParse(metrics).success);
        assert.equal(metrics.groups[0].queued, 1);
        assert.match(prometheusQueueMetrics(metrics), /specbook_runner_queue_depth\{runner_group="visibility"\} 1\n/);
        assert.match(prometheusQueueMetrics({ groups: [{ group: 'office"\\\n', queued: 0, oldestWaitSeconds: 0 }] }), /runner_group="office\\"\\\\\\n"/);
        assert.ok(first.oldestWaitMs >= 0);
        assert.equal((await visibleRuns([run]))[0].queue?.queued, 1);
        const issued = await issueRunnerToken("Visibility", "visibility");
        const runner = (await authenticateRunnerToken(`Bearer ${issued.token}`))!;
        await runnersRepository.reportInstance(runner.id, runner.id, { version: "0.1.0", protocolVersion: 1, concurrency: 1 });
        const lease = (await runnersRepository.claim(runner, 60_000))!;
        assert.equal((await visibleRuns([run]))[0].queue, null);
        await releaseRunnerWork(lease.id, runner.id, lease.leaseId!);
        assert.equal((await runnerQueueSnapshot()).batchQueues.get(batchId)!.reason, "Waiting for a runner to claim work.");
        await revokeRunnerToken(runner.id);
        await runnersRepository.cancelBatch(batchId);
        await runsRepository.finishRun(run.id, "error", 0, "Verification finished");
    });

    test("runner tokens are shown once, admin-session managed and separate from CI and personal access", async () => {
        const { createRunnersRouter } = await import("../../src/infra/web/routes/runners");
        const { accessGate } = await import("../../src/infra/web/access");
        const { handleRequestError } = await import("../../src/infra/web/errors");
        const { accountsRepository } = await import("../../src/infra/repositories/accounts");
        const { tokenHash } = await import("../../src/core/accounts/tokens");
        const admin = await accountsRepository.bootstrap({ name: "Runner admin", email: "runners@example.test", passwordHash: "unused" });
        assert.ok(admin);
        const session = crypto.randomBytes(32).toString("hex");
        await accountsRepository.createSession(tokenHash(session), admin.id, new Date(Date.now() + 60_000).toISOString());
        const runnerApp = new Hono();
        runnerApp.use("*", accessGate(), csrfGuard(), jsonBodyLimit());
        runnerApp.onError(handleRequestError);
        runnerApp.route("/", createRunnersRouter());
        const headers = { ...browserHeaders, Cookie: `specbook_session=${session}`, "content-type": "application/json" };
        const response = await runnerApp.request("/runners", { method: "POST", headers, body: JSON.stringify({ name: "Office runner", group: "office" }) });
        assert.equal(response.status, 201);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const issued = await response.json();
        const stored = (await runnersRepository.get(issued.runner.id))!;
        assert.equal(stored.tokenHash.length, 64);
        assert.ok(!JSON.stringify(stored).includes(issued.token));
        assert.equal(issued.runner.online, false);
        assert.ok(await authenticateRunnerToken(`Bearer ${issued.token}`));
        assert.equal(publicRunner((await runnersRepository.get(stored.id))!).online, true);
        const listing = await runnerApp.request("/runners", { headers });
        assert.equal(listing.status, 200);
        assert.ok(!(await listing.text()).includes(issued.token));
        const project = await projectsRepository.createProject("Token scope", "https://example.com");
        assert.equal(await authenticateCiToken(project.id, `Bearer ${issued.token}`), false);
        assert.equal(await authenticateRunnerToken(`Bearer ${(await issueCiToken(project.id)).token}`), null);
        const personal = `sb_pat_${crypto.randomBytes(32).toString("hex")}`;
        await accountsRepository.createAccessToken(admin.id, "Automation", tokenHash(personal));
        assert.equal(await authenticateRunnerToken(`Bearer ${personal}`), null);
        assert.equal((await runnerApp.request("/runners", { method: "POST", headers: { Authorization: `Bearer ${personal}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Forbidden" }) })).status, 403);
        assert.equal((await runnerApp.request("/runner/claim", { method: "POST", headers: { Authorization: `Bearer ${personal}`, "content-type": "application/json" }, body: JSON.stringify({ version: "test" }) })).status, 401);
        const runnerHeaders = { Authorization: `Bearer ${issued.token}`, "content-type": "application/json" };
        const incompatible = await runnerApp.request("/runner/claim", { method: "POST", headers: runnerHeaders, body: JSON.stringify({ instanceId: crypto.randomUUID(), version: "0.1.0", protocolVersion: 999, concurrency: 1 }) });
        assert.equal(incompatible.status, 426);
        assert.match(await incompatible.text(), /Upgrade the CLI/);
        const missingVersion = await runnerApp.request("/runner/claim", { method: "POST", headers: runnerHeaders, body: JSON.stringify({ version: "0.1.0", concurrency: 1 }) });
        assert.equal(missingVersion.status, 426);
        assert.equal((await runnerApp.request("/runner/metrics", { headers: runnerHeaders })).status, 200);
        const prometheus = await runnerApp.request("/runner/metrics?format=prometheus", { headers: { Authorization: `Bearer ${personal}` } });
        assert.equal(prometheus.status, 200);
        assert.match(prometheus.headers.get("content-type")!, /version=0.0.4/);
        assert.match(await prometheus.text(), /# TYPE specbook_runner_queue_depth gauge/);
        const rotation = await runnerApp.request(`/runners/${stored.id}/rotate`, { method: "POST", headers });
        assert.equal(rotation.status, 200);
        assert.equal(rotation.headers.get("cache-control"), "no-store");
        const rotated = await rotation.json();
        assert.notEqual(rotated.token, issued.token);
        assert.equal(await authenticateRunnerToken(`Bearer ${issued.token}`), null);
        assert.ok(await authenticateRunnerToken(`Bearer ${rotated.token}`));
        assert.equal((await runnerApp.request(`/runners/${stored.id}`, { method: "DELETE", headers })).status, 200);
        assert.equal(await authenticateRunnerToken(`Bearer ${issued.token}`), null);
    });

    test("runner queues survive lease expiry, enforce token groups and reject stale completion", async () => {
        const { db } = await import("../../src/infra/db/client");
        const { runnerJobs } = await import("../../src/infra/db/schema");
        const { eq } = await import("drizzle-orm");
        const project = await projectsRepository.createProject("Private queue", "http://app.private:4300");
        const payload = { batchId: crypto.randomUUID(), projectId: project.id, baseUrl: project.baseUrl,
            networkPolicy: { origins: [project.baseUrl], allowPrivate: true }, timeoutMs: 120_000,
            specs: [{ runId: crypto.randomUUID(), specId: crypto.randomUUID(), title: "Private Spec", files: { "spec.ts": VALID_SPEC, "spec.yml": "steps: []" } }] };
        await enqueueRunnerBatch(payload.batchId, project.id, "office", payload);
        const office = await issueRunnerToken("Office", "office");
        const outside = await issueRunnerToken("Outside", "other");
        const officeRow = (await authenticateRunnerToken(`Bearer ${office.token}`))!;
        const outsideRow = (await authenticateRunnerToken(`Bearer ${outside.token}`))!;
        await runnersRepository.reportInstance(officeRow.id, officeRow.id, { version: "0.1.0", protocolVersion: 1, concurrency: 1 });
        await runnersRepository.reportInstance(outsideRow.id, outsideRow.id, { version: "0.1.0", protocolVersion: 1, concurrency: 1 });
        const otherProject = await projectsRepository.createProject("Restricted project", "https://example.com");
        const restricted = await issueRunnerToken("Restricted", "office", [otherProject.id]);
        const restrictedRow = (await authenticateRunnerToken(`Bearer ${restricted.token}`))!;
        await runnersRepository.reportInstance(restrictedRow.id, restrictedRow.id, { version: "0.1.0", protocolVersion: 1, concurrency: 1 });
        assert.equal(await runnersRepository.claim(restrictedRow, 60_000), null, "tokens cannot claim work in another project");
        await revokeRunnerToken(restrictedRow.id);
        assert.equal(await runnersRepository.claim(outsideRow, 60_000), null);
        const secondBatch = crypto.randomUUID();
        await enqueueRunnerBatch(secondBatch, project.id, "office", { ...payload, batchId: secondBatch });
        const firstInstance = crypto.randomUUID();
        const secondInstance = crypto.randomUUID();
        await runnersRepository.reportInstance(officeRow.id, firstInstance, { version: "0.1.0", protocolVersion: 1, concurrency: 1 });
        await runnersRepository.reportInstance(officeRow.id, secondInstance, { version: "0.1.0", protocolVersion: 1, concurrency: 1 });
        const firstJob = (await runnersRepository.claim(officeRow, 60_000, firstInstance))!;
        const secondJob = (await runnersRepository.claim(officeRow, 60_000, secondInstance))!;
        assert.ok(firstJob && secondJob, "replicas sharing one token have independent capacity");
        assert.equal(await runnersRepository.claim(officeRow, 60_000, firstInstance), null);
        await runnersRepository.disconnect(officeRow.id, firstInstance);
        await runnersRepository.disconnect(officeRow.id, secondInstance);
        assert.equal(await runnersRepository.claim(officeRow, 60_000, firstInstance), null, "late polls cannot lease work after disconnect");
        await assert.rejects(() => runnersRepository.reportInstance(officeRow.id, firstInstance, { version: "0.1.0", protocolVersion: 1, concurrency: 1 }), /disconnected/);
        const { claimRunnerWork } = await import("../../src/core/private-runner/queue");
        await assert.rejects(() => claimRunnerWork(officeRow, new AbortController().signal, firstInstance), /disconnected/);
        await runnersRepository.cancelBatch(secondBatch);
        const lease = (await runnersRepository.claim(officeRow, 60_000))!;
        assert.equal(lease.attempts, 2);
        assert.ok((await pendingRunnerBatchIds()).includes(payload.batchId));
        assert.equal(await runnersRepository.claim(officeRow, 60_000), null);
        const expiry = await heartbeatRunnerWork(lease.id, officeRow.id, lease.leaseId!);
        assert.ok(Date.parse(expiry) > Date.now());
        await db.update(runnerJobs).set({ leaseExpiresAt: new Date(0).toISOString() }).where(eq(runnerJobs.id, lease.id));
        await runnersRepository.reclaim();
        const replacement = (await runnersRepository.claim(officeRow, 60_000))!;
        assert.equal(replacement.id, lease.id);
        assert.equal(replacement.attempts, 3);
        assert.notEqual(replacement.leaseId, lease.leaseId);
        await assert.rejects(() => heartbeatRunnerWork(lease.id, officeRow.id, lease.leaseId!), /expired/);
        const completion = { leaseId: lease.leaseId!, durationMs: 100, processFailure: null,
            results: [{ runId: payload.specs[0].runId, status: "passed" as const, durationMs: 100, failReason: null, failedStep: null, artifacts: [] }] };
        await assert.rejects(() => completeRunnerWork(lease.id, officeRow.id, completion), /expired/);
        await assert.rejects(() => completeRunnerWork(lease.id, officeRow.id, { ...completion, leaseId: replacement.leaseId!, results: [] }), /each Spec/);
        await releaseRunnerWork(replacement.id, officeRow.id, replacement.leaseId!);
        const finalLease = (await runnersRepository.claim(officeRow, 60_000))!;
        await revokeRunnerToken(officeRow.id);
        assert.equal((await runnersRepository.job(finalLease.id))!.status, "queued");
        await assert.rejects(() => heartbeatRunnerWork(finalLease.id, officeRow.id, finalLease.leaseId!), /revoked/);
        await db.delete(runnerJobs).where(eq(runnerJobs.id, finalLease.id));
        await revokeRunnerToken(outsideRow.id);
    });

    test("runner completion stores evidence, promotes awaiting deployment and accepts response retries", async () => {
        const { resolveRunEnvironment } = await import("../../src/core/environments");
        const { sourceHashOf, markdownHashOf } = await import("../../src/core/repo/writer");
        const { specEnvironmentsRepository } = await import("../../src/infra/repositories/spec-environments");
        const { readRunEvidence } = await import("../../src/core/runner/artifacts");
        const { stringify } = await import("yaml");
        const project = await projectsRepository.createProject("Runner promotion", "http://app.private:4300");
        const configured = (await environmentsRepository.list(project.id))[0]!;
        await environmentsRepository.update(configured, { ...configured, executor: "runner", runnerGroup: "promotion" });
        const environment = await resolveRunEnvironment(project.id);
        const markdown = stringify({ title: "Open the application", ...HUMAN_SPEC });
        const feature = await featuresRepository.createFeature(project.id, null, "Private", "", "features/private");
        const spec = await specsRepository.createSpecRecord({ projectId: project.id, featureId: feature.id, title: "Open the application", description: "", path: "specs/private", sourceHash: sourceHashOf(VALID_SPEC), markdownHash: markdownHashOf(markdown) });
        await specEnvironmentsRepository.set(spec, environment.id, "awaiting_deploy");
        const run = await runsRepository.createRun({ specId: spec.id, sourceHash: spec.sourceHash, commitSha: "sha", awaitingDeploy: true, environment });
        const batch = { id: crypto.randomUUID(), projectId: project.id, label: "Private checks", environment, baseUrl: environment.baseUrl,
            status: "running" as const, startedAt: new Date().toISOString(), durationMs: null, failReason: null,
            specs: [{ runId: run.id, specId: spec.id, commitSha: "sha", sourceHash: spec.sourceHash, markdownHash: spec.markdownHash, title: spec.title,
                status: "running" as const, durationMs: null, failReason: null, awaitingDeploy: true }] };
        const directory = getRunBatchDirectory(batch.id);
        const runDirectory = path.join(storage, "runs", run.id);
        await fs.mkdir(directory, { recursive: true });
        await fs.mkdir(runDirectory, { recursive: true });
        await Promise.all([fs.writeFile(path.join(directory, "batch.json"), JSON.stringify(batch)), fs.writeFile(path.join(runDirectory, "spec.ts"), VALID_SPEC), fs.writeFile(path.join(runDirectory, "spec.yml"), markdown)]);
        await enqueueRunnerBatch(batch.id, project.id, "promotion", { batchId: batch.id, projectId: project.id, baseUrl: environment.baseUrl,
            networkPolicy: { origins: [environment.baseUrl], allowPrivate: true }, timeoutMs: 120_000,
            specs: [{ runId: run.id, specId: spec.id, title: spec.title, files: { "spec.ts": VALID_SPEC, "spec.yml": markdown } }] });
        const issued = await issueRunnerToken("Promotion runner", "promotion");
        const token = (await authenticateRunnerToken(`Bearer ${issued.token}`))!;
        await runnersRepository.reportInstance(token.id, token.id, { version: "0.1.0", protocolVersion: 1, concurrency: 1 });
        const lease = (await runnersRepository.claim(token, 60_000))!;
        const completion = { leaseId: lease.leaseId!, durationMs: 200, processFailure: null,
            results: [{ runId: run.id, status: "passed" as const, durationMs: 200, failReason: null, failedStep: null, artifacts: [
                { path: "evidence.json", content: Buffer.from(JSON.stringify({ steps: [{ number: 1, label: "Open the page", file: "evidence/step-01.png" }], video: null, failedStep: null, diagnostics: [{ kind: "console", message: "Private page loaded" }] })).toString("base64") },
                { path: "evidence/step-01.png", content: Buffer.from("screenshot").toString("base64") },
            ] }] };
        await completeRunnerWork(lease.id, token.id, completion);
        await completeRunnerWork(lease.id, token.id, completion);
        assert.equal((await runsRepository.getRun(run.id))!.status, "passed");
        assert.equal((await getRunBatch(batch.id))!.status, "passed");
        assert.equal(await specEnvironmentsRepository.awaiting(spec, environment.id), false);
        assert.equal((await specsRepository.getSpec(spec.id))!.status, "passed");
        const evidence = await readRunEvidence(run.id);
        assert.equal(evidence.steps[0].file, "evidence/step-01.png");
        assert.equal(evidence.diagnostics[0].message, "Private page loaded");
        assert.ok(!(await pendingRunnerBatchIds()).includes(batch.id));
        assert.equal((await runnersRepository.job(lease.id))!.status, "completed");
        await revokeRunnerToken(token.id);
    });

    test("waiting failures keep evidence and skip every quality gate after promotion", async () => {
        const { project, spec, batch } = await fixture();
        const run = await runsRepository.createRun({ specId: spec.id, sourceHash: spec.sourceHash, commitSha: "sha", awaitingDeploy: true });
        await runsRepository.finishRun(run.id, "failed", 100, "Deployment is not ready");
        await specsRepository.updateSpecRecord(spec.id, { status: "passed" });
        const waitingBatch = { ...batch, ci: { ...batch.ci, qualityGate: { failOnFlaky: true, failOnKnownBugs: true } }, specs: [{ ...batch.specs[0], runId: run.id }] };
        const result = await ciResult(waitingBatch);
        assert.equal(result.complete, true);
        assert.equal(result.status, "passed");
        assert.equal(result.qualityGate.failures, 0);
        assert.equal(result.qualityGate.awaitingDeploy, 1);
        assert.equal(result.results[0].status, "failed");
        assert.equal(result.results[0].awaitingDeploy, true);
        assert.equal(result.results[0].failsGate, false);
        assert.match(junitResult(result), /<skipped message="Waiting for deploy"/);
        assert.match(markdownResult(result), /Waiting for deploy/);
        const { htmlReport, runReport } = await import("../../src/core/ci/report");
        assert.match(await htmlReport(result), /Waiting for deploy/);
        assert.match(await runReport(run, { projectId: project.id, title: spec.title }), /Waiting for deploy/);
    });

    test("batch history remains complete across cache eviction and project switches", async () => {
        const first = await fixture();
        const second = await fixture();
        const copies = Array.from({ length: 305 }, (_, index) => ({ ...first.batch, id: crypto.randomUUID(), startedAt: new Date(Date.UTC(2025, 0, 1) + index * 1000).toISOString(), ...(index % 2 ? { ci: undefined } : {}) }));
        await Promise.all(copies.map(async (batch) => {
            const directory = getRunBatchDirectory(batch.id);
            await fs.mkdir(directory, { recursive: true });
            await fs.writeFile(path.join(directory, "batch.json"), JSON.stringify(batch));
        }));
        const all = await listRunBatches(first.project.id, 400);
        assert.equal(all.length, 306);
        assert.equal(all[0].id, first.batch.id);
        assert.deepEqual(all.slice(1).map((batch) => batch.id), [...copies].reverse().map((batch) => batch.id));
        assert.deepEqual((await listRunBatches(second.project.id)).map((batch) => batch.id), [second.batch.id]);
        assert.equal((await listCiBatches(first.project.id, 400)).length, 154);
        assert.equal((await listRunBatches(first.project.id, 400)).length, 306);
        const deleted = copies[0];
        await fs.rm(getRunBatchDirectory(deleted.id), { recursive: true });
        assert.equal((await listRunBatches(first.project.id, 400)).length, 305);
        assert.equal(await getRunBatch(deleted.id), null);
    });

    test("public CI links follow the runtime frontend origin", async () => {
        const { project, batch } = await fixture();
        const response = await app.request(`/projects/${project.id}/ci`, { headers: {
            ...browserHeaders, "x-specbook-proxy": "1", "x-forwarded-host": "192.168.0.165:8080", "x-forwarded-proto": "http",
        } });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.batches[0].url, `http://192.168.0.165:8080/p/${project.id}/settings?tab=automation#ci-batch-${batch.id}`);
        assert.ok(body.batches[0].results[0].url.startsWith(`http://192.168.0.165:8080/p/${project.id}/specs/`));
    });

    test("stores only hashes, separates project and Git scopes, and rotates/revokes immediately", async () => {
        const first = await projectsRepository.createProject("First", "https://example.com");
        const second = await projectsRepository.createProject("Second", "https://example.com");
        const issue = await app.request(`/projects/${first.id}/ci/token`, { method: "POST", headers: browserHeaders });
        assert.equal(issue.status, 200);
        const { token } = await issue.json() as { token: string };
        const row = (await ciRepository.token(first.id))!;
        assert.equal(row.tokenHash?.length, 64);
        assert.ok(!JSON.stringify(row).includes(token));
        assert.equal(await authenticateCiToken(first.id, `Bearer ${token}`), true);
        assert.equal(await authenticateCiToken(second.id, `Bearer ${token}`), false);
        assert.equal(await authenticateCiToken(first.id, `Bearer ${(await issueGitAccessToken(first.id)).token}`), false);
        const rotated = await issueCiToken(first.id);
        assert.equal(await authenticateCiToken(first.id, `Bearer ${token}`), false);
        assert.equal(await authenticateCiToken(first.id, `Bearer ${rotated.token}`), true);
        await app.request(`/projects/${first.id}/ci/token`, { method: "DELETE", headers: browserHeaders });
        assert.equal(await authenticateCiToken(first.id, `Bearer ${rotated.token}`), false);
        assert.equal((await app.request(`/projects/${first.id}/ci/token`, { method: "POST", headers: { Host: "localhost:4000" } })).status, 403);
    });

    test("accepts external CI hosts only with the correct token and records a deduplicated deploy signal", async () => {
        const project = await projectsRepository.createProject("Deploy", "https://8.8.8.8");
        const { token } = await issueCiToken(project.id);
        await environmentsRepository.create(project.id, { name: "preview", baseUrl: project.baseUrl, allowedOrigins: ["https://1.1.1.1"], credentialOverrides: {} });
        const url = `/ci/projects/${project.id}/deploy`;
        const body = JSON.stringify({ environment: "preview", url: "https://1.1.1.1", commitSha: "abc" });
        assert.equal((await app.request(url, { method: "POST", headers: { Host: "external.test", "Content-Type": "application/json" }, body })).status, 401);
        const headers = { Host: "external.test", "Content-Type": "application/json", Authorization: `Bearer ${token}` };
        for (let i = 0; i < 2; i++) assert.equal((await app.request(url, { method: "POST", headers, body })).status, 202);
        const signals = await stewardRepository.signals(project.id);
        assert.equal(signals.length, 1);
        assert.equal(signals[0]?.kind, "deployment");
        assert.equal(signals[0]?.payload.url, "https://1.1.1.1");
        assert.equal((await app.request(`/projects/${project.id}/ci/token`, { method: "POST", headers })).status, 421);
        assert.equal((await app.request(`/ci/projects/${project.id}/client.mjs`, { headers })).status, 404);
    });

    test("restricts CI origins and private targets, deduplicates SHA-less deploys and persists token limits", async (t) => {
        const at = Date.now();
        t.mock.method(Date, "now", () => at);
        const project = await projectsRepository.createProject("Public deployment", "https://8.8.8.8");
        const { token } = await issueCiToken(project.id);
        const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
        const post = (body: object, endpoint = "deploy") => app.request(`/ci/projects/${project.id}/${endpoint}`, { method: "POST", headers, body: JSON.stringify(body) });
        assert.equal((await post({ url: "https://1.1.1.1" })).status, 400);
        const production = (await environmentsRepository.list(project.id))[0]!;
        const save = await app.request(`/projects/${project.id}/environments/${production.id}`, { method: "PUT", headers: { ...browserHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Production", baseUrl: project.baseUrl, allowedOrigins: ["https://1.1.1.1/", "http://127.0.0.1", "http://169.254.169.254", "http://[::1]"], credentialOverrides: {} }) });
        assert.equal(save.status, 200);
        assert.equal((await save.json()).environment.allowedOrigins[0], "https://1.1.1.1");
        for (const target of ["http://127.0.0.1", "http://169.254.169.254", "http://[::1]"]) {
            assert.equal((await post({ url: target })).status, 400);
            assert.equal((await post({ baseUrl: target }, "runs")).status, 400);
        }
        for (let index = 0; index < 2; index++) assert.equal((await post({ url: "https://1.1.1.1" })).status, 202);
        assert.equal((await stewardRepository.signals(project.id)).length, 1);
        assert.equal((await post({ url: "https://8.8.8.8" })).status, 202);
        const row = (await ciRepository.token(project.id))!;
        const remaining = 30 - row.requestCount;
        const quota = await Promise.all(Array.from({ length: remaining + 5 }, () => ciRepository.consumeRequest(project.id, row.tokenHash!)));
        assert.equal(quota.filter(Boolean).length, remaining, "concurrent POSTs cannot exceed the persisted limit");
        assert.equal((await post({})).status, 429);
        const rotated = await issueCiToken(project.id);
        assert.equal((await app.request(`/ci/projects/${project.id}/deploy`, { method: "POST", headers: { ...headers, Authorization: `Bearer ${rotated.token}` }, body: "{}" })).status, 202);
        const local = await projectsRepository.createProject("Local app", "http://127.0.0.1:3000");
        const localEnvironment = (await environmentsRepository.list(local.id))[0]!;
        await environmentsRepository.update(localEnvironment, { ...localEnvironment, allowedOrigins: ["http://127.0.0.1:4000"] });
        const localHeaders = { ...headers, Authorization: `Bearer ${(await issueCiToken(local.id)).token}` };
        assert.equal((await app.request(`/ci/projects/${local.id}/deploy`, { method: "POST", headers: localHeaders, body: JSON.stringify({ url: "http://127.0.0.1:4000" }) })).status, 202);
    });

    test("blocks reserved addresses and DNS rebinding while pinning proxy connections", async () => {
        const { resolveTarget, isPrivateAddress } = await import("@specbook/runtime/network/targets");
        const { createRunProxy } = await import("@specbook/runtime/network/proxy");
        for (const address of ["0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.1.1", "192.168.1.1", "224.0.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2002:7f00:1::1"]) assert.equal(isPrivateAddress(address), true, address);
        for (const address of ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isPrivateAddress(address), false, address);
        await assert.rejects(() => resolveTarget("https://mixed.test", false, async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]), /not allowed/);
        const { projectRunPolicy } = await import("../../src/core/ci/targets");
        const reboundProject = await projectsRepository.createProject("Rebound project", "https://rebound.test");
        await assert.rejects(() => projectRunPolicy(reboundProject, reboundProject.baseUrl, async () => [{ address: "127.0.0.1", family: 4 }]), /not allowed/, "a public project hostname cannot turn on private access by changing its DNS");
        let resolutions = 0;
        const rebound = async () => [{ address: ++resolutions === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }];
        await resolveTarget("http://rebind.test", false, rebound);
        const blockedProxy = await createRunProxy([], rebound);
        const request = (proxy: string, target: string) => new Promise<number>((resolve, reject) => {
            http.get(proxy, { path: target }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode!)); }).on("error", reject);
        });
        try {
            assert.equal(await request(blockedProxy.server, "http://rebind.test/"), 403);
            assert.equal(await request(blockedProxy.server, "http://127.0.0.1/"), 403);
        } finally { await blockedProxy.close(); }
        let receivedHost = "";
        const target = http.createServer((req, response) => { receivedHost = req.headers.host ?? ""; response.end("ok"); });
        await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
        let lookups = 0;
        const authority = `private-app.invalid:${(target.address() as AddressInfo).port}`;
        const pinned = await createRunProxy([`http://${authority}`, `https://${authority}`], async () => { lookups++; return [{ address: "127.0.0.1", family: 4 }]; });
        try {
            assert.equal(await request(pinned.server, `http://${authority}/`), 200);
            assert.equal(receivedHost, authority, "Host stays unchanged while the connection uses the checked IP");
            assert.equal(lookups, 1, "the checked hostname is not resolved again by the transport");
            const tunnel = await new Promise<string>((resolve, reject) => {
                const proxyUrl = new URL(pinned.server);
                const connect = http.request({ hostname: proxyUrl.hostname, port: proxyUrl.port, method: "CONNECT", path: authority });
                connect.on("connect", (response, socket) => {
                    assert.equal(response.statusCode, 200);
                    let output = "";
                    socket.on("data", (value) => { output += value.toString(); });
                    socket.on("end", () => resolve(output));
                    socket.on("error", reject);
                    socket.write(`GET / HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`);
                });
                connect.on("error", reject);
                connect.end();
            });
            assert.match(tunnel, /200 OK/);
            assert.equal(lookups, 2, "CONNECT also pins a single checked resolution");
        } finally { await pinned.close(); target.closeAllConnections(); await new Promise<void>((resolve) => target.close(() => resolve())); }
    });

    test("waits for retry, excludes flaky/known bugs by default, and renders escaped persistent results", async () => {
        const { project, run, spec, batch } = await fixture();
        const { token } = await issueCiToken(project.id);
        const headers = { Authorization: `Bearer ${token}` };
        assert.equal((await app.request(`/ci/runs/${batch.id}`)).status, 401);
        const other = await projectsRepository.createProject("Other", "https://example.com");
        assert.equal((await app.request(`/ci/runs/${batch.id}`, { headers: { Authorization: `Bearer ${(await issueCiToken(other.id)).token}` } })).status, 401);
        assert.equal((await ciResult(batch)).complete, false);
        const retry = await runsRepository.createRun({ specId: spec.id, sourceHash: "source", commitSha: "sha", retryOf: run.id });
        await runsRepository.finishRun(retry.id, "passed", 200, null);
        await runsRepository.markFlaky(run.id, retry.id);
        await runsRepository.acknowledgeAutomation(run.id);
        const result = await ciResult((await getRunBatch(batch.id))!);
        assert.equal(result.status, "passed");
        assert.equal(result.qualityGate.flaky, 1);
        assert.equal(result.results[0]?.retryRunId, retry.id);
        assert.match(junitResult(result), /A &lt;checkout&gt; \| test/);
        assert.match(junitResult(result), /<skipped message="Flaky: passed on retry"/);
        assert.match(markdownResult(result), /A \\<checkout\\> \\\| test/);
        assert.equal((await ciResult({ ...batch, ci: { ...batch.ci, qualityGate: { failOnFlaky: true, failOnKnownBugs: false } } })).status, "failed");
        for (const format of ["junit", "markdown", "json"]) assert.equal((await app.request(`/ci/runs/${batch.id}?wait=true&format=${format}`, { headers })).status, 200);
        const settings = await (await app.request(`/projects/${project.id}/ci`, { headers: browserHeaders })).json() as { token: unknown; batches: unknown[] };
        assert.equal(settings.batches.length, 1);
        assert.ok(!JSON.stringify(settings).includes(token));
        const known = await fixture();
        await runsRepository.acknowledgeAutomation(known.run.id);
        known.batch.ci.knownBugSpecIds = [known.spec.id];
        assert.equal((await ciResult(known.batch)).status, "passed");
        known.batch.ci.qualityGate.failOnKnownBugs = true;
        assert.equal((await ciResult(known.batch)).status, "failed");
    });

    test("validates exclusive selection and credential-free HTTP preview URLs", () => {
        assert.equal(ciRunSchema.safeParse({}).success, true);
        assert.equal(ciRunSchema.safeParse({ featureId: crypto.randomUUID(), specIds: [crypto.randomUUID()] }).success, false);
        for (const baseUrl of ["file:///etc/passwd", "https://user:pass@example.com", "not-a-url"]) assert.equal(ciRunSchema.safeParse({ baseUrl }).success, false);
        for (const origin of ["https://*.example.com", "https://example.com/path", "https://example.com?query"]) assert.equal(environmentSchema.safeParse({ name: "Production", baseUrl: "https://example.com", allowedOrigins: [origin] }).success, false);
        assert.equal(environmentSchema.safeParse({ name: "Private", baseUrl: "http://app.private:4300", executor: "runner", runnerGroup: "office" }).success, true);
        assert.equal(environmentSchema.safeParse({ name: "Private", baseUrl: "http://app.private:4300", executor: "runner", credentialOverrides: { shop: crypto.randomUUID() } }).success, false);
        assert.equal(environmentSchema.safeParse({ name: "Public", baseUrl: "https://example.com", executor: "server", runnerGroup: "office" }).success, false);
    });

    test("reports completed attempts while agent work is paused or still awaiting acknowledgement", async () => {
        const { settingsRepository } = await import("../../src/infra/repositories/settings");
        for (const global of [false, true]) {
            const { project, run, spec, batch } = await fixture();
            await stewardRepository.update(project.id, { paused: !global });
            await settingsRepository.setAgentPaused(global);
            try {
                assert.equal((await ciResult(batch)).complete, false, "a requested retry must still run");
                const retry = await runsRepository.createRun({ specId: spec.id, sourceHash: "source", commitSha: "sha", retryOf: run.id });
                assert.equal((await ciResult(batch)).complete, false, "an active retry is still pending");
                await runsRepository.finishRun(retry.id, "failed", 20, "Still failing");
                const failed = await ciResult(batch);
                assert.equal(failed.complete, true);
                assert.equal(failed.status, "failed");
                assert.equal(failed.qualityGate.failures, 1);
                assert.match(junitResult(failed), /failures="1"/);
                await runsRepository.finishRun(retry.id, "passed", 20, null);
                const flaky = await ciResult(batch);
                assert.equal(flaky.complete, true);
                assert.equal(flaky.status, "passed");
                assert.equal(flaky.qualityGate.flaky, 1, "reporting cannot wait for the healer to acknowledge the result");
                assert.match(markdownResult(flaky), /Quality gate: passed/);
                await runsRepository.finishRun(run.id, "passed", 100, null);
                await runsRepository.deleteRun(retry.id);
                assert.equal((await ciResult({ ...batch, status: "passed" })).complete, true, "passing runs need no retry acknowledgement");
            } finally {
                await settingsRepository.setAgentPaused(false);
            }
        }
    });

    test("rejects busy CI triggers before preparing a batch, with atomic multi-Spec reservations", async () => {
        const { acquireSpecLocks, areSpecsLocked } = await import("../../src/core/specs/lifecycle");
        const { project, spec } = await fixture();
        const other = crypto.randomUUID();
        const reservation = acquireSpecLocks([spec.id, other], { wait: false });
        assert.equal(areSpecsLocked([other]), true, "all IDs are reserved before the first await");
        await assert.rejects(() => acquireSpecLocks([other], { wait: false }), /already in use/);
        const release = await reservation;
        try {
            const { token } = await issueCiToken(project.id);
            const response = await app.request(`/ci/projects/${project.id}/runs`, {
                method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({ specIds: [spec.id] }),
            });
            assert.equal(response.status, 409);
            assert.equal((await runsRepository.listRuns(spec.id)).length, 1, "a rejected trigger creates no run");
        } finally { await release(); }
        assert.equal(areSpecsLocked([spec.id, other]), false);
    });

    test("the CLI recovers transient GET failures and never retries a trigger", async () => {
        const { backendRoot } = await import("../../src/core/paths");
        let posts = 0;
        let polls = 0;
        let failTrigger = false;
        const seen: string[] = [];
        const server = http.createServer((request, response) => {
            seen.push(request.headers.authorization ?? "");
            if (request.method === "POST") {
                posts++;
                response.statusCode = failTrigger ? 503 : 202;
                response.end(failTrigger ? "Unavailable" : JSON.stringify({ batch: { id: "batch-id" }, url: "http://example.com/results", complete: false, status: "running", qualityGate: { passed: false, failures: 0, flaky: 0, knownBugs: 0 }, results: [] }));
            } else if (request.url?.includes("format=junit")) response.end('<testsuite tests="1" failures="0"/>');
            else if (request.url?.includes("format=markdown")) response.end("## Specbook: passed");
            else if (request.url?.includes("format=html")) response.end("<!doctype html><title>Specbook report</title>");
            else {
                polls++;
                if (polls === 1) { response.statusCode = 503; response.end("Restarting"); }
                else if (polls === 2) request.socket.destroy();
                else response.end(JSON.stringify({ batch: { id: "batch-id" }, url: "http://example.com/results", complete: true, status: "passed", qualityGate: { passed: true, failures: 0, flaky: 0, knownBugs: 0 }, results: [] }));
            }
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const directory = path.join(storage, "client-results");
        const runClient = () => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
            const child = spawn(process.execPath, ["--import", "tsx", path.join(backendRoot, "..", "cli", "src", "index.ts"), "ci"], {
                env: { ...process.env, SPECBOOK_HOME: path.join(directory, "home"), SPECBOOK_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, SPECBOOK_PROJECT: "11111111-1111-4111-8111-111111111111", SPECBOOK_TOKEN: "test-ci-token", SPECBOOK_COMMENT_PROVIDER: "none", SPECBOOK_TIMEOUT_SECONDS: "20",
                    SPECBOOK_JUNIT_PATH: path.join(directory, "junit.xml"), SPECBOOK_SUMMARY_PATH: path.join(directory, "summary.md"), SPECBOOK_REPORT_PATH: path.join(directory, "report.html") },
                stdio: ["ignore", "pipe", "pipe"],
            });
            let output = "";
            child.stdout.on("data", (value) => { output += value.toString(); });
            child.stderr.on("data", (value) => { output += value.toString(); });
            child.on("error", reject);
            child.on("close", (code) => resolve({ code, output }));
        });
        try {
            const recovered = await runClient();
            assert.equal(recovered.code, 0, recovered.output);
            assert.equal(posts, 1);
            assert.equal(polls, 3);
            assert.ok(seen.every((authorization) => authorization === "Bearer test-ci-token"));
            assert.match(await fs.readFile(path.join(directory, "junit.xml"), "utf8"), /failures="0"/);
            assert.match(await fs.readFile(path.join(directory, "report.html"), "utf8"), /Specbook report/);
            assert.match(await fs.readFile(path.join(directory, "summary.md"), "utf8"), /passed/);
            failTrigger = true;
            const rejected = await runClient();
            assert.equal(rejected.code, 1);
            assert.equal(posts, 2, "the failed POST is attempted exactly once");
            assert.equal(polls, 3, "a failed trigger never enters the result loop");
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    test("the CI job creates one summary per project, updates it across runs and keeps provider tokens separate", async () => {
        const { backendRoot } = await import("../../src/core/paths");
        const directory = path.join(storage, "client-comments");
        await fs.mkdir(directory, { recursive: true });
        let passing = true;
        let failComment = false;
        let triggerCount = 0;
        let commentPosts = 0;
        let commentUpdates = 0;
        let commentDeletes = 0;
        let environment: unknown;
        const comments: { id: number; body: string; user: { login: string } }[] = [];
        const notes: { id: number; body: string; author: { id: number }; system: boolean }[] = [];
        const server = http.createServer(async (request, response) => {
            const target = new URL(request.url!, "http://localhost");
            let body = "";
            for await (const chunk of request) body += chunk;
            response.setHeader("Content-Type", "application/json");
            if (target.pathname.startsWith("/specbook/")) {
                assert.equal(request.headers.authorization, "Bearer test-ci-token");
                assert.equal(request.headers["private-token"], undefined);
                assert.ok(!body.includes("github-test-token") && !body.includes("gitlab-test-token"));
                if (request.method === "POST") {
                    triggerCount++;
                    environment = JSON.parse(body).environment;
                    response.statusCode = 202;
                    response.end(JSON.stringify({ batch: { id: "batch-id" }, url: "https://example.com/results", complete: true, results: [], status: passing ? "passed" : "failed", qualityGate: { passed: passing, failures: passing ? 0 : 1, flaky: 0, knownBugs: 0 } }));
                } else response.end(target.searchParams.get("format") === "junit" ? '<testsuite tests="1"/>' : `## Specbook: ${passing ? "passed" : "failed"}\nhttps://example.com/results\ntest-ci-token github-test-token gitlab-test-token`);
                return;
            }
            const github = target.pathname.startsWith("/github/");
            assert.equal(github ? request.headers.authorization : request.headers["private-token"], github ? "Bearer github-test-token" : "gitlab-test-token");
            assert.ok(!body.includes("test-ci-token") && !body.includes("github-test-token") && !body.includes("gitlab-test-token"));
            if (!github && target.pathname.endsWith("/user")) { response.end(JSON.stringify({ id: 77 })); return; }
            if (!github) assert.match(target.pathname, /^\/gitlab\/projects\/123\//, "notes belong to the MR project even when the CI job runs in a fork");
            const list = github ? comments : notes;
            if (request.method === "GET") {
                const start = (Number(target.searchParams.get("page")) - 1) * 100;
                response.end(JSON.stringify(list.slice(start, start + 100)));
            } else if (request.method === "POST") {
                commentPosts++;
                if (failComment) { response.statusCode = 503; response.end("github-test-token gitlab-test-token"); return; }
                const comment = { id: 1000 + commentPosts, body: JSON.parse(body).body, user: { login: "github-actions[bot]" }, author: { id: 77 }, system: false };
                list.push(comment);
                response.statusCode = 201;
                response.end(JSON.stringify(comment));
            } else {
                const id = Number(target.pathname.split("/").at(-1));
                const index = list.findIndex((comment) => comment.id === id);
                assert.ok(index >= 0);
                if (request.method === "DELETE") {
                    commentDeletes++;
                    list.splice(index, 1);
                    response.statusCode = 204;
                    response.end();
                } else {
                    commentUpdates++;
                    list[index]!.body = JSON.parse(body).body;
                    response.end(JSON.stringify(list[index]));
                }
            }
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const marker = `<!-- specbook:${crypto.createHash("sha256").update(`${api}/specbook/11111111-1111-4111-8111-111111111111`).digest("hex")} -->`;
        comments.push({ id: 1, body: `${marker}\nHuman comment`, user: { login: "human" } });
        for (let index = 0; index < 100; index++) comments.push({ id: index + 2, body: "Other comment", user: { login: "human" } });
        notes.push({ id: 1, body: `${marker}\nSomeone else's note`, author: { id: 12 }, system: false });
        await fs.writeFile(path.join(directory, "event.json"), JSON.stringify({ pull_request: { number: 42 } }));
        const runClient = (env: Record<string, string> = {}, args: string[] = []) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
            const child = spawn(process.execPath, ["--import", "tsx", path.join(backendRoot, "..", "cli", "src", "index.ts"), "ci", ...args], {
                env: { ...process.env, SPECBOOK_HOME: path.join(directory, "home"), SPECBOOK_URL: `${api}/specbook`, SPECBOOK_PROJECT: "11111111-1111-4111-8111-111111111111", SPECBOOK_TOKEN: "test-ci-token", SPECBOOK_ENVIRONMENT: "production", SPECBOOK_COMMENT_PROVIDER: "none", SPECBOOK_TIMEOUT_SECONDS: "20",
                    SPECBOOK_JUNIT_PATH: path.join(directory, "junit.xml"), SPECBOOK_REPORT_PATH: path.join(directory, "report.html"), SPECBOOK_SUMMARY_PATH: path.join(directory, "summary.md"), GITHUB_EVENT_PATH: path.join(directory, "event.json"), GITHUB_REPOSITORY: "example/application", GITHUB_API_URL: `${api}/github`, GITHUB_TOKEN: "github-test-token",
                    CI_API_V4_URL: `${api}/gitlab`, CI_PROJECT_ID: "123", CI_MERGE_REQUEST_PROJECT_ID: "", CI_MERGE_REQUEST_IID: "42", SPECBOOK_GITLAB_TOKEN: "gitlab-test-token", ...env },
                stdio: ["ignore", "pipe", "pipe"],
            });
            let output = "";
            child.stdout.on("data", (value) => { output += value.toString(); });
            child.stderr.on("data", (value) => { output += value.toString(); });
            child.on("error", reject);
            child.on("close", (code) => resolve({ code, output }));
        });
        try {
            const created = await runClient({}, ["--environment", "staging", "--comment=github"]);
            assert.equal(created.code, 0, created.output);
            assert.equal(environment, "staging", "the command line overrides the default environment");
            assert.equal(commentPosts, 1);
            assert.equal(comments.length, 102, "a human's matching marker is never overwritten");
            assert.match(comments.at(-1)!.body, /Specbook: passed/);
            assert.ok(comments.at(-1)!.body.includes("[REDACTED]"));
            comments.push({ ...comments.at(-1)!, id: 2000 });
            passing = false;
            const updated = await runClient({ SPECBOOK_COMMENT_PROVIDER: "github" });
            assert.equal(updated.code, 1, "comment publishing preserves a failing quality gate");
            assert.equal(environment, "production");
            assert.equal(commentPosts, 1, "later jobs update the existing comment, including on the second page");
            assert.equal(commentUpdates, 1);
            assert.equal(commentDeletes, 1, "only duplicate bot comments with this project marker are removed");
            assert.match(comments.at(-1)!.body, /Specbook: failed/);
            passing = true;
            const gitlab = await runClient({ SPECBOOK_COMMENT_PROVIDER: "gitlab", CI_MERGE_REQUEST_PROJECT_ID: "123", CI_PROJECT_ID: "999" });
            assert.equal(gitlab.code, 0, gitlab.output);
            assert.equal(notes.length, 2);
            const gitlabUpdated = await runClient({ SPECBOOK_COMMENT_PROVIDER: "gitlab" });
            assert.equal(gitlabUpdated.code, 0, gitlabUpdated.output);
            assert.equal(notes.length, 2);
            assert.equal(commentUpdates, 2, "GitLab uses PUT on the note authored by its CI project token");
            const beforeRejected = triggerCount;
            const rejected = await runClient({ SPECBOOK_COMMENT_PROVIDER: "gitlab", SPECBOOK_GITLAB_TOKEN: "", CI_JOB_TOKEN: "job-token" });
            assert.equal(rejected.code, 1);
            assert.match(rejected.output, /CI_JOB_TOKEN cannot create or update/);
            assert.equal(triggerCount, beforeRejected, "unsupported GitLab authentication fails before starting a batch");
            const noContext = await runClient({ SPECBOOK_COMMENT_PROVIDER: "gitlab", SPECBOOK_GITLAB_TOKEN: "", CI_MERGE_REQUEST_IID: "" });
            assert.equal(noContext.code, 0, noContext.output);
            const beforeFailure = commentPosts;
            failComment = true;
            const failed = await runClient({ SPECBOOK_COMMENT_PROVIDER: "github", SPECBOOK_PROJECT: "22222222-2222-4222-8222-222222222222" });
            assert.equal(failed.code, 1, "publishing failure never silently passes the CI job");
            assert.match(failed.output, /comment API returned HTTP 503; reports are saved locally/);
            assert.equal(commentPosts, beforeFailure + 1, "an ambiguous failed POST is never retried");
            for (const token of ["test-ci-token", "github-test-token", "gitlab-test-token", "job-token"]) assert.ok(!failed.output.includes(token));
            const summary = await fs.readFile(path.join(directory, "summary.md"), "utf8");
            assert.match(summary, /Specbook: passed/);
            assert.ok(!summary.includes("test-ci-token") && !summary.includes("github-test-token") && !summary.includes("gitlab-test-token"));
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    test("CI snippets parse and include merge-request pipelines without duplicate push jobs", async () => {
        const { ciSnippet } = await import("../../../frontend/src/lib/ci-snippets");
        const { parse } = await import("yaml");
        for (const provider of ["github", "gitlab", "bitbucket", "circleci", "jenkins"] as const) {
            const snippet = ciSnippet(provider, "https://specbook.example.com/api/", "project", false, false);
            assert.ok(snippet.includes('npx --yes --package="$SPECBOOK_URL/cli/specbook.tgz" specbook ci'), provider);
            assert.ok(snippet.includes("https://specbook.example.com/api"), provider);
            assert.ok(!snippet.includes("https://specbook.example.com/api/"), provider);
            assert.doesNotMatch(snippet, /npx (?:--yes )?specbook\b/);
        }
        for (const provider of ["github", "gitlab", "bitbucket", "circleci"] as const) {
            assert.ok(parse(ciSnippet(provider, "https://specbook.example.com/api", "<project-id>", false, false)));
        }
        const job = parse(ciSnippet("gitlab", "https://specbook.example.com/api", "project", false, false)).specbook;
        const rules = job.rules as { if: string; when?: string }[];
        const evaluate = (source: string, branch = "", openMergeRequests = "") => {
            const values: Record<string, string> = { CI_PIPELINE_SOURCE: source, CI_COMMIT_BRANCH: branch, CI_OPEN_MERGE_REQUESTS: openMergeRequests };
            const rule = rules.find((rule) => rule.if.split(" || ").some((group) => group.split(" && ").every((expression) => {
                const [variable, expected] = expression.split(" == ");
                const value = values[variable.slice(1)];
                return expected === undefined ? Boolean(value) : value === JSON.parse(expected);
            })));
            return Boolean(rule && rule.when !== "never");
        };
        assert.equal(evaluate("merge_request_event"), true);
        assert.equal(evaluate("push", "feature/login"), true);
        assert.equal(evaluate("push", "feature/login", "example/application!42"), false);
        assert.equal(evaluate("push"), true, "tag pushes are not branch/MR duplicates");
        assert.equal(evaluate("web", "feature/login", "example/application!42"), true);
        assert.equal(evaluate("schedule", "main"), false);
    });

});
