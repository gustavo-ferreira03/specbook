import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { Hono } from "hono";
import { useTempStorage } from "../helpers/storage";

/** executeSpec and the runs API against a real browser; skipped without Chromium for @playwright/test. */

useTempStorage();
const { runMigrations } = await import("../../src/infra/db/migrate");
const { projectsRepository } = await import("../../src/infra/repositories/projects");
const { repoGit } = await import("../../src/core/repo/git");
const { repoBare } = await import("../../src/core/repo/bare");
const writer = await import("../../src/core/repo/writer");
const { executeSpec } = await import("../../src/core/runner/run");
const { createRunsRouter } = await import("../../src/infra/web/routes/runs");
const { createProfile } = await import("../../src/core/credentials/profiles");
const { jobsRepository } = await import("../../src/infra/repositories/jobs");
const { stewardRepository } = await import("../../src/infra/repositories/steward");
const { createJobsRouter } = await import("../../src/infra/web/routes/jobs");
const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
const { enqueueIntent, processProjectSteward } = await import("../../src/core/steward/engine");

async function chromiumAvailable(): Promise<boolean> {
    try {
        const { chromium } = await import("@playwright/test");
        await (await chromium.launch({ headless: true })).close();
        return true;
    } catch {
        return false;
    }
}

const available = await chromiumAvailable();
let site: http.Server;
let baseUrl = "";
const flakyRequests = new Map<string, number>();
const previewCredentials: string[] = [];

before(async () => {
    await runMigrations();
    site = http.createServer((request, response) => {
        response.setHeader("content-type", "text/html");
        if (request.url === "/credential-preview") {
            response.end(`<form method="post" action="/credential-receiver"><label>Password <input type="password" name="password" oninput="fetch('/credential-receiver', { method: 'POST', body: this.value })"></label><button>Continue</button></form>`);
            return;
        }
        if (request.url === "/credential-receiver") {
            let body = "";
            request.on("data", (chunk) => { body += chunk.toString(); });
            request.on("end", () => {
                previewCredentials.push(body);
                response.end("<h1>Credentials received</h1>");
            });
            return;
        }
        if (request.url?.startsWith("/flaky")) {
            const count = (flakyRequests.get(request.url) ?? 0) + 1;
            flakyRequests.set(request.url, count);
            response.end(`<h1>${count > 1 ? "Ready" : "Loading"}</h1>`);
            return;
        }
        response.end('<h1>Store</h1><label>Password <input type="password"></label>');
    });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
});

after(() => site?.close());

const app = new Hono();
app.route("/", createRunsRouter());

describe("executeSpec (real browser)", { skip: available ? false : "Chromium for @playwright/test is not installed" }, () => {
    test("stores the run with sourceHash, evidence and report links, and scrubs secrets", { timeout: 120_000 }, async () => {
        const project = await projectsRepository.createProject("Loja", baseUrl);
        await repoGit.ensureProjectRepo(project.id, { create: true });
        await repoBare.ensureBareRepo(project.id, repoGit.getRepoDir(project.id));
        await createProfile(project.id, { name: "shopper", fields: [{ key: "password", value: "s3cret-value" }] });
        const feature = await writer.createFeatureInRepo(project.id, null, "Loja", "");
        const steps = ["Open the store", "Type the password", "See the store"];
        const testSource = `import { test, expect } from "specbook";
test("Store", async ({ page, step, secret }) => {
    await step("Open the store", async () => {
        await page.goto("/");
    });
    await step("Type the password", async () => {
        await page.getByLabel("Password").fill(secret("shopper", "password"));
    });
    await step("See the store", async () => {
        await expect(page.getByRole("heading")).toHaveText("Checkout", { timeout: 500 });
    });
});
`;
        const { spec } = await writer.createSpecInRepo({
            projectId: project.id,
            featureId: feature.id,
            title: "Store",
            description: "",
            humanSpec: { preconditions: [], steps, expectedResult: "Checkout", postconditions: [] },
            testSource,
        });
        assert.equal(spec.status, "unverified", spec.invalidReason ?? "");
        const run = await executeSpec(spec.id);
        assert.equal(run.status, "failed");
        assert.equal(run.failedStep, "See the store");
        assert.equal(run.sourceHash, spec.sourceHash);
        assert.match(run.failReason ?? "", /toHaveText/);

        const evidence = (await (await app.request(`/runs/${run.id}/evidence`)).json()) as {
            steps: { label: string; file: string }[];
            video: string | null;
            failedStep: string | null;
            reportUrl: string | null;
        };
        assert.deepEqual(evidence.steps.map((step) => step.label), steps);
        assert.equal(evidence.failedStep, "See the store");
        assert.equal(evidence.video, "evidence/execution.webm");
        assert.equal(evidence.reportUrl, null, "runs that type secrets keep no HTML report");
        const screenshot = await app.request(`/runs/${run.id}/artifacts/${evidence.steps[0].file}`);
        assert.equal(screenshot.headers.get("content-type"), "image/png");
        assert.equal(screenshot.headers.get("content-security-policy"), "sandbox");

        const { files } = (await (await app.request(`/runs/${run.id}/artifacts`)).json()) as { files: string[] };
        assert.ok(files.includes("results.json") && files.includes("spec.ts"));
        assert.ok(!files.some((file) => file.startsWith("work/")));
        const { runsDir } = await import("../../src/core/paths");
        for (const file of files.filter((name) => /\.(json|ts|yml)$/.test(name))) {
            assert.ok(!(await fs.readFile(path.join(runsDir, run.id, file), "utf8")).includes("s3cret-value"), file);
        }
    });

    test("a preview override cannot receive saved credentials until its origin is explicitly allowed", { timeout: 120_000 }, async () => {
        const { getProfileByName, updateProfile } = await import("../../src/core/credentials/profiles");
        const project = await projectsRepository.createProject("Preview credential boundary", "http://127.0.0.1:1");
        await repoGit.ensureProjectRepo(project.id, { create: true });
        await createProfile(project.id, { name: "shopper", fields: [{ key: "password", value: "preview-trust-secret" }] });
        const feature = await writer.createFeatureInRepo(project.id, null, "Sign in", "");
        const steps = ["Open preview", "Enter password", "Submit credentials"];
        const testSource = `import { test, expect } from "specbook";
test("Preview credentials", async ({ page, step, secret }) => {
    await step("Open preview", async () => {
        await page.goto("/credential-preview");
    });
    await step("Enter password", async () => {
        await page.getByLabel("Password").fill(secret("shopper", "password"));
    });
    await step("Submit credentials", async () => {
        await page.getByRole("button", { name: "Continue" }).click();
        await expect(page.getByRole("heading")).toHaveText("Credentials received");
    });
});
`;
        const { spec } = await writer.createSpecInRepo({ projectId: project.id, featureId: feature.id, title: "Preview credentials", description: "",
            humanSpec: { preconditions: [], steps, expectedResult: "Credentials received", postconditions: [] }, testSource });
        assert.equal(spec.status, "unverified", spec.invalidReason ?? "");
        previewCredentials.length = 0;
        const blocked = await executeSpec(spec.id, { baseUrl });
        assert.equal(blocked.status, "failed");
        assert.equal(blocked.failedStep, "Enter password");
        assert.match(blocked.failReason ?? "", /current page origin is not allowed/);
        assert.deepEqual(previewCredentials, [], "neither typing events nor form submission may expose the saved secret");
        const profile = (await getProfileByName(project.id, "shopper"))!;
        await updateProfile(profile, { allowedOrigins: [new URL(baseUrl).origin], fields: [{ key: "password" }] });
        const allowed = await executeSpec(spec.id, { baseUrl });
        assert.equal(allowed.status, "passed", allowed.failReason ?? "");
        assert.ok(previewCredentials.some((body) => body === "preview-trust-secret" || body === "password=preview-trust-secret"), "explicitly trusted preview receives the credential");
        assert.equal((await projectsRepository.getProject(project.id))?.baseUrl, "http://127.0.0.1:1", "a run override does not change the canonical trusted origin");
    });
});

describe("proposal verification", { skip: available ? false : "Chromium is not installed" }, () => {
    test("verifies in the failed preview environment, preserves the contract, and applies on approval", async () => {
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { specsRepository } = await import("../../src/infra/repositories/specs");
        const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
        const { proposeMutation, applyProposal } = await import("../../src/core/jobs/proposals");
        const { verifyProposal } = await import("../../src/core/jobs/verification");
        const { reindexProject } = await import("../../src/core/repo/indexer");
        const { VALID_SPEC, HUMAN_SPEC } = await import("../helpers/storage");
        const project = await projectsRepository.createProject("Candidate", baseUrl);
        await repoGit.ensureProjectRepo(project.id, { create: true });
        const feature = await writer.createFeatureInRepo(project.id, null, "Candidate", "");
        const { spec } = await writer.createSpecInRepo({ projectId: project.id, featureId: feature.id, title: "Candidate", description: "", humanSpec: HUMAN_SPEC, testSource: VALID_SPEC });
        const directory = path.join(repoGit.getRepoDir(project.id), spec.path);
        const yaml = await fs.readFile(path.join(directory, "spec.yml"), "utf8");
        const { runsRepository } = await import("../../src/infra/repositories/runs");
        const originalRun = await runsRepository.createRun({ specId: spec.id, commitSha: await repoGit.getHeadSha(project.id), sourceHash: spec.sourceHash, baseUrl });
        await runsRepository.finishRun(originalRun.id, "failed", 1, "Preview locator drift");
        await projectsRepository.updateProject(project.id, { baseUrl: "http://127.0.0.1:1" });
        const job = await jobsRepository.create({ projectId: project.id, runId: originalRun.id, chatId: "candidate-test", trigger: "manual", kind: "failure_triage", specId: spec.id, goal: "Heal", limits: jobLimitsSchema.parse({}) });
        const running = (await jobsRepository.claim(job.id))!;
        await jobsRepository.update(job.id, { classification: "test_drift" });
        await assert.rejects(() => proposeMutation(running, "update_spec", { specId: spec.id, humanSpec: HUMAN_SPEC, testSource: VALID_SPEC }), /implementation/);
        const proposal = await proposeMutation(running, "update_spec", { specId: spec.id, testSource: VALID_SPEC.replace('page.goto("/")', 'page.goto("/home")') });
        await assert.rejects(() => applyProposal(proposal), /passing verification/);
        const head = await repoGit.getHeadSha(project.id);
        const result = await verifyProposal(running, proposal);
        assert.equal(result.status, "passed", result.failReason ?? "");
        assert.equal(result.baseUrl, baseUrl);
        assert.ok(result.screenshots.length);
        assert.equal(await repoGit.getHeadSha(project.id), head);
        assert.equal((await specsRepository.getSpec(spec.id))?.status, "unverified");
        assert.equal(await fs.readFile(path.join(directory, "spec.ts"), "utf8"), VALID_SPEC);
        // Approval of another Spec must not stale an independent proposal.
        await writer.createFeatureInRepo(project.id, null, "Unrelated", "");
        await applyProposal((await jobsRepository.item(proposal.id))!);
        assert.equal(await fs.readFile(path.join(directory, "spec.yml"), "utf8"), yaml);
        assert.equal(await fs.readFile(path.join(directory, "spec.ts"), "utf8"), VALID_SPEC.replace('page.goto("/")', 'page.goto("/home")'));
    });
});

