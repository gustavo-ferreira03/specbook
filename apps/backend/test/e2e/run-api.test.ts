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

before(async () => {
    await runMigrations();
    site = http.createServer((_request, response) => {
        response.setHeader("content-type", "text/html");
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
