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

before(async () => {
    await runMigrations();
    site = http.createServer((request, response) => {
        response.setHeader("content-type", "text/html");
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
});

describe("proposal verification", { skip: available ? false : "Chromium is not installed" }, () => {
    test("verifies a candidate without changing the contract or index, then applies on approval", async () => {
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { specsRepository } = await import("../../src/infra/repositories/specs");
        const { jobBudgetSchema } = await import("../../src/core/jobs/schemas");
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
        const job = await jobsRepository.create({ projectId: project.id, chatId: "candidate-test", trigger: "manual", kind: "failure_triage", specId: spec.id, goal: "Heal", budget: jobBudgetSchema.parse({}) });
        const running = (await jobsRepository.claim(job.id))!;
        await jobsRepository.update(job.id, { classification: "test_drift" });
        await assert.rejects(() => proposeMutation(running, "update_spec", { specId: spec.id, humanSpec: HUMAN_SPEC, testSource: VALID_SPEC }), /implementation/);
        const proposal = await proposeMutation(running, "update_spec", { specId: spec.id, testSource: VALID_SPEC.replace('page.goto("/")', 'page.goto("/home")') });
        await assert.rejects(() => applyProposal(proposal), /passing verification/);
        const head = await repoGit.getHeadSha(project.id);
        const result = await verifyProposal(running, proposal);
        assert.equal(result.status, "passed", result.failReason ?? "");
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