describe("scheduled runs", () => {
    test("evaluates numeric cron expressions in UTC and rejects invalid or impossible dates", async () => {
        const { nextCronAt, automationSettingsSchema } = await import("../../src/core/jobs/schedules");
        assert.equal(nextCronAt("*/15 9-17 * * 1-5", new Date("2026-10-06T17:59:00Z")), "2026-10-07T09:00:00.000Z");
        assert.equal(nextCronAt("30 4 1,15 * 5", new Date("2026-10-01T04:30:00Z")), "2026-10-02T04:30:00.000Z");
        assert.equal(nextCronAt("0 0 29 2 *", new Date("2025-01-01T00:00:00Z")), "2028-02-29T00:00:00.000Z");
        assert.equal(nextCronAt("0 0 * * 7", new Date("2026-10-06T00:00:00Z")), "2026-10-11T00:00:00.000Z");
        assert.equal(nextCronAt("*/35 * * * *", new Date("2026-10-06T00:35:00Z")), "2026-10-06T01:00:00.000Z");
        for (const cron of ["60 * * * *", "* * *", "*/0 * * * *", "0 0 30 2 *", "0 0 * * 8"]) {
            assert.throws(() => nextCronAt(cron), /Cron|cron/, cron);
        }
        assert.ok(automationSettingsSchema.safeParse({}).success, "every setting is optional");
        for (const webhookUrl of ["not-a-url", "file:///tmp/private", "https://name:password@example.com/hook"]) {
            assert.equal(automationSettingsSchema.safeParse({ webhookUrl }).success, false);
        }
    });

    test("keeps webhook credentials encrypted and accepts partial optional settings", async () => {
        const { createSchedulesRouter } = await import("../../src/infra/web/routes/schedules");
        const { db } = await import("../../src/infra/db/client");
        const { projectAutomations } = await import("../../src/infra/db/schema");
        const { eq } = await import("drizzle-orm");
        const project = await projectsRepository.createProject("Schedules", baseUrl);
        const router = createSchedulesRouter();
        const endpoint = `/projects/${project.id}/automation`;
        const update = (body: unknown) => router.request(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        assert.equal((await router.request("/projects/missing/automation")).status, 404);
        const initial = await (await router.request(endpoint)).json();
        assert.equal(initial.automation.cron, null);
        assert.equal(initial.automation.healFailures, true);
        assert.deepEqual(initial.automation.specIds, []);
        assert.equal((await update({})).status, 200);
        assert.equal((await update({ cron: "no cron" })).status, 400);
        assert.equal((await update({ specIds: ["00000000-0000-4000-8000-000000000001"] })).status, 400);
        const webhookUrl = "https://example.com/hooks/private-token";
        const saved = await (await update({ cron: "0 12 * * *", webhookUrl, healFailures: false })).json();
        assert.ok(Array.isArray(saved.notifications), "saving returns the same response shape as loading");
        assert.equal(saved.automation.webhookConfigured, true);
        assert.equal(saved.automation.webhookHost, "example.com");
        assert.ok(saved.automation.nextRunAt);
        assert.ok(!JSON.stringify(saved).includes("private-token"));
        const [stored] = await db.select().from(projectAutomations).where(eq(projectAutomations.projectId, project.id));
        assert.ok(stored?.webhookUrl?.startsWith("v1:"));
        assert.ok(!stored?.webhookUrl?.includes("private-token"));
        const disabled = await (await update({ cron: null })).json();
        assert.equal(disabled.automation.nextRunAt, null);
        assert.equal(disabled.automation.webhookConfigured, true, "omitting the URL preserves it");
        assert.equal(disabled.automation.healFailures, false);
        const removed = await (await update({ webhookUrl: null })).json();
        assert.equal(removed.automation.webhookConfigured, false);
    });

    test("scheduled prerequisites ask once and resume the saved selection in observation mode", { skip: !available, timeout: 120_000 }, async () => {
        const { schedulesRepository } = await import("../../src/infra/repositories/schedules");
        const { runsRepository } = await import("../../src/infra/repositories/runs");
        const { updateAutomation, processSchedules } = await import("../../src/core/jobs/schedules");
        const { getRunBatch } = await import("../../src/core/runner/batch");
        const { stopJobWorker } = await import("../../src/core/jobs/worker");
        const { VALID_SPEC, HUMAN_SPEC } = await import("../helpers/storage");
        stopJobWorker();
        const project = await projectsRepository.createProject("Scheduled sign-in", baseUrl);
        await repoGit.ensureProjectRepo(project.id, { create: true });
        await stewardRepository.update(project.id, { autonomy: "observe" });
        const feature = await writer.createFeatureInRepo(project.id, null, "Sign in", "");
        const source = VALID_SPEC.replace("({ page, step })", "({ page, step, secret })")
            .replace('await page.goto("/");', 'await page.goto("/");\n        await page.getByLabel("Password").fill(secret("shopper", "password"));');
        const { spec } = await writer.createSpecInRepo({ projectId: project.id, featureId: feature.id, title: "Scheduled sign-in", description: "", humanSpec: HUMAN_SPEC, testSource: source });
        const { spec: unselected } = await writer.createSpecInRepo({ projectId: project.id, featureId: feature.id, title: "Unselected", description: "", humanSpec: HUMAN_SPEC, testSource: VALID_SPEC });
        const head = await repoGit.getHeadSha(project.id);
        await updateAutomation(project.id, { cron: "* * * * *", specIds: [spec.id], healFailures: false, webhookUrl: "https://example.com/schedule-events" });
        const at = new Date();
        const dueAt = new Date(at.getTime() - 300_000).toISOString();
        try {
            await schedulesRepository.update(project.id, { nextRunAt: dueAt });
            await Promise.all([processSchedules(at), processSchedules(at)]);
            const questions = await jobsRepository.inbox(project.id);
            assert.equal(questions.length, 1);
            const question = questions[0]!;
            const [intent] = await stewardRepository.intents(project.id);
            assert.equal(intent?.source, "event");
            assert.equal(question.payload.waitingFor, "credentials");
            assert.equal(question.payload.runIntentId, intent?.id);
            assert.equal((await jobsRepository.get(question.jobId))?.status, "blocked");
            assert.deepEqual(await runsRepository.listRuns(spec.id), []);
            assert.deepEqual((await stewardRepository.signals(project.id)).map((signal) => signal.kind), ["schedule"]);
            assert.equal((await schedulesRepository.get(project.id))?.lastBatchId, null);

            for (let index = 0; index < 301; index++) {
                await stewardRepository.signal({ projectId: project.id, key: `later-event:${index}`, kind: "observation", title: "Later observation", body: "No requested work." });
            }
            assert.equal((await stewardRepository.signals(project.id)).length, 300);
            assert.equal((await stewardRepository.signals(project.id)).some((signal) => signal.kind === "schedule"), false, "the original occurrence is outside the presentation window");

            await schedulesRepository.update(project.id, { nextRunAt: new Date(at.getTime() - 1000).toISOString() });
            await processSchedules(at);
            await processProjectSteward(project.id, false);
            assert.equal((await jobsRepository.inbox(project.id)).length, 1, "missed ticks reuse the unresolved prerequisite");
            assert.equal((await stewardRepository.intents(project.id)).length, 1);

            await stewardRepository.update(project.id, { paused: true });
            await createProfile(project.id, { name: "shopper", fields: [{ key: "password", value: "scheduled-test-secret" }] });
            await stewardRepository.signal({ projectId: project.id, key: "credentials:scheduled-test", kind: "credentials_changed", title: "Access available", body: "The requested profile is available." });
            await processProjectSteward(project.id, false);
            assert.equal((await jobsRepository.item(question.id))?.status, "pending");
            assert.deepEqual(await runsRepository.listRuns(spec.id), []);

            // Later settings must not replace the occurrence's selection or healer policy.
            await updateAutomation(project.id, { specIds: [unselected.id], healFailures: true });
            await stewardRepository.update(project.id, { paused: false });
            await Promise.all([processProjectSteward(project.id, false), processProjectSteward(project.id, false)]);
            const resumed = (await stewardRepository.intents(project.id)).filter((row) => row.key.startsWith(`resume-run:${intent!.id}:`));
            assert.equal(resumed.length, 1);
            assert.equal(resumed[0]?.source, "event");
            assert.deepEqual(resumed[0]?.intent.specIds, [spec.id]);
            let batch = await getRunBatch(resumed[0]!.batchId!);
            assert.equal(batch?.trigger, "schedule");
            assert.equal((await schedulesRepository.get(project.id))?.lastBatchId, batch?.id);
            assert.equal((await runsRepository.getRun(batch!.specs[0]!.runId))?.healOnFailure, false);
            assert.equal((await jobsRepository.item(question.id))?.status, "answered");
            const deadline = Date.now() + 60_000;
            while (batch?.status === "running" && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                batch = await getRunBatch(resumed[0]!.batchId!);
            }
            assert.equal(batch?.status, "passed", batch?.failReason ?? "");
            assert.deepEqual(batch?.specs.map((entry) => entry.specId), [spec.id]);
            assert.deepEqual(await runsRepository.listRuns(unselected.id), []);
            await updateAutomation(project.id, { cron: null });
            const originalFetch = globalThis.fetch;
            globalThis.fetch = async () => new Response(null, { status: 200 });
            try { await processSchedules(); } finally { globalThis.fetch = originalFetch; }
            assert.equal((await schedulesRepository.get(project.id))?.lastBatchStatus, "passed");
            assert.equal((await schedulesRepository.get(project.id))?.lastError, null);
            assert.deepEqual((await schedulesRepository.notifications(project.id)).map((row) => row.status).sort(), ["passed", "running"]);
            assert.equal((await jobsRepository.list(project.id)).length, 1);
            assert.equal((await jobsRepository.get(question.jobId))?.tokensUsed, 0);
            assert.equal((await jobsRepository.get(question.jobId))?.actionsUsed, 0);
            assert.equal(await repoGit.getHeadSha(project.id), head);
        } finally { await updateAutomation(project.id, { cron: null, webhookUrl: null }); }
    });

    test("coalesces missed ticks, avoids overlap and persists webhook retries and recovered status", { skip: !available, timeout: 120_000 }, async () => {
        const { schedulesRepository } = await import("../../src/infra/repositories/schedules");
        const { specsRepository } = await import("../../src/infra/repositories/specs");
        const { runsRepository } = await import("../../src/infra/repositories/runs");
        const { updateAutomation, processSchedules, deliverWebhookNotifications } = await import("../../src/core/jobs/schedules");
        const { getRunBatch, getRunBatchDirectory, markInterruptedBatches } = await import("../../src/core/runner/batch");
        const { VALID_SPEC, HUMAN_SPEC } = await import("../helpers/storage");
        const { db } = await import("../../src/infra/db/client");
        const { webhookNotifications } = await import("../../src/infra/db/schema");
        const { eq } = await import("drizzle-orm");
        const messages: Record<string, unknown>[] = [];
        let calls = 0;
        let alwaysReject = false;
        const webhook = http.createServer(async (request, response) => {
            let body = "";
            for await (const chunk of request) body += chunk;
            messages.push(JSON.parse(body));
            response.statusCode = ++calls === 1 || alwaysReject ? 503 : 200;
            response.end();
        });
        await new Promise<void>((resolve) => webhook.listen(0, "127.0.0.1", resolve));
        try {
            const project = await projectsRepository.createProject("Scheduled store", baseUrl);
            await repoGit.ensureProjectRepo(project.id, { create: true });
            const feature = await writer.createFeatureInRepo(project.id, null, "Scheduled", "");
            const { spec } = await writer.createSpecInRepo({ projectId: project.id, featureId: feature.id, title: "Store", description: "", humanSpec: HUMAN_SPEC, testSource: VALID_SPEC });
            await specsRepository.createSpecRecord({ projectId: project.id, featureId: feature.id, title: "Invalid", description: "", path: "specs/invalid", sourceHash: "", markdownHash: "", status: "invalid" });
            await updateAutomation(project.id, {
                cron: "* * * * *", healFailures: false,
                webhookUrl: `http://127.0.0.1:${(webhook.address() as AddressInfo).port}/private-token`,
            });
            const at = new Date();
            await schedulesRepository.update(project.id, { nextRunAt: new Date(at.getTime() - 300_000).toISOString() });
            await processSchedules(at);
            const scheduled = (await schedulesRepository.get(project.id))!;
            assert.ok(scheduled.lastBatchId);
            assert.ok(Date.parse(scheduled.nextRunAt!) > at.getTime(), "missed occurrences become one batch");
            const batch = (await getRunBatch(scheduled.lastBatchId!))!;
            assert.equal(batch.specs.length, 1, "all means runnable Specs only");
            assert.equal(batch.specs[0]?.specId, spec.id);
            assert.equal((await runsRepository.getRun(batch.specs[0]!.runId))?.automationPending, true);
            assert.equal((await runsRepository.getRun(batch.specs[0]!.runId))?.healOnFailure, false);
            await schedulesRepository.update(project.id, { nextRunAt: new Date(at.getTime() - 1000).toISOString() });
            await processSchedules(new Date(at.getTime() + 1));
            assert.equal((await schedulesRepository.get(project.id))?.lastBatchId, batch.id, "active batch is retained");
            const [retry] = await schedulesRepository.notifications(project.id);
            assert.equal(retry?.attempts, 1);
            assert.equal(retry?.lastError, "Webhook returned HTTP 503");
            assert.ok(retry?.nextAttemptAt);
            const [rawNotification] = await db.select().from(webhookNotifications).where(eq(webhookNotifications.id, retry!.id));
            assert.ok(rawNotification?.webhookUrl.startsWith("v1:"));
            assert.ok(!JSON.stringify(rawNotification?.payload).includes("private-token"));
            await deliverWebhookNotifications(new Date(at.getTime() + 11_000));
            const [delivered] = await schedulesRepository.notifications(project.id);
            assert.equal(delivered?.attempts, 2);
            assert.ok(delivered?.deliveredAt);
            assert.equal(messages[0]?.eventId, messages[1]?.eventId, "retry uses a stable event id");
            assert.ok(typeof messages[0]?.text === "string", "payload works with Slack incoming webhooks");
            for (let attempt = 0; attempt < 100 && (await getRunBatch(batch.id))?.status === "running"; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            assert.equal((await getRunBatch(batch.id))?.status, "passed");
            await updateAutomation(project.id, { cron: null });
            await processSchedules(new Date(at.getTime() + 12_000));
            assert.equal((await schedulesRepository.get(project.id))?.lastBatchStatus, "passed");
            assert.equal(messages.filter((message) => message.status === "passed").length, 1);
            await processSchedules(new Date(at.getTime() + 13_000));
            assert.equal(messages.filter((message) => message.status === "passed").length, 1, "polling does not duplicate events");

            // Boot marks interrupted batches first; the scheduler then observes the persisted terminal status.
            const interrupted = { ...(await getRunBatch(batch.id))!, id: crypto.randomUUID(), status: "running" };
            const directory = getRunBatchDirectory(interrupted.id);
            await fs.mkdir(directory, { recursive: true });
            await fs.writeFile(path.join(directory, "batch.json"), JSON.stringify(interrupted));
            await schedulesRepository.update(project.id, { lastBatchId: interrupted.id, lastBatchStatus: "running" });
            await markInterruptedBatches();
            await processSchedules(new Date(at.getTime() + 14_000));
            assert.equal((await schedulesRepository.get(project.id))?.lastBatchStatus, "error");
            assert.equal(messages.filter((message) => message.status === "error").length, 1);

            alwaysReject = true;
            const failedDeliveryId = crypto.randomUUID();
            await schedulesRepository.recordBatch(project.id, failedDeliveryId, "failed", {
                webhookUrl: (await schedulesRepository.get(project.id))!.webhookUrl!, payload: { text: "Bounded retry" },
            });
            for (let attempt = 0; attempt < 6; attempt++) {
                await deliverWebhookNotifications(new Date(at.getTime() + (attempt + 1) * 600_001));
            }
            const exhausted = (await schedulesRepository.notifications(project.id)).find((item) => item.batchId === failedDeliveryId);
            assert.equal(exhausted?.attempts, 5);
            assert.equal(exhausted?.nextAttemptAt, null);
            assert.equal(exhausted?.lastError, "Webhook returned HTTP 503");
        } finally {
            webhook.closeAllConnections();
            await new Promise<void>((resolve) => webhook.close(() => resolve()));
        }
    });
});

describe("failure retry", { skip: available ? false : "Chromium is not installed" }, () => {
    async function failingSpec(route: string) {
        const project = await projectsRepository.createProject("Retry", baseUrl);
        await repoGit.ensureProjectRepo(project.id, { create: true });
        const feature = await writer.createFeatureInRepo(project.id, null, "Retry", "");
        const source = `import { test, expect } from "specbook";
test("Store", async ({ page, step }) => {
    await step("See the store", async () => {
        await page.goto("${route}");
        await expect(page.getByRole("heading")).toHaveText("Ready", { timeout: 500 });
    });
});`;
        const humanSpec = { preconditions: [], steps: ["See the store"], expectedResult: "Ready", postconditions: [] };
        const { spec } = await writer.createSpecInRepo({ projectId: project.id, featureId: feature.id, title: "Store", description: "", humanSpec, testSource: source });
        return { project, spec, source, humanSpec };
    }

    test("pass on retry retains both attempts, marks flaky, and skips healing even after recovery", async () => {
        const { processRunFailures } = await import("../../src/core/jobs/failures");
        const { runsRepository } = await import("../../src/infra/repositories/runs");
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { stewardRepository } = await import("../../src/infra/repositories/steward");
        const { db } = await import("../../src/infra/db/client");
        const { runs } = await import("../../src/infra/db/schema");
        const { eq } = await import("drizzle-orm");
        const { project, spec } = await failingSpec("/flaky");
        const original = await executeSpec(spec.id, { automate: true });
        assert.equal(original.status, "failed");
        await processRunFailures();
        const history = await runsRepository.listRuns(spec.id);
        assert.equal(history.length, 2);
        const retry = history.find((run) => run.retryOf === original.id)!;
        assert.equal(retry.status, "passed");
        assert.ok(history.every((run) => run.flaky));
        assert.equal((await jobsRepository.list(project.id)).length, 0);
        assert.equal((await stewardRepository.signals(project.id)).length, 0);
        assert.equal((await runsRepository.getRun(original.id))?.automationPending, false);
        await db.update(runs).set({ automationPending: true }).where(eq(runs.id, original.id));
        await processRunFailures();
        assert.equal((await runsRepository.listRuns(spec.id)).length, 2);
        assert.equal((await jobsRepository.list(project.id)).length, 0);
    });

    test("healer opt-out still retries once, while a changed contract skips both retry and healing", async () => {
        const { processRunFailures } = await import("../../src/core/jobs/failures");
        const { runsRepository } = await import("../../src/infra/repositories/runs");
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { project, spec } = await failingSpec("/always-fails");
        const original = await executeSpec(spec.id, { automate: true, healOnFailure: false });
        await processRunFailures();
        const history = await runsRepository.listRuns(spec.id);
        assert.equal(history.length, 2);
        assert.ok(history.every((run) => run.status === "failed" && !run.flaky));
        assert.equal((await jobsRepository.list(project.id)).length, 0);
        await processRunFailures();
        assert.equal((await runsRepository.listRuns(spec.id)).length, 2);

        const changed = await failingSpec("/changed-contract");
        const stale = await executeSpec(changed.spec.id, { automate: true });
        await writer.updateSpecWithLock(changed.spec.id, { humanSpec: { ...changed.humanSpec, expectedResult: "New behavior" } });
        await processRunFailures();
        assert.equal((await runsRepository.listRuns(changed.spec.id)).length, 1);
        assert.equal((await runsRepository.getRun(stale.id))?.automationPending, false);
        assert.equal((await jobsRepository.list(changed.project.id)).length, 0);
        assert.equal((await runsRepository.getRun(original.id))?.automationPending, false);
    });

    test("project and global agent pause do not prevent the retry from completing CI reporting", async () => {
        const { processRunFailures } = await import("../../src/core/jobs/failures");
        const { runsRepository } = await import("../../src/infra/repositories/runs");
        const { settingsRepository } = await import("../../src/infra/repositories/settings");
        const { ciResult } = await import("../../src/core/ci/results");
        for (const global of [false, true]) {
            const { project, spec } = await failingSpec(`/flaky-paused-${global}`);
            const original = await executeSpec(spec.id, { automate: true });
            await stewardRepository.update(project.id, { paused: !global });
            await settingsRepository.setAgentPaused(global);
            try {
                await processRunFailures();
                const retry = (await runsRepository.retryFor(original.id))!;
                assert.equal(retry.status, "passed");
                assert.equal((await runsRepository.getRun(original.id))?.automationPending, false);
                const result = await ciResult({
                    id: "paused-ci", projectId: project.id, label: "CI", baseUrl, status: "failed", startedAt: original.startedAt,
                    durationMs: original.durationMs, failReason: original.failReason,
                    specs: [{ runId: original.id, specId: spec.id, commitSha: original.commitSha, sourceHash: original.sourceHash,
                        markdownHash: spec.markdownHash, title: spec.title, status: "failed", durationMs: original.durationMs, failReason: original.failReason }],
                });
                assert.equal(result.complete, true);
                assert.equal(result.qualityGate.flaky, 1);
                assert.equal(result.qualityGate.passed, true);
                assert.equal((await jobsRepository.list(project.id)).length, 0);
            } finally {
                await settingsRepository.setAgentPaused(false);
            }
        }
    });

    test("failed retry emits one steward signal, and interrupted retry is never repeated", async () => {
        const { processRunFailures } = await import("../../src/core/jobs/failures");
        const { runsRepository } = await import("../../src/infra/repositories/runs");
        const { stewardRepository } = await import("../../src/infra/repositories/steward");
        const { project, spec } = await failingSpec("/failure-signal");
        const original = await executeSpec(spec.id, { automate: true });
        await processRunFailures();
        const retry = (await runsRepository.retryFor(original.id))!;
        assert.equal(retry.status, "failed");
        assert.equal((await stewardRepository.signals(project.id))[0]?.payload.runId, retry.id);
        await processRunFailures();
        assert.equal((await stewardRepository.signals(project.id)).length, 1);
        assert.equal((await runsRepository.listRuns(spec.id)).length, 2);

        const recovered = await failingSpec("/interrupted-retry");
        const failed = await executeSpec(recovered.spec.id, { automate: true });
        const interrupted = await runsRepository.createRun({ specId: recovered.spec.id, commitSha: failed.commitSha, sourceHash: failed.sourceHash, retryOf: failed.id });
        await runsRepository.markInterruptedRuns();
        await processRunFailures();
        await processRunFailures();
        assert.equal((await runsRepository.listRuns(recovered.spec.id)).length, 2);
        assert.equal((await stewardRepository.signals(recovered.project.id))[0]?.payload.runId, interrupted.id);
        assert.equal((await stewardRepository.signals(recovered.project.id)).length, 1);
    });

    test("retry retains the preview URL even when the project's base URL changes", async () => {
        const { processRunFailures } = await import("../../src/core/jobs/failures");
        const { runsRepository } = await import("../../src/infra/repositories/runs");
        const { project, spec } = await failingSpec("/flaky-preview");
        const original = await executeSpec(spec.id, { automate: true, baseUrl });
        assert.equal(original.status, "failed");
        await projectsRepository.updateProject(project.id, { baseUrl: "http://127.0.0.1:1" });
        await processRunFailures();
        const retry = (await runsRepository.retryFor(original.id))!;
        assert.equal(retry.status, "passed");
        assert.equal(retry.baseUrl, baseUrl);
        assert.equal(retry.flaky, true);
    });

});

describe("autonomous pause and decisions", () => {
    const router = createJobsRouter();
    const post = (url: string, body?: unknown) => router.request(url, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    });

    before(async () => {
        const { stopJobWorker } = await import("../../src/core/jobs/worker");
        await stopJobWorker();
        const { createStewardRouter } = await import("../../src/infra/web/routes/steward");
        const { createSettingsRouter } = await import("../../src/infra/web/routes/settings");
        router.route("/", createStewardRouter());
        router.route("/", createSettingsRouter());
    });

    async function projectWithWork() {
        const project = await projectsRepository.createProject("Continuation", baseUrl);
        await stewardRepository.update(project.id, { autonomy: "propose" });
        return project;
    }

    async function createWork(projectId: string) {
        return jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "steward", kind: "explore",
            goal: "Investigate checkout", limits: jobLimitsSchema.parse({}) });
    }

    const put = (url: string, body: unknown) => router.request(url, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });

    test("migration preserves investigations and audit while removing quota storage", async () => {
        const { createClient } = await import("@libsql/client");
        const { tempDir } = await import("../helpers/storage");
        const client = createClient({ url: `file:${path.join(tempDir(), "pause-migration.db")}` });
        try {
            await client.executeMultiple(`
                CREATE TABLE app_settings (id INTEGER PRIMARY KEY, llm TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE TABLE project_stewards (project_id TEXT PRIMARY KEY, autonomy TEXT NOT NULL, extra_usage TEXT, updated_at TEXT NOT NULL);
                CREATE TABLE jobs (id TEXT PRIMARY KEY, budget TEXT NOT NULL, daily_usage TEXT, status TEXT NOT NULL, actions_used INTEGER NOT NULL, elapsed_ms INTEGER NOT NULL, tokens_used INTEGER NOT NULL, retry_at TEXT);
                CREATE TABLE job_actions (id INTEGER PRIMARY KEY, job_id TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
                CREATE TABLE inbox_items (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL);
            `);
            await client.execute({ sql: "INSERT INTO app_settings VALUES (1, ?, ?)", args: [JSON.stringify({ provider: "saved", model: "selected" }), "2026-10-01T00:00:00.000Z"] });
            await client.execute({ sql: "INSERT INTO project_stewards VALUES (?, ?, ?, ?)", args: ["project", "act", JSON.stringify({ date: "2026-10-01", tokens: 1000, wallTimeMs: 1000 }), "2026-10-01T00:00:00.000Z"] });
            await client.execute({ sql: "INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)", args: ["investigation", JSON.stringify({ maxTokens: 100_000, maxActions: 80, wallTimeMs: 600_000 }), JSON.stringify({ date: "2026-10-01", tokens: 100_000, wallTimeMs: 600_000 }), "budget_exceeded", 87, 650_000, 120_000, null] });
            await client.execute("INSERT INTO job_actions VALUES (1, 'investigation', 'inspected', 'Checkout button changed')");
            await client.execute("INSERT INTO inbox_items VALUES ('question', 'investigation', 'pending', 'Which account should sign in?')");
            const migration = await fs.readFile(new URL("../../drizzle/0016_colossal_warpath.sql", import.meta.url), "utf8");
            for (const statement of migration.split("--> statement-breakpoint")) await client.execute(statement.trim());
            const migrated = (await client.execute("SELECT * FROM jobs")).rows[0]!;
            assert.equal(migrated.status, "stalled");
            assert.equal(migrated.actions_used, 87);
            assert.equal(migrated.elapsed_ms, 650_000);
            assert.equal(migrated.tokens_used, 120_000);
            assert.deepEqual(JSON.parse(String(migrated.limits)), { maxActions: 587, wallTimeMs: 4250_000 });
            assert.ok(migrated.retry_at);
            assert.ok(migrated.stop_reason);
            assert.equal(migrated.safety_retries, 0);
            assert.equal("budget" in migrated, false);
            assert.equal("daily_usage" in migrated, false);
            const settings = (await client.execute("SELECT * FROM app_settings")).rows[0]!;
            assert.equal(settings.agent_paused, 0);
            assert.deepEqual(JSON.parse(String(settings.llm)), { provider: "saved", model: "selected" });
            const steward = (await client.execute("SELECT * FROM project_stewards")).rows[0]!;
            assert.equal(steward.autonomy, "act");
            assert.equal(steward.paused, 0);
            assert.equal("extra_usage" in steward, false);
            assert.equal((await client.execute("SELECT detail FROM job_actions")).rows[0]?.detail, "Checkout button changed");
            assert.equal((await client.execute("SELECT status FROM inbox_items")).rows[0]?.status, "pending");
        } finally { client.close(); }
    });

    test("project pause persists and resumes the same work while preserving questions and usage", async () => {
        const project = await projectWithWork();
        const queued = await createWork(project.id);
        await jobsRepository.recordUsage(queued.id, 25_000, 60_000);
        await jobsRepository.update(queued.id, { actionsUsed: 37 });
        const running = await createWork(project.id);
        await jobsRepository.claim(running.id);
        const blocked = await createWork(project.id);
        await jobsRepository.update(blocked.id, { status: "blocked" });
        const question = await jobsRepository.addItem({ projectId: project.id, jobId: blocked.id, kind: "question", title: "Which account should sign in?", body: "Add access to continue." });
        const endpoint = `/projects/${project.id}/steward`;
        assert.deepEqual(await (await router.request(endpoint)).json(), { autonomy: "propose", paused: false, globallyPaused: false });
        assert.deepEqual(await (await put(endpoint, { paused: true })).json(), { autonomy: "propose", paused: true, globallyPaused: false });
        assert.equal((await jobsRepository.get(queued.id))?.status, "paused");
        assert.equal((await jobsRepository.get(running.id))?.status, "paused");
        assert.equal((await jobsRepository.get(blocked.id))?.status, "blocked");
        const intent = await enqueueIntent(project.id, { kind: "explore", goal: "Explore checkout", reason: "Human requested exploration" }, "pause-pending", "user");
        await processProjectSteward(project.id, false);
        assert.equal((await stewardRepository.intents(project.id)).find((row) => row.id === intent.id)?.status, "pending");
        await jobsRepository.recover();
        assert.equal((await jobsRepository.get(queued.id))?.status, "paused");
        assert.equal((await stewardRepository.get(project.id)).paused, true);
        await put(endpoint, { autonomy: "act" });
        assert.equal((await stewardRepository.get(project.id)).paused, true, "autonomy changes must not implicitly resume the agent");
        const resumed = await put(endpoint, { paused: false });
        assert.equal(resumed.status, 200);
        assert.deepEqual(await resumed.json(), { autonomy: "act", paused: false, globallyPaused: false });
        const retained = (await jobsRepository.get(queued.id))!;
        assert.equal(retained.status, "queued");
        assert.equal(retained.tokensUsed, 25_000);
        assert.equal(retained.elapsedMs, 60_000);
        assert.equal(retained.actionsUsed, 37);
        assert.deepEqual(retained.limits, queued.limits);
        assert.equal((await jobsRepository.get(running.id))?.status, "queued");
        assert.equal((await jobsRepository.get(blocked.id))?.status, "blocked");
        assert.equal((await jobsRepository.item(question.id))?.status, "pending");
        assert.equal((await jobsRepository.list(project.id)).length, 3);
        assert.equal((await post(`/projects/${project.id}/continue-now`)).status, 404);
    });

    test("global pause overrides project resume and preserves local pauses and model settings", async () => {
        const { settingsRepository } = await import("../../src/infra/repositories/settings");
        const { isAgentPaused } = await import("../../src/core/jobs/pause");
        const local = await projectWithWork();
        const other = await projectWithWork();
        const localJob = await createWork(local.id);
        const otherJob = await createWork(other.id);
        await settingsRepository.updateLlmSettings({ provider: "local-test", model: "no-provider-call" });
        assert.deepEqual(await (await router.request("/settings/agent")).json(), { paused: false });
        await put(`/projects/${local.id}/steward`, { paused: true });
        assert.deepEqual(await (await put("/settings/agent", { paused: true })).json(), { paused: true });
        assert.equal(await isAgentPaused(local.id), true);
        assert.equal(await isAgentPaused(other.id), true);
        assert.equal((await jobsRepository.get(otherJob.id))?.status, "paused");
        const stillPaused = await put(`/projects/${other.id}/steward`, { paused: false });
        assert.deepEqual(await stillPaused.json(), { autonomy: "propose", paused: false, globallyPaused: true });
        assert.equal((await jobsRepository.get(otherJob.id))?.status, "paused");
        await jobsRepository.recover();
        assert.equal(await settingsRepository.getAgentPaused(), true);
        await settingsRepository.updateLlmSettings({ provider: "local-test", model: "still-no-provider-call" });
        assert.equal(await settingsRepository.getAgentPaused(), true, "editing the model must preserve global pause");
        await put("/settings/agent", { paused: false });
        assert.equal(await isAgentPaused(local.id), true);
        assert.equal(await isAgentPaused(other.id), false);
        assert.equal((await jobsRepository.get(localJob.id))?.status, "paused");
        assert.equal((await jobsRepository.get(otherJob.id))?.status, "queued");
        assert.deepEqual(await settingsRepository.getLlmSettings(), { provider: "local-test", model: "still-no-provider-call" });
        await settingsRepository.updateLlmSettings({ provider: "", model: "" });
    });

    test("pausing retains queued triage evidence and running follow-up instructions", async () => {
        const project = await projectWithWork();
        const triageInstructions = "Investigate failed step Checkout using screenshot /evidence/failed.png and ARIA snapshot. Keep spec.yml unchanged.";
        const queued = await jobsRepository.create({ projectId: project.id, chatId: crypto.randomUUID(), trigger: "spec_failure", kind: "failure_triage",
            goal: "Investigate Checkout", pendingMessage: triageInstructions, limits: jobLimitsSchema.parse({}) });
        const running = await createWork(project.id);
        const followUp = "Human answer: use the operator account. Verify the saved draft before repeating the submission.";
        await jobsRepository.update(running.id, { pendingMessage: followUp });
        await jobsRepository.claim(running.id);
        const endpoint = `/projects/${project.id}/steward`;
        await put(endpoint, { paused: true });
        assert.equal((await jobsRepository.get(queued.id))?.pendingMessage, triageInstructions);
        const retained = (await jobsRepository.get(running.id))!.pendingMessage;
        assert.match(retained, /The human paused/);
        assert.ok(retained.endsWith(followUp));
        await put(endpoint, { paused: false });
        assert.equal((await jobsRepository.get(queued.id))?.pendingMessage, triageInstructions);
        await jobsRepository.claim(running.id);
        await put(endpoint, { paused: true });
        assert.equal((await jobsRepository.get(running.id))?.pendingMessage, retained, "repeated pauses must not duplicate the reminder or replace the original request");
    });

    test("concurrent resume requests preserve one investigation and reject invalid pause inputs", async () => {
        const project = await projectWithWork();
        const job = await createWork(project.id);
        const endpoint = `/projects/${project.id}/steward`;
        assert.equal((await put(endpoint, {})).status, 400);
        assert.equal((await put(endpoint, { paused: "true" })).status, 400);
        assert.equal((await put(endpoint, { paused: true, extraUsage: 1000 })).status, 400);
        assert.equal((await put("/settings/agent", {})).status, 400);
        assert.equal((await put("/settings/agent", { paused: "false" })).status, 400);
        assert.equal((await put("/settings/agent", { paused: true, autonomy: "observe" })).status, 400);
        assert.equal((await put("/projects/missing/steward", { paused: true })).status, 404);
        assert.equal((await router.request("/projects/missing/steward")).status, 404);
        await put(endpoint, { paused: true });
        const results = await Promise.all([put(endpoint, { paused: false }), put(endpoint, { paused: false })]);
        assert.deepEqual(results.map((response) => response.status), [200, 200]);
        assert.equal((await jobsRepository.get(job.id))?.status, "queued");
        assert.equal((await stewardRepository.get(project.id)).paused, false);
        assert.equal((await jobsRepository.list(project.id)).length, 1);
        assert.deepEqual((await jobsRepository.get(job.id))?.limits, job.limits);
        assert.equal((await jobsRepository.actions(job.id)).filter((entry) => entry.action === "resumed").length, 1);
    });

    test("past token and time usage never prevents a requested investigation", async () => {
        const project = await projectWithWork();
        const previous = await createWork(project.id);
        await jobsRepository.recordUsage(previous.id, 2_000_000, 36_000_000);
        await jobsRepository.update(previous.id, { status: "completed", actionsUsed: 3000 });
        const intent = await enqueueIntent(project.id, { kind: "explore", goal: "Investigate checkout", reason: "Human requested exploration" }, "no-usage-gate", "user");
        await Promise.all([processProjectSteward(project.id, false), processProjectSteward(project.id, false)]);
        const next = (await jobsRepository.get(intent.id))!;
        assert.ok(next);
        assert.equal(next.status, "queued");
        assert.deepEqual(next.limits, { maxActions: 500, wallTimeMs: 3_600_000 });
        assert.equal(next.tokensUsed, 0);
        assert.equal((await jobsRepository.list(project.id)).length, 2);
        assert.equal((await jobsRepository.get(previous.id))?.tokensUsed, 2_000_000);
    });

    test("stalled work retries with backoff twice, asks once, then uses the human answer", async () => {
        const { stallJob, retryStalledJob, MAX_SAFETY_RETRIES } = await import("../../src/core/jobs/retry");
        const project = await projectWithWork();
        const job = await createWork(project.id);
        await jobsRepository.claim(job.id);
        await jobsRepository.recordUsage(job.id, 900_000, 3_600_000);
        await jobsRepository.update(job.id, { actionsUsed: 500 });
        await jobsRepository.log(job.id, "browser_click:error", "The Checkout button remains unavailable after signing in.");
        for (let attempt = 0; attempt <= MAX_SAFETY_RETRIES; attempt++) {
            const before = Date.now();
            await stallJob((await jobsRepository.get(job.id))!, "No confirmed result");
            const stalled = (await jobsRepository.get(job.id))!;
            assert.equal(stalled.status, "stalled");
            assert.equal(stalled.safetyRetries, attempt);
            assert.match(stalled.stopReason ?? "", /Checkout button remains unavailable/);
            await jobsRepository.update(job.id, { startedAt: null });
            if (attempt === MAX_SAFETY_RETRIES) {
                await Promise.all([retryStalledJob(stalled), retryStalledJob(stalled)]);
                break;
            }
            assert.ok(Date.parse(stalled.retryAt!) >= before + 60_000 * 2 ** attempt);
            await retryStalledJob(stalled);
            assert.equal((await jobsRepository.get(job.id))?.status, "stalled", "a retry must respect its persisted backoff");
            await jobsRepository.update(job.id, { retryAt: "2000-01-01T00:00:00.000Z" });
            await Promise.all([retryStalledJob(stalled), retryStalledJob(stalled)]);
            const next = (await jobsRepository.get(job.id))!;
            assert.equal(next.status, "queued");
            assert.equal(next.safetyRetries, attempt + 1);
            assert.deepEqual(next.limits, { maxActions: next.actionsUsed + 500, wallTimeMs: next.elapsedMs + 3_600_000 });
            assert.equal(next.tokensUsed, 900_000);
            assert.match(next.pendingMessage, /different approach/);
            await jobsRepository.claim(job.id);
            await jobsRepository.update(job.id, { actionsUsed: next.limits.maxActions, elapsedMs: next.limits.wallTimeMs });
        }
        const blocked = (await jobsRepository.get(job.id))!;
        assert.equal(blocked.status, "blocked");
        await retryStalledJob(blocked);
        const questions = (await jobsRepository.inbox(project.id)).filter((item) => item.kind === "question");
        assert.equal(questions.length, 1);
        assert.equal(questions[0]?.payload.waitingFor, "investigation");
        assert.match(questions[0]!.body, /Checkout button remains unavailable/);
        const answer = await post(`/projects/${project.id}/inbox/${questions[0]!.id}/review`, { action: "answer", answer: "Sign in with the manager profile before opening checkout." });
        assert.equal(answer.status, 200);
        const resumed = (await jobsRepository.get(job.id))!;
        assert.equal(resumed.status, "queued");
        assert.equal(resumed.tokensUsed, blocked.tokensUsed);
        assert.equal(resumed.actionsUsed, blocked.actionsUsed);
        assert.equal(resumed.elapsedMs, blocked.elapsedMs);
        assert.deepEqual(resumed.limits, { maxActions: blocked.actionsUsed + 500, wallTimeMs: blocked.elapsedMs + 3_600_000 });
        assert.equal(resumed.safetyRetries, 0);
        assert.equal(resumed.stopReason, null);
        assert.match(resumed.pendingMessage, /manager profile/);
        assert.equal((await jobsRepository.item(questions[0]!.id))?.status, "answered");

        const interrupted = await createWork(project.id);
        await jobsRepository.update(interrupted.id, { status: "blocked", safetyRetries: MAX_SAFETY_RETRIES,
            stopReason: "The Checkout button remains unavailable after signing in." });
        await processProjectSteward(project.id, false);
        await processProjectSteward(project.id, false);
        const recoveredQuestions = (await jobsRepository.inbox(project.id)).filter((item) => item.jobId === interrupted.id && item.kind === "question");
        assert.equal(recoveredQuestions.length, 1, "restart between blocking and writing the question must recover it exactly once");
        assert.equal(recoveredQuestions[0]?.payload.waitingFor, "investigation");
    });

    test("project and global pause stop tools before mutation without token-based limits", async () => {
        const { createJobPolicy } = await import("../../src/core/jobs/policy");
        const { settingsRepository } = await import("../../src/infra/repositories/settings");
        const { Type } = await import("@earendil-works/pi-ai");
        const { z } = await import("zod");
        for (const scope of ["project", "global"]) {
            const project = await projectWithWork();
            const job = await createWork(project.id);
            const running = (await jobsRepository.claim(job.id))!;
            let mutations = 0;
            let aborted = false;
            const policy = createJobPolicy(running, () => { aborted = true; });
            const tool = policy.tools([{ name: "local_test_mutation", label: "Local test", description: "Count a local mutation", parameters: Type.Unsafe(z.object({}).toJSONSchema()),
                async execute() { mutations++; return { content: [], details: undefined }; } }])[0]!;
            policy.tokens(5_000_000);
            await policy.flush();
            await tool.execute("before-pause", {}, undefined, undefined, {} as never);
            assert.equal(mutations, 1, "token accounting is audit, not a scheduling or tool limit");
            try {
                if (scope === "global") await settingsRepository.setAgentPaused(true);
                else await stewardRepository.update(project.id, { paused: true });
                await assert.rejects(() => tool.execute("after-pause", {}, undefined, undefined, {} as never), /paused/i);
                assert.equal(mutations, 1);
                assert.equal(aborted, true);
                const paused = (await jobsRepository.get(job.id))!;
                assert.equal(paused.status, "paused");
                assert.equal(paused.tokensUsed, 5_000_000);
                assert.equal(paused.actionsUsed, 1);
                assert.deepEqual(paused.limits, running.limits);
            } finally { await settingsRepository.setAgentPaused(false); }
        }
    });

    test("backend recovery retains interrupted time and cumulative usage exactly once", async () => {
        const { retryStalledJob } = await import("../../src/core/jobs/retry");
        const project = await projectWithWork();
        const job = await createWork(project.id);
        await jobsRepository.recordUsage(job.id, 1500, 5000);
        await jobsRepository.update(job.id, { status: "running", startedAt: new Date(Date.now() - 30_000).toISOString() });
        const stalled = await createWork(project.id);
        await jobsRepository.update(stalled.id, { status: "stalled", retryAt: "2000-01-01T00:00:00.000Z", startedAt: new Date(Date.now() - 20_000).toISOString() });
        await jobsRepository.recover();
        const recovered = (await jobsRepository.get(job.id))!;
        assert.equal(recovered.status, "queued");
        assert.equal(recovered.startedAt, null);
        assert.ok(recovered.elapsedMs >= 35_000);
        assert.equal(recovered.tokensUsed, 1500);
        const interruptedStall = (await jobsRepository.get(stalled.id))!;
        assert.equal(interruptedStall.status, "stalled");
        assert.equal(interruptedStall.startedAt, null);
        assert.ok(interruptedStall.elapsedMs >= 20_000);
        await retryStalledJob(interruptedStall);
        assert.equal((await jobsRepository.get(stalled.id))?.status, "queued");
        assert.equal((await jobsRepository.get(stalled.id))?.safetyRetries, 1);
        await jobsRepository.recover();
        assert.equal((await jobsRepository.get(job.id))?.elapsedMs, recovered.elapsedMs);
        assert.equal((await jobsRepository.actions(job.id)).filter((entry) => entry.action === "recovered").length, 1);
    });

    test("infrastructure failures persist a delayed retry and scrub details without asking the human", async () => {
        const { retryInfrastructure } = await import("../../src/core/jobs/retry");
        const project = await projectWithWork();
        await createProfile(project.id, { name: "operator", fields: [{ key: "password", value: "infrastructure-secret-value" }] });
        const job = await createWork(project.id);
        const running = (await jobsRepository.claim(job.id))!;
        const before = Date.now();
        await retryInfrastructure(running, "Browser unavailable: infrastructure-secret-value");
        const queued = (await jobsRepository.get(job.id))!;
        assert.equal(queued.status, "queued");
        assert.equal(queued.infrastructureRetries, 1);
        assert.ok(Date.parse(queued.retryAt!) >= before + 15_000);
        assert.ok(!queued.systemError?.includes("infrastructure-secret-value"));
        assert.match(queued.pendingMessage ?? "", /not a question for the human/);
        await jobsRepository.recover();
        await retryInfrastructure(running, "Duplicate callback");
        assert.equal((await jobsRepository.get(job.id))?.retryAt, queued.retryAt);
        assert.equal((await jobsRepository.get(job.id))?.infrastructureRetries, 1);
        await retryInfrastructure((await jobsRepository.claim(job.id))!, "LLM provider temporarily unavailable");
        const second = (await jobsRepository.get(job.id))!;
        assert.equal(second.infrastructureRetries, 2);
        assert.ok(Date.parse(second.retryAt!) >= before + 30_000);
        assert.deepEqual(await jobsRepository.inbox(project.id), []);
        const actions = await jobsRepository.actions(job.id);
        assert.equal(actions.filter((entry) => entry.action === "service_retry").length, 2);
        assert.ok(!JSON.stringify(actions).includes("infrastructure-secret-value"));
    });

    test("report bug rejects a suggested fix once, leaves both files untouched and enforces project isolation", async () => {
        const { VALID_SPEC, HUMAN_SPEC } = await import("../helpers/storage");
        const { proposeMutation } = await import("../../src/core/jobs/proposals");
        const project = await projectWithWork();
        const other = await projectWithWork();
        await repoGit.ensureProjectRepo(project.id, { create: true });
        const feature = await writer.createFeatureInRepo(project.id, null, "Checkout", "");
        const { spec } = await writer.createSpecInRepo({ projectId: project.id, featureId: feature.id, title: "Checkout", description: "", humanSpec: HUMAN_SPEC, testSource: VALID_SPEC });
        const job = await createWork(project.id);
        const item = await proposeMutation(job, "update_spec", { specId: spec.id, testSource: VALID_SPEC.replace('page.goto("/")', 'page.goto("/checkout")') });
        const directory = path.join(repoGit.getRepoDir(project.id), spec.path);
        const yaml = await fs.readFile(path.join(directory, "spec.yml"), "utf8");
        const head = await repoGit.getHeadSha(project.id);
        const endpoint = `/projects/${project.id}/inbox/${item.id}/review`;
        assert.equal((await post(`/projects/${other.id}/inbox/${item.id}/review`, { action: "report_bug" })).status, 404);
        assert.equal((await jobsRepository.item(item.id))?.status, "pending");
        const responses = await Promise.all([post(endpoint, { action: "report_bug" }), post(endpoint, { action: "report_bug" })]);
        assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
        assert.equal((await jobsRepository.item(item.id))?.status, "rejected");
        assert.equal((await post(endpoint, { action: "approve" })).status, 409);
        const reports = (await jobsRepository.inbox(project.id)).filter((row) => row.kind === "bug_report");
        assert.equal(reports.length, 1);
        assert.equal(reports[0]?.payload.sourceItemId, item.id);
        assert.equal(reports[0]?.payload.specId, spec.id);
        assert.deepEqual(await jobsRepository.inbox(other.id), []);
        assert.equal(await fs.readFile(path.join(directory, "spec.ts"), "utf8"), VALID_SPEC);
        assert.equal(await fs.readFile(path.join(directory, "spec.yml"), "utf8"), yaml);
        assert.equal(await repoGit.getHeadSha(project.id), head);
    });

    test("ignore stops a paused investigation and prevents an equivalent automatic continuation", async () => {
        const { VALID_SPEC, HUMAN_SPEC } = await import("../helpers/storage");
        const project = await projectWithWork();
        await repoGit.ensureProjectRepo(project.id, { create: true });
        const feature = await writer.createFeatureInRepo(project.id, null, "Checkout", "");
        const { spec } = await writer.createSpecInRepo({ projectId: project.id, featureId: feature.id, title: "Checkout", description: "", humanSpec: HUMAN_SPEC, testSource: VALID_SPEC });
        const input = { kind: "regenerate", specIds: [spec.id], goal: "Repair checkout implementation", reason: "Checkout implementation is invalid" };
        const intent = await enqueueIntent(project.id, input, "first-check");
        await processProjectSteward(project.id, false);
        const job = (await jobsRepository.list(project.id))[0]!;
        assert.equal(job.id, intent.id);
        await jobsRepository.update(job.id, { status: "stalled" });
        const item = await jobsRepository.addItem({ jobId: job.id, projectId: project.id, kind: "question", title: "Continue checking checkout?", body: "The update still does not work." });
        assert.equal((await post(`/projects/${project.id}/inbox/${item.id}/review`, { action: "ignore" })).status, 200);
        assert.equal((await jobsRepository.get(job.id))?.status, "cancelled");
        assert.equal((await jobsRepository.item(item.id))?.payload.ignoredCheck, true);
        assert.equal((await post(`/projects/${project.id}/continue-now`)).status, 404);
        const next = await enqueueIntent(project.id, input, "later-check");
        await processProjectSteward(project.id, false);
        const ignored = (await stewardRepository.intents(project.id)).find((row) => row.id === next.id)!;
        assert.equal(ignored.status, "ignored");
        assert.match(ignored.reason, /human rejected/i);
        assert.equal((await jobsRepository.list(project.id)).length, 1);
    });

    test("scope migration retires unsolicited work while retaining human requests and findings", async () => {
        const { createClient } = await import("@libsql/client");
        const { tempDir } = await import("../helpers/storage");
        const client = createClient({ url: `file:${path.join(tempDir(), "event-scope-migration.db")}` });
        try {
            await client.executeMultiple(`
                CREATE TABLE project_stewards (project_id TEXT PRIMARY KEY, last_planner_at TEXT);
                CREATE TABLE steward_intents (id TEXT PRIMARY KEY, key TEXT NOT NULL, intent TEXT NOT NULL, job_id TEXT, status TEXT NOT NULL, reason TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE TABLE jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, trigger TEXT NOT NULL, status TEXT NOT NULL, retry_at TEXT, stop_reason TEXT, updated_at TEXT NOT NULL, tokens_used INTEGER NOT NULL);
                CREATE TABLE job_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
                CREATE TABLE inbox_items (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
                INSERT INTO project_stewards VALUES ('project', '2026-10-01T00:00:00.000Z');
            `);
            const rows = [
                ["planner", "planner", "steward", "queued", "planner:date"],
                ["coverage", "coverage", "steward", "blocked", "signal:empty"],
                ["explore", "explore", "steward", "running", "run-blocker:previous"],
                ["manual", "explore", "manual", "queued", null],
                ["chat", "explore", "steward", "blocked", "chat:session:tool"],
                ["interrupted-chat", "explore", "steward", "queued", "chat:session:interrupted-tool"],
                ["regression", "coverage", "steward", "queued", "regression:item"],
                ["manual-intent", "coverage", "manual", "paused", "signal:human"],
                ["triage", "failure_triage", "spec_failure", "queued", "signal:failure"],
                ["past-planner", "planner", "steward", "completed", "planner:past"],
            ];
            for (const [id, kind, trigger, status, key] of rows) {
                await client.execute({ sql: "INSERT INTO jobs VALUES (?, ?, ?, ?, ?, NULL, ?, ?)", args: [id!, kind!, trigger!, status!, "2026-10-06T00:00:00.000Z", "2026-10-01T00:00:00.000Z", 12345] });
                if (key) await client.execute({ sql: "INSERT INTO steward_intents VALUES (?, ?, ?, ?, ?, ?, ?)", args: [id!, key, JSON.stringify({ kind: kind === "failure_triage" ? "triage" : kind }), id!, status === "completed" ? "completed" : "running", "Original request", "2026-10-01T00:00:00.000Z"] });
                await client.execute({ sql: "INSERT INTO inbox_items VALUES (?, ?, 'question', 'pending', ?, ?)", args: [`question-${id}`, id!, JSON.stringify({ evidence: "preserved" }), "2026-10-01T00:00:00.000Z"] });
            }
            await client.execute("UPDATE steward_intents SET job_id = NULL WHERE id = 'interrupted-chat'");
            await client.execute("INSERT INTO steward_intents VALUES ('resume', 'resume-run:chat:answer', '{\"kind\":\"run_specs\"}', NULL, 'pending', 'Continue requested run', '2026-10-01T00:00:00.000Z')");
            await client.execute("INSERT INTO job_actions (job_id, action, detail, created_at) VALUES ('coverage', 'inspected', 'Evidence from checkout', '2026-10-01T00:00:00.000Z')");
            await client.execute("INSERT INTO inbox_items VALUES ('bug', 'coverage', 'bug_report', 'pending', '{\"steps\":[\"Open checkout\"]}', '2026-10-01T00:00:00.000Z')");
            await client.execute("INSERT INTO inbox_items VALUES ('proposal', 'coverage', 'new_spec', 'pending', '{\"testSource\":\"preserved\"}', '2026-10-01T00:00:00.000Z')");
            const migration = await fs.readFile(new URL("../../drizzle/0017_rapid_sunspot.sql", import.meta.url), "utf8");
            for (const statement of migration.split("--> statement-breakpoint")) await client.execute(statement.trim());
            const jobs = (await client.execute("SELECT * FROM jobs")).rows;
            for (const id of ["planner", "coverage", "explore"]) {
                assert.equal(jobs.find((row) => row.id === id)?.status, "cancelled", id);
                const question = (await client.execute({ sql: "SELECT * FROM inbox_items WHERE id = ?", args: [`question-${id}`] })).rows[0]!;
                assert.equal(question.status, "dismissed");
                assert.deepEqual(JSON.parse(String(question.payload)), { evidence: "preserved", retiredByScope: true });
                assert.equal((await client.execute({ sql: "SELECT status FROM steward_intents WHERE id = ?", args: [id] })).rows[0]?.status, "ignored");
            }
            for (const id of ["manual", "chat", "interrupted-chat", "regression", "manual-intent", "triage"]) {
                assert.notEqual(jobs.find((row) => row.id === id)?.status, "cancelled", id);
                assert.equal((await client.execute({ sql: "SELECT status FROM inbox_items WHERE id = ?", args: [`question-${id}`] })).rows[0]?.status, "pending");
            }
            for (const id of ["chat", "interrupted-chat", "regression", "manual-intent", "resume"]) {
                assert.equal((await client.execute({ sql: "SELECT source FROM steward_intents WHERE id = ?", args: [id] })).rows[0]?.source, "user", id);
            }
            assert.equal(jobs.find((row) => row.id === "past-planner")?.status, "completed");
            assert.ok(jobs.every((row) => row.tokens_used === 12345));
            assert.equal((await client.execute("SELECT detail FROM job_actions WHERE action = 'inspected'")).rows[0]?.detail, "Evidence from checkout");
            assert.equal((await client.execute("SELECT count(*) AS count FROM job_actions WHERE action = 'retired'")).rows[0]?.count, 3);
            assert.equal((await client.execute("SELECT status FROM inbox_items WHERE id = 'bug'")).rows[0]?.status, "pending");
            assert.equal((await client.execute("SELECT payload FROM inbox_items WHERE id = 'proposal'")).rows[0]?.payload, '{"testSource":"preserved"}');
            assert.equal((await client.execute("PRAGMA table_info(project_stewards)")).rows.some((row) => row.name === "last_planner_at"), false);
        } finally { client.close(); }
    });

    test("an unchanged empty project stays idle without a planner or unsolicited exploration", async () => {
        const project = await projectWithWork();
        await processProjectSteward(project.id);
        await processProjectSteward(project.id);
        assert.deepEqual(await stewardRepository.signals(project.id), []);
        assert.deepEqual(await stewardRepository.intents(project.id), []);
        assert.deepEqual(await jobsRepository.list(project.id), []);
        for (const kind of ["empty_project", "context_changed", "app_unavailable"]) {
            await stewardRepository.signal({ projectId: project.id, key: `old:${kind}`, kind, title: "Old automatic observation", body: "Previously queued automatic work" });
        }
        await processProjectSteward(project.id, false);
        assert.deepEqual(await stewardRepository.intents(project.id), []);
        assert.deepEqual(await jobsRepository.list(project.id), []);
        assert.ok((await stewardRepository.signals(project.id)).every((signal) => signal.status === "handled"));
    });

    test("explicit tasks run under observe and concurrent duplicate requests share the same work", async () => {
        const project = await projectWithWork();
        await stewardRepository.update(project.id, { autonomy: "observe" });
        const endpoint = `/projects/${project.id}/tasks`;
        const requests = await Promise.all([post(endpoint, { kind: "coverage" }), post(endpoint, { kind: "coverage" })]);
        assert.deepEqual(requests.map((response) => response.status), [202, 202]);
        const [first, duplicate] = await Promise.all(requests.map((response) => response.json()));
        assert.deepEqual(first, duplicate);
        assert.equal(first.status, "queued");
        const intent = (await stewardRepository.intents(project.id))[0]!;
        assert.equal(intent.id, first.intentId);
        assert.equal(intent.source, "user");
        assert.equal((await jobsRepository.get(intent.id))?.kind, "coverage");
        assert.equal((await jobsRepository.list(project.id)).length, 1);
        await jobsRepository.update(intent.id, { status: "completed" });
        await processProjectSteward(project.id, false);
        const next = await post(endpoint, { kind: "coverage" });
        assert.equal(next.status, 202);
        const repeated = await next.json();
        assert.notEqual(repeated.intentId, first.intentId, "an explicit request must bypass the automatic cooldown");
        assert.equal((await jobsRepository.get(repeated.intentId))?.status, "queued");
        await jobsRepository.update(repeated.intentId, { status: "completed" });
        const explore = await post(endpoint, { kind: "explore", goal: "Explore checkout with a guest account" });
        const exploration = await explore.json();
        assert.equal((await jobsRepository.get(exploration.intentId))?.kind, "explore");
        assert.match((await jobsRepository.get(exploration.intentId))?.goal ?? "", /guest account/);
        assert.equal((await stewardRepository.get(project.id)).autonomy, "observe");
    });

    test("requested tasks persist through local and global pause without required setup", async () => {
        const { settingsRepository } = await import("../../src/infra/repositories/settings");
        const project = await projectWithWork();
        await stewardRepository.update(project.id, { autonomy: "observe", paused: true });
        const response = await post(`/projects/${project.id}/tasks`, { kind: "explore" });
        const pending = await response.json();
        assert.equal(response.status, 202);
        assert.equal(pending.status, "paused");
        assert.deepEqual(await jobsRepository.list(project.id), []);
        assert.equal((await stewardRepository.intents(project.id))[0]?.source, "user");
        await jobsRepository.recover();
        try {
            await put("/settings/agent", { paused: true });
            await put(`/projects/${project.id}/steward`, { paused: false });
            assert.deepEqual(await jobsRepository.list(project.id), []);
            assert.equal((await stewardRepository.intents(project.id))[0]?.status, "pending");
            await put("/settings/agent", { paused: false });
            assert.equal((await jobsRepository.get(pending.intentId))?.status, "queued");
            assert.equal((await jobsRepository.list(project.id)).length, 1);
        } finally { await settingsRepository.setAgentPaused(false); }
    });

    test("task requests reject internal kinds and enforce project boundaries", async () => {
        const project = await projectWithWork();
        const endpoint = `/projects/${project.id}/tasks`;
        for (const body of [{}, { kind: "planner" }, { kind: "triage" }, { kind: "explore", source: "user" }, { kind: "explore", goal: " " }, { kind: "coverage", specIds: [] }]) {
            assert.equal((await post(endpoint, body)).status, 400);
        }
        assert.equal((await post("/projects/missing/tasks", { kind: "explore" })).status, 404);
        assert.deepEqual(await stewardRepository.intents(project.id), []);
        assert.deepEqual(await jobsRepository.list(project.id), []);
        assert.equal((await router.request(`/projects/${project.id}/activity`)).status, 404);
        assert.equal((await router.request(`/projects/${project.id}/inbox`)).status, 404);
    });

    test("chat requests are durable user intents but autonomous jobs cannot spawn more work", async () => {
        const { createBackgroundTaskTool } = await import("../../src/core/steward/tools");
        const { createJobPolicy } = await import("../../src/core/jobs/policy");
        const project = await projectWithWork();
        await stewardRepository.update(project.id, { autonomy: "observe" });
        const tool = createBackgroundTaskTool(project.id, "chat:human-session");
        const input = { kind: "explore" as const, goal: "Explore guest checkout", reason: "The user asked to investigate guest checkout" };
        await tool.execute("requested", input, undefined, undefined, {} as never);
        await tool.execute("requested", input, undefined, undefined, {} as never);
        const intents = await stewardRepository.intents(project.id);
        assert.equal(intents.length, 1);
        assert.equal(intents[0]?.source, "user");
        await processProjectSteward(project.id, false);
        const job = (await jobsRepository.get(intents[0]!.id))!;
        const policy = createJobPolicy(job, () => {});
        assert.equal(policy.tools([tool]).some((candidate) => candidate.name === "start_background_task"), false);
        assert.equal(policy.tools([tool]).some((candidate) => candidate.name === "propose_intents"), false);
        assert.equal((await jobsRepository.list(project.id)).length, 1);
    });

    test("missing run credentials ask once and the answer resumes the same selection without an agent turn", { skip: available ? false : "Chromium is not installed", timeout: 120_000 }, async () => {
        const { VALID_SPEC, HUMAN_SPEC } = await import("../helpers/storage");
        const { getRunBatch } = await import("../../src/core/runner/batch");
        const { runsRepository } = await import("../../src/infra/repositories/runs");
        const project = await projectsRepository.createProject("Requested preview check", "http://127.0.0.1:1");
        await stewardRepository.update(project.id, { autonomy: "observe" });
        await repoGit.ensureProjectRepo(project.id, { create: true });
        const feature = await writer.createFeatureInRepo(project.id, null, "Sign in", "");
        const source = VALID_SPEC.replace("({ page, step })", "({ page, step, secret })")
            .replace('await page.goto("/");', 'await page.goto("/");\n        await page.getByLabel("Password").fill(secret("shopper", "password"));');
        const { spec } = await writer.createSpecInRepo({ projectId: project.id, featureId: feature.id, title: "Sign in", description: "", humanSpec: HUMAN_SPEC, testSource: source });
        const { spec: unselected } = await writer.createSpecInRepo({ projectId: project.id, featureId: feature.id, title: "Unselected check", description: "", humanSpec: HUMAN_SPEC, testSource: VALID_SPEC });
        const head = await repoGit.getHeadSha(project.id);
        const intent = await enqueueIntent(project.id, { kind: "run_specs", goal: "Check sign-in on the preview", reason: "The user requested this preview check", specIds: [spec.id], baseUrl }, "chat:preview:run", "user");
        await processProjectSteward(project.id, false);
        const blocked = (await jobsRepository.get(intent.id))!;
        assert.equal(blocked.kind, "review");
        assert.equal(blocked.status, "blocked");
        assert.ok(blocked.stopReason);
        assert.equal(blocked.tokensUsed, 0);
        assert.equal(blocked.actionsUsed, 0);
        await Promise.all([processProjectSteward(project.id, false), processProjectSteward(project.id, false)]);
        const questions = await jobsRepository.inbox(project.id);
        assert.equal(questions.length, 1);
        assert.equal(questions[0]?.payload.runIntentId, intent.id);
        assert.equal(questions[0]?.payload.waitingFor, "credentials");
        assert.deepEqual((await jobsRepository.list(project.id)).map((job) => job.kind), ["review"]);
        await createProfile(project.id, { name: "shopper", allowedOrigins: [new URL(baseUrl).origin], fields: [{ key: "password", value: "local-test-secret" }] });
        const answer = await post(`/projects/${project.id}/inbox/${questions[0]!.id}/review`, { action: "answer", answer: "The shopper profile is available now." });
        assert.equal(answer.status, 200);
        assert.equal((await jobsRepository.get(intent.id))?.status, "completed");
        await Promise.all([processProjectSteward(project.id, false), processProjectSteward(project.id, false)]);
        const resumed = (await stewardRepository.intents(project.id)).filter((row) => row.key.startsWith(`resume-run:${intent.id}:`));
        assert.equal(resumed.length, 1);
        assert.equal(resumed[0]?.source, "user");
        assert.deepEqual(resumed[0]?.intent.specIds, [spec.id]);
        assert.equal(resumed[0]?.intent.baseUrl, baseUrl);
        let batch = await getRunBatch(resumed[0]!.batchId!);
        const deadline = Date.now() + 60_000;
        while (batch?.status === "running" && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            batch = await getRunBatch(resumed[0]!.batchId!);
        }
        assert.equal(batch?.status, "passed", batch?.failReason ?? "");
        assert.deepEqual(batch?.specs.map((entry) => entry.specId), [spec.id]);
        assert.equal(batch?.baseUrl, baseUrl);
        assert.deepEqual(await runsRepository.listRuns(unselected.id), []);
        assert.equal((await jobsRepository.list(project.id)).length, 1);
        assert.equal((await jobsRepository.get(intent.id))?.tokensUsed, 0);
        assert.equal(await repoGit.getHeadSha(project.id), head);
    });

    test("discuss opens a visible human chat with suggestion context and reuses it", async () => {
        const { createChat, getChatMessages, listChats } = await import("../../src/core/chat/session-store");
        const { isChatBusy } = await import("../../src/core/chat/chat-registry");
        const { settingsRepository } = await import("../../src/infra/repositories/settings");
        await settingsRepository.updateLlmSettings({ provider: "", model: "" });
        const project = await projectWithWork();
        const other = await projectWithWork();
        const internal = await createChat(project.id);
        const job = await jobsRepository.create({ projectId: project.id, chatId: internal.id, trigger: "steward", kind: "explore", goal: "Investigate checkout", limits: jobLimitsSchema.parse({}) });
        const item = await jobsRepository.addItem({ jobId: job.id, projectId: project.id, kind: "question", title: "Should checkout allow guests?", body: "Guest checkout is unavailable." });
        assert.deepEqual(await listChats(project.id), []);
        assert.equal((await post(`/projects/${other.id}/inbox/${item.id}/discuss`)).status, 404);
        const endpoint = `/projects/${project.id}/inbox/${item.id}/discuss`;
        const response = await post(endpoint);
        assert.equal(response.status, 200);
        const { chatId } = await response.json();
        assert.notEqual(chatId, internal.id);
        const repeated = await post(endpoint);
        assert.equal((await repeated.json()).chatId, chatId);
        const deadline = Date.now() + 5000;
        while (isChatBusy(chatId) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(isChatBusy(chatId), false);
        assert.deepEqual((await listChats(project.id)).map((chat) => chat.id), [chatId]);
        assert.deepEqual(await listChats(other.id), []);
        const messages = await getChatMessages(chatId);
        const context = messages?.filter((message) => message.role === "user");
        assert.equal(context?.length, 1);
        assert.match(context![0]!.content, /Should checkout allow guests/);
        assert.match(context![0]!.content, /Guest checkout is unavailable/);
        assert.match(context![0]!.content, /Do not change files unless I ask/);
        assert.equal((await jobsRepository.item(item.id))?.status, "pending");
        assert.equal((await jobsRepository.list(project.id)).length, 1);
    });
});
