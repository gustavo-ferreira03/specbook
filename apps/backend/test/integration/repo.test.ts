import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { before, describe, test } from "node:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { HUMAN_SPEC, tempDir, useTempStorage, VALID_SPEC } from "../helpers/storage";

useTempStorage();
const { runMigrations } = await import("../../src/infra/db/migrate");
const { createProjectsRouter } = await import("../../src/infra/web/routes/projects");
const { createFeaturesRouter } = await import("../../src/infra/web/routes/features");
const { createSpecsRouter } = await import("../../src/infra/web/routes/specs");
const { csrfGuard, REQUEST_HEADER } = await import("../../src/infra/web/security");
const writer = await import("../../src/core/repo/writer");
const { reindexProject } = await import("../../src/core/repo/indexer");
const { repoGit } = await import("../../src/core/repo/git");
const { repoBare } = await import("../../src/core/repo/bare");
const { projectsRepository } = await import("../../src/infra/repositories/projects");
const { specsRepository } = await import("../../src/infra/repositories/specs");
const { featuresRepository } = await import("../../src/infra/repositories/features");
const { runsRepository } = await import("../../src/infra/repositories/runs");

const app = new Hono();
app.use("*", csrfGuard());
app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
});
app.route("/", createProjectsRouter());
app.route("/", createFeaturesRouter());
app.route("/", createSpecsRouter());

async function api(method: string, url: string, body?: unknown): Promise<Response> {
    return app.request(url, {
        method,
        headers: { [REQUEST_HEADER]: "1", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

async function createProject(name = "Loja"): Promise<string> {
    const response = await api("POST", "/projects", { name, baseUrl: "https://app.example.com" });
    assert.equal(response.status, 200);
    return ((await response.json()) as { project: { id: string } }).project.id;
}

async function createSpec(projectId: string, featureId: string, title: string, testSource = VALID_SPEC) {
    return writer.createSpecInRepo({
        projectId,
        featureId,
        title,
        description: "",
        humanSpec: HUMAN_SPEC,
        testSource,
    });
}

async function commitCount(projectId: string): Promise<number> {
    return Number((await repoGit.getProjectGit(projectId).raw(["rev-list", "--count", "HEAD"])).trim());
}

before(async () => {
    await runMigrations();
});

describe("project, feature and spec through the writer", () => {
    test("creating a project initialises the checkout and the canonical bare repository", async () => {
        const projectId = await createProject();
        assert.ok(existsSync(path.join(repoGit.getRepoDir(projectId), ".git")));
        assert.ok(await repoBare.bareExists(projectId));
        assert.equal(await repoBare.getBareHeadSha(projectId), await repoGit.getHeadSha(projectId));
        const symlinks = await repoGit.getProjectGit(projectId).raw(["config", "--get", "core.symlinks"]);
        assert.equal(symlinks.trim(), "false");
    });

    test("the requests need the CSRF header", async () => {
        const response = await app.request("/projects", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "x", baseUrl: "https://x.test" }),
        });
        assert.equal(response.status, 403);
    });

    test("createSpecInRepo writes the files, commits and publishes", async () => {
        const projectId = await createProject();
        const feature = await writer.createFeatureInRepo(projectId, null, "Autenticação", "Entrar e sair");
        assert.equal(feature.path, "specs/autenticacao");
        const { spec, commitSha } = await createSpec(projectId, feature.id, "Login válido");
        assert.equal(spec.path, "specs/autenticacao/login-valido");
        assert.equal(spec.status, "unverified");
        const root = repoGit.getRepoDir(projectId);
        assert.equal(await fs.readFile(path.join(root, spec.path, "spec.ts"), "utf8"), VALID_SPEC);
        assert.equal(commitSha, await repoGit.getHeadSha(projectId));
        assert.equal(await repoBare.getBareHeadSha(projectId), commitSha);
        assert.ok((await repoGit.getProjectGit(projectId).status()).isClean());
    });

    test("an invalid spec.ts is stored as an invalid Spec", async () => {
        const projectId = await createProject();
        const feature = await writer.createFeatureInRepo(projectId, null, "F", "");
        const evaluate = VALID_SPEC.replace('await page.goto("/");', 'await page.evaluate("1");');
        const { spec } = await createSpec(projectId, feature.id, "Avalia", evaluate);
        assert.equal(spec.status, "invalid");
        assert.match(spec.invalidReason ?? "", /page\.evaluate\(\) is not allowed/);
    });

    test("step() titles that differ from spec.yml make the Spec invalid", async () => {
        const projectId = await createProject();
        const feature = await writer.createFeatureInRepo(projectId, null, "F", "");
        const { spec } = await createSpec(projectId, feature.id, "Passos", VALID_SPEC.replace('step("Abrir a página"', 'step("Outro passo"'));
        assert.equal(spec.status, "invalid");
        assert.match(spec.invalidReason ?? "", /must match the steps in spec\.yml/);
    });

    test("a manual Spec starts from a valid template", async () => {
        const { createManualSpec } = await import("../../src/core/repo/manual");
        const projectId = await createProject();
        const feature = await writer.createFeatureInRepo(projectId, null, "F", "");
        const spec = await createManualSpec(projectId, feature.id, 'Título com "aspas"');
        assert.equal(spec.status, "unverified");
        const source = await fs.readFile(path.join(repoGit.getRepoDir(projectId), spec.path, "spec.ts"), "utf8");
        assert.match(source, /^import \{ test, expect \} from "specbook";/);
    });

    test("a Spec without spec.ts is invalid and can be repaired", async () => {
        const projectId = await createProject();
        const feature = await writer.createFeatureInRepo(projectId, null, "Checkout", "");
        const { spec } = await createSpec(projectId, feature.id, "Missing implementation");
        await fs.rm(path.join(repoGit.getRepoDir(projectId), spec.path, "spec.ts"));
        await repoGit.commitAll(projectId, "test: remove executable");
        await reindexProject(projectId);
        const invalid = await specsRepository.getSpec(spec.id);
        assert.equal(invalid?.invalidReason, "Missing spec.ts file in the spec directory");
        const { spec: repaired } = await writer.updateSpecInRepo(invalid!, { testSource: VALID_SPEC });
        assert.equal(repaired.status, "unverified");
    });

    test("renaming a feature moves its specs and keeps ids, runs and status", async () => {
        const projectId = await createProject();
        const parent = await writer.createFeatureInRepo(projectId, null, "Autenticação", "");
        const child = await writer.createFeatureInRepo(projectId, parent.id, "Senha", "");
        const { spec } = await createSpec(projectId, parent.id, "Login válido");
        const { spec: nested } = await createSpec(projectId, child.id, "Recuperar senha");
        const run = await runsRepository.createRun({ specId: spec.id, commitSha: await repoGit.getHeadSha(projectId), sourceHash: spec.sourceHash });
        await runsRepository.finishRun(run.id, "passed", 1000, null);
        await specsRepository.updateSpecStatus(spec.id, "passed");

        const response = await api("PATCH", `/features/${parent.id}`, { title: "Login e sessão" });
        assert.equal(response.status, 200);
        const { feature } = (await response.json()) as { feature: { path: string; title: string } };
        assert.equal(feature.path, "specs/login-e-sessao");

        const moved = await specsRepository.getSpec(spec.id);
        assert.equal(moved?.path, "specs/login-e-sessao/login-valido");
        assert.equal(moved?.status, "passed");
        assert.equal(moved?.featureId, parent.id);
        assert.deepEqual((await runsRepository.listRuns(spec.id)).map((item) => item.id), [run.id]);
        assert.equal((await specsRepository.getSpec(nested.id))?.path, "specs/login-e-sessao/senha/recuperar-senha");
        assert.equal((await featuresRepository.getFeature(child.id))?.path, "specs/login-e-sessao/senha");
        assert.equal((await specsRepository.listSpecs(projectId)).length, 2);

        const root = repoGit.getRepoDir(projectId);
        assert.ok(!existsSync(path.join(root, "specs", "autenticacao")));
        assert.ok(existsSync(path.join(root, "specs", "login-e-sessao", "login-valido", "spec.yml")));
        assert.ok((await repoGit.getProjectGit(projectId).status()).isClean());
    });

    test("a spec directory moved by an external commit keeps its id on reindex", async () => {
        const projectId = await createProject();
        const from = await writer.createFeatureInRepo(projectId, null, "Carrinho", "");
        const { spec } = await createSpec(projectId, from.id, "Adicionar item");
        await specsRepository.updateSpecStatus(spec.id, "failed");

        const git = repoGit.getProjectGit(projectId);
        const root = repoGit.getRepoDir(projectId);
        await fs.mkdir(path.join(root, "specs", "checkout"));
        await git.raw(["mv", "specs/carrinho/adicionar-item", "specs/checkout/adicionar-item"]);
        await git.commit("move spec outside Specbook");

        await reindexProject(projectId);
        const moved = await specsRepository.getSpec(spec.id);
        assert.equal(moved?.path, "specs/checkout/adicionar-item");
        assert.equal(moved?.status, "failed", "content did not change, so the status stays");
        const newFeature = await featuresRepository.getFeatureByPath(projectId, "specs/checkout");
        assert.equal(moved?.featureId, newFeature?.id);
        assert.equal(newFeature?.title, "Checkout");
        assert.equal((await specsRepository.listSpecs(projectId)).length, 1);
    });

    test("a spec.yml that is a symbolic link makes the spec invalid on reindex", async () => {
        const projectId = await createProject();
        const feature = await writer.createFeatureInRepo(projectId, null, "F", "");
        const { spec } = await createSpec(projectId, feature.id, "Spec");
        const outside = tempDir();
        await fs.writeFile(path.join(outside, "stolen.yml"), "title: segredo\n");
        const yamlPath = path.join(repoGit.getRepoDir(projectId), spec.path, "spec.yml");
        await fs.rm(yamlPath);
        await fs.symlink(path.join(outside, "stolen.yml"), yamlPath);

        const result = await reindexProject(projectId);
        assert.deepEqual(result.invalidSpecs, [spec.id]);
        const invalid = await specsRepository.getSpec(spec.id);
        assert.equal(invalid?.status, "invalid");
        assert.match(invalid?.invalidReason ?? "", /symbolic link/);
        assert.notEqual(invalid?.title, "segredo", "the link target is never read");
        const detail = await api("GET", `/specs/${spec.id}`);
        assert.ok(!(await detail.text()).includes("segredo"), "the API never serves the link target");
    });

    test("deleting a project removes its directories without committing or pushing", async () => {
        const projectId = await createProject();
        const feature = await writer.createFeatureInRepo(projectId, null, "F", "");
        await createSpec(projectId, feature.id, "Spec");

        const checkoutDir = repoGit.getRepoDir(projectId);
        const bareDir = repoBare.getBareRepoDir(projectId);
        const calls: string[] = [];
        const originals = {
            commitAll: repoGit.commitAll,
        };
        repoGit.commitAll = async (...args) => {
            calls.push("commitAll");
            return originals.commitAll.apply(repoGit, args);
        };
        try {
            const response = await api("DELETE", `/projects/${projectId}`);
            assert.equal(response.status, 204);
            await new Promise((resolve) => setTimeout(resolve, 50));
        } finally {
            Object.assign(repoGit, { commitAll: originals.commitAll });
        }
        assert.deepEqual(calls, []);
        assert.equal(await projectsRepository.getProject(projectId), null);
        assert.deepEqual(await specsRepository.listSpecs(projectId), []);
        assert.deepEqual(await featuresRepository.listFeatures(projectId), []);
        assert.ok(!existsSync(checkoutDir));
        assert.ok(!existsSync(bareDir));
        assert.equal((await api("DELETE", `/projects/${projectId}`)).status, 404);
    });
});

describe("autonomous job proposals", () => {


    test("proposals preserve the contract, reject stale edits, and replay approval once", async () => {
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { proposeMutation, applyProposal } = await import("../../src/core/jobs/proposals");
        const { jobBudgetSchema } = await import("../../src/core/jobs/schemas");
        const projectId = await createProject("Job proposals");
        const feature = await writer.createFeatureInRepo(projectId, null, "Login", "");
        const { spec } = await createSpec(projectId, feature.id, "Login");
        const yamlFile = path.join(repoGit.getRepoDir(projectId), spec.path, "spec.yml");
        const original = `# Contract owned by the human\n${await fs.readFile(yamlFile, "utf8")}`;
        await fs.writeFile(yamlFile, original);
        await repoGit.commitAll(projectId, "test: add comment");
        await reindexProject(projectId);
        const job = await jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "manual", goal: "Fix implementation", budget: jobBudgetSchema.parse({}) });
        const head = await repoGit.getHeadSha(projectId);
        const source = VALID_SPEC.replace('page.goto("/")', 'page.goto("/login")');
        const proposal = await proposeMutation(job, "update_spec", { specId: spec.id, testSource: source });
        assert.equal(await repoGit.getHeadSha(projectId), head);
        assert.equal(await fs.readFile(yamlFile, "utf8"), original);
        assert.equal((await proposeMutation(job, "update_spec", { specId: spec.id, testSource: source })).id, proposal.id);
        const commit = await applyProposal(proposal);
        assert.notEqual(commit, head);
        assert.equal(await fs.readFile(yamlFile, "utf8"), original);
        assert.equal(await applyProposal(proposal), commit);
        assert.equal(await repoGit.getHeadSha(projectId), commit);
        const stale = await proposeMutation(job, "update_spec", { specId: spec.id, testSource: VALID_SPEC });
        await writer.updateSpecWithLock(spec.id, { testSource: source.replace("/login", "/other") });
        await assert.rejects(() => applyProposal(stale), /Spec changed/);
        const other = await createProject("Other project");
        const otherFeature = await writer.createFeatureInRepo(other, null, "Other", "");
        const { spec: otherSpec } = await createSpec(other, otherFeature.id, "Other");
        await assert.rejects(() => proposeMutation(job, "update_spec", { specId: otherSpec.id, testSource: source }), /not found/);
    });

    test("job policy accounts before tool execution and pauses for credentials", async () => {
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { createJobPolicy } = await import("../../src/core/jobs/policy");
        const { jobBudgetSchema } = await import("../../src/core/jobs/schemas");
        const projectId = await createProject("Policy");
        const row = await jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "manual", goal: "Inspect", budget: jobBudgetSchema.parse({ maxActions: 1 }) });
        const job = (await jobsRepository.claim(row.id))!;
        let executed = 0;
        let aborted = false;
        const { Type } = await import("@earendil-works/pi-ai");
        const tools = createJobPolicy(job, () => { aborted = true; }).tools([{ name: "test_tool", label: "test_tool", description: "test", parameters: Type.Object({}), async execute() { executed++; return { content: [], details: undefined }; } }]);
        const tool = tools[0]!;
        await tool.execute("1", {}, undefined, undefined, {} as never);
        assert.equal(executed, 1);
        await assert.rejects(() => tool.execute("2", {}, undefined, undefined, {} as never), /budget/);
        assert.equal(executed, 1);
        assert.ok(aborted);
        assert.equal((await jobsRepository.get(job.id))?.status, "budget_exceeded");
        const row2 = await jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "manual", goal: "Credentials", budget: jobBudgetSchema.parse({}) });
        const job2 = (await jobsRepository.claim(row2.id))!;
        let paused = false;
        const credential = createJobPolicy(job2, () => { paused = true; }).tools([{ name: "request_credential", label: "request", description: "test", parameters: Type.Object({}), async execute() { throw new Error("must be intercepted"); } }])[0]!;
        await credential.execute("1", {}, undefined, undefined, {} as never);
        assert.ok(paused, "a question aborts the turn even when other tool calls were batched");
        assert.equal((await jobsRepository.get(job2.id))?.status, "blocked");
        assert.equal((await jobsRepository.inbox(projectId))[0]?.kind, "question");
        await assert.rejects(() => credential.execute("2", {}, undefined, undefined, {} as never), /paused/);
        await jobsRepository.update(job2.id, { status: "running", startedAt: new Date().toISOString() });
        await jobsRepository.recover();
        assert.equal((await jobsRepository.get(job2.id))?.status, "queued");
    });

    test("concurrent approvals and recovery of a committed proposal produce one commit", async () => {
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { proposeMutation } = await import("../../src/core/jobs/proposals");
        const { jobBudgetSchema } = await import("../../src/core/jobs/schemas");
        const { createJobsRouter } = await import("../../src/infra/web/routes/jobs");
        const projectId = await createProject("Approval recovery");
        const feature = await writer.createFeatureInRepo(projectId, null, "Login", "");
        const { spec } = await createSpec(projectId, feature.id, "Login");
        const job = await jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "manual", goal: "Fix implementation", budget: jobBudgetSchema.parse({}) });
        const proposal = await proposeMutation(job, "update_spec", { specId: spec.id, testSource: VALID_SPEC.replace('page.goto("/")', 'page.goto("/login")') });
        const router = createJobsRouter();
        const approve = () => router.request(`/projects/${projectId}/inbox/${proposal.id}/review`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "approve" }),
        });
        const before = await commitCount(projectId);
        const responses = await Promise.all([approve(), approve()]);
        assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
        const approved = await jobsRepository.item(proposal.id);
        assert.equal(approved?.status, "approved");
        assert.ok(approved?.commitSha);
        assert.equal(await commitCount(projectId), before + 1);
        await jobsRepository.updateItem(proposal.id, { status: "applying", commitSha: null });
        await jobsRepository.recover();
        assert.equal((await approve()).status, 200);
        assert.equal((await jobsRepository.item(proposal.id))?.commitSha, approved.commitSha);
        assert.equal(await commitCount(projectId), before + 1);
    });

    test("answering a question resumes a paused job without reviving a cancelled job", async () => {
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { jobBudgetSchema } = await import("../../src/core/jobs/schemas");
        const projectId = await createProject("Answer race");
        const job = await jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "manual", goal: "Review", budget: jobBudgetSchema.parse({}) });
        await jobsRepository.update(job.id, { status: "blocked" });
        const question = await jobsRepository.addItem({ jobId: job.id, projectId, kind: "question", title: "Access", body: "Configure access" });
        assert.ok(await jobsRepository.claimItem(question.id));
        await jobsRepository.answer(question, "Configured");
        assert.equal((await jobsRepository.get(job.id))?.status, "queued");
        assert.equal((await jobsRepository.item(question.id))?.status, "answered");
        assert.equal((await jobsRepository.item(question.id))?.answer, "Configured");

        await jobsRepository.update(job.id, { status: "blocked" });
        const next = await jobsRepository.addItem({ jobId: job.id, projectId, kind: "question", title: "Session", body: "Restore session" });
        assert.ok(await jobsRepository.claimItem(next.id));
        await jobsRepository.update(job.id, { status: "cancelled" });
        await assert.rejects(() => jobsRepository.answer(next, "Restored"), /no longer paused/);
        assert.equal((await jobsRepository.get(job.id))?.status, "cancelled");
        assert.equal((await jobsRepository.item(next.id))?.status, "applying");
        assert.equal((await jobsRepository.item(next.id))?.answer, null);
    });
});

describe("project steward", () => {
    test("observes without launching work, then deduplicates intents across concurrent processing", async () => {
        const { stewardRepository } = await import("../../src/infra/repositories/steward");
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { stopJobWorker } = await import("../../src/core/jobs/worker");
        const { enqueueIntent, processProjectSteward, dailyBudget } = await import("../../src/core/steward/engine");
        await stopJobWorker();
        const projectId = await createProject("Steward decisions");
        await stewardRepository.update(projectId, { autonomy: "observe" });
        const signal = { projectId, key: "empty", kind: "empty_project", title: "No Specs", body: "Propose a first Spec" };
        await stewardRepository.signal(signal);
        await stewardRepository.signal(signal);
        await processProjectSteward(projectId, false);
        assert.equal((await stewardRepository.signals(projectId)).length, 1);
        assert.equal((await stewardRepository.signals(projectId))[0]?.status, "observed");
        assert.equal((await jobsRepository.list(projectId)).length, 0);
        await stewardRepository.update(projectId, { autonomy: "propose" });
        const intent = { kind: "coverage", goal: "Explore sign in", reason: "Sign in lacks coverage", priority: 90 };
        const one = await enqueueIntent(projectId, intent, "chat:one");
        const duplicate = await enqueueIntent(projectId, intent, "chat:one");
        assert.equal(one.id, duplicate.id);
        await Promise.all([processProjectSteward(projectId, false), processProjectSteward(projectId, false)]);
        const jobs = await jobsRepository.list(projectId);
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0]?.id, one.id, "job identity allows dispatch recovery without duplicates");
        assert.equal(dailyBudget(jobs).tokens, 200_000, "queued work reserves its full budget");
        const proposal = await jobsRepository.addItem({ projectId, jobId: one.id, kind: "new_spec", title: "Sign in", body: "Proposed coverage" });
        await jobsRepository.updateItem(proposal.id, { status: "rejected" });
        await jobsRepository.update(one.id, { status: "completed" });
        const again = await enqueueIntent(projectId, intent, "chat:two");
        await processProjectSteward(projectId, false);
        const remembered = (await stewardRepository.intents(projectId)).find((item) => item.id === again.id);
        assert.equal(remembered?.status, "ignored");
        assert.match(remembered?.reason ?? "", /human rejected/i);
    });

    test("trusted automatic fixes compare syntax, not selector-like text inside input values", async () => {
        const { isLocatorOnlyFix } = await import("../../src/core/steward/approval");
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { jobBudgetSchema } = await import("../../src/core/jobs/schemas");
        const projectId = await createProject("Trusted fixes");
        const job = await jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "manual", goal: "Review", budget: jobBudgetSchema.parse({}) });
        const source = VALID_SPEC.replace('page.getByRole("heading")', 'page.locator("body")');
        const before = source.replace('page.locator("body")', 'page.locator("main")');
        const item = await jobsRepository.addItem({ projectId, jobId: job.id, kind: "spec_fix", title: "Fix", body: "Fix", payload: {
            requiresVerification: true, before: { testSource: before }, params: { specId: crypto.randomUUID(), testSource: source },
        } });
        assert.equal(isLocatorOnlyFix(item), true);
        item.payload.params = { ...(item.payload.params as object), humanSpec: HUMAN_SPEC };
        assert.equal(isLocatorOnlyFix(item), false, "behavior proposals always need a human");
        item.payload.before = { testSource: `page.fill(".locator('old')")` };
        item.payload.params = { specId: crypto.randomUUID(), testSource: `page.fill(".locator('new')")` };
        assert.equal(isLocatorOnlyFix(item), false, "input data cannot masquerade as a locator change");
    });

    test("replays changed Spec and deploy signals once after a crash, while retaining real reversions", async (t) => {
        const { collectProjectSignals } = await import("../../src/core/steward/signals");
        const { stewardRepository } = await import("../../src/infra/repositories/steward");
        const projectId = await createProject("Observation recovery");
        const project = (await projectsRepository.getProject(projectId))!;
        const feature = await writer.createFeatureInRepo(projectId, null, "Store", "");
        const { spec } = await createSpec(projectId, feature.id, "Store");
        let build = "a";
        t.mock.method(globalThis, "fetch", async () => new Response(`<script src="/${build}.js"></script>`));
        let at = Date.now();
        let observation = await collectProjectSignals(project, {}, at);
        await stewardRepository.update(projectId, { observation });
        const originalHash = spec.sourceHash;
        for (const [index, version] of ["b", "a", "b"].entries()) {
            at += 300_001;
            build = version;
            await specsRepository.updateSpecRecord(spec.id, { sourceHash: version === "a" ? originalHash : "changed-source" });
            const persisted = (await stewardRepository.get(projectId)).observation;
            observation = await collectProjectSignals(project, persisted, at);
            // Simulate the process stopping after signal INSERT, before saving its observation.
            const replay = await collectProjectSignals(project, persisted, at + 1000);
            assert.deepEqual(replay.specGenerations, observation.specGenerations);
            assert.equal(replay.deployment?.generation, observation.deployment?.generation);
            const signals = await stewardRepository.signals(projectId);
            assert.equal(signals.filter((signal) => signal.kind === "spec_changed").length, index + 1);
            assert.equal(signals.filter((signal) => signal.kind === "deployment_changed").length, index + 1);
            assert.equal(observation.specGenerations?.[spec.id], index + 1);
            await stewardRepository.update(projectId, { observation });
        }
    });

    test("run preparation blockers create one budgeted investigation and retry only after it finishes", async () => {
        const { stewardRepository } = await import("../../src/infra/repositories/steward");
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { stopJobWorker } = await import("../../src/core/jobs/worker");
        const { enqueueIntent, processProjectSteward } = await import("../../src/core/steward/engine");
        await stopJobWorker();
        const projectId = await createProject("Missing run access");
        await stewardRepository.update(projectId, { lastPlannerAt: new Date().toISOString() });
        const feature = await writer.createFeatureInRepo(projectId, null, "Sign in", "");
        const source = VALID_SPEC.replace("{ page, step }", "{ page, step, secret }")
            .replace('await page.goto("/");', 'await page.goto("/");\n        await page.getByLabel("Email").fill(secret("shopper", "email"));');
        const { spec } = await createSpec(projectId, feature.id, "Sign in", source);
        const intent = await enqueueIntent(projectId, { kind: "run_specs", goal: "Verify the preview", reason: "A preview deployed", specIds: [spec.id], baseUrl: "https://preview.example.com" }, "deploy:missing-access");
        await processProjectSteward(projectId, false);
        const failed = (await stewardRepository.intents(projectId)).find((item) => item.id === intent.id)!;
        assert.equal(failed.status, "failed");
        assert.match(failed.reason, /credentials.*not configured/);
        const investigation = (await stewardRepository.intents(projectId)).find((item) => item.key === `run-blocker:${intent.id}`)!;
        assert.equal(investigation.intent.kind, "explore");
        assert.equal(investigation.intent.baseUrl, "https://preview.example.com");
        assert.deepEqual(investigation.intent.specIds, [spec.id]);
        assert.match(investigation.intent.goal, /Inbox.*remain blocked/);
        await processProjectSteward(projectId, false);
        const job = (await jobsRepository.get(investigation.id))!;
        assert.equal(job.status, "queued");
        assert.equal(job.budget.maxTokens, 100_000);
        await jobsRepository.update(job.id, { status: "blocked" });
        const question = await jobsRepository.addItem({ projectId, jobId: job.id, kind: "question", title: "Credentials needed", body: "Configure the shopper profile", payload: { waitingFor: "credentials" } });
        await processProjectSteward(projectId, false);
        assert.equal((await stewardRepository.intents(projectId)).filter((item) => item.key.startsWith("resume-run:")).length, 0);
        await stewardRepository.signal({ projectId, kind: "credentials_changed", key: "access:changed", title: "Access changed", body: "Inspect the new profiles" });
        await processProjectSteward(projectId, false);
        assert.equal((await jobsRepository.get(job.id))?.status, "queued");
        assert.equal((await jobsRepository.item(question.id))?.status, "answered");
        // Even if an agent incorrectly finishes before access is usable, do not spin on failing preparation.
        await jobsRepository.update(job.id, { status: "completed" });
        await processProjectSteward(projectId, false);
        await processProjectSteward(projectId, false);
        const intents = await stewardRepository.intents(projectId);
        const resumed = intents.find((item) => item.key === `resume-run:${intent.id}:${investigation.id}`)!;
        assert.equal(resumed.intent.baseUrl, "https://preview.example.com");
        assert.deepEqual(resumed.intent.specIds, [spec.id]);
        assert.equal((await jobsRepository.list(projectId)).length, 1, "the matching recent investigation prevents an unbounded retry loop");
        assert.equal(intents.filter((item) => item.key.startsWith("run-blocker:")).length, 2);
        assert.equal(intents.find((item) => item.key === `run-blocker:${resumed.id}`)?.status, "ignored");
    });

    test("keeps independent coverage requests and promoted bug reports distinct", async () => {
        const { enqueueIntent } = await import("../../src/core/steward/engine");
        const projectId = await createProject("Independent coverage");
        const base = { kind: "coverage", reason: "Missing coverage", goal: "Cover login" };
        const login = await enqueueIntent(projectId, base, "chat:login");
        const duplicate = await enqueueIntent(projectId, { ...base, goal: " Cover   LOGIN " }, "chat:repeat");
        const checkout = await enqueueIntent(projectId, { ...base, goal: "Cover checkout" }, "chat:checkout");
        const regression = await enqueueIntent(projectId, base, "regression:bug-one");
        assert.equal(login.fingerprint, duplicate.fingerprint);
        assert.notEqual(login.fingerprint, checkout.fingerprint);
        assert.notEqual(login.fingerprint, regression.fingerprint);
    });

    test("promoting a bug report creates one regression intent without changing the repository", async () => {
        const { createJobsRouter } = await import("../../src/infra/web/routes/jobs");
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { stewardRepository } = await import("../../src/infra/repositories/steward");
        const { jobBudgetSchema } = await import("../../src/core/jobs/schemas");
        const { stopJobWorker } = await import("../../src/core/jobs/worker");
        await stopJobWorker();
        const projectId = await createProject("Regression proposal");
        const job = await jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "manual", goal: "Investigate", budget: jobBudgetSchema.parse({}) });
        const bug = await jobsRepository.addItem({ projectId, jobId: job.id, kind: "bug_report", title: "Checkout drops the discount", body: "Open checkout with a coupon; the total ignores it." });
        const question = await jobsRepository.addItem({ projectId, jobId: job.id, kind: "question", title: "Access", body: "Which account?" });
        const head = await repoGit.getHeadSha(projectId);
        const router = new Hono().route("/", createJobsRouter());
        const promote = (project: string, item: string) => router.request(`/projects/${project}/inbox/${item}/promote`, { method: "POST" });
        const response = await promote(projectId, bug.id);
        assert.equal(response.status, 202);
        const { intentId } = await response.json() as { intentId: string };
        assert.deepEqual(await (await promote(projectId, bug.id)).json(), { intentId });
        assert.equal((await promote(crypto.randomUUID(), bug.id)).status, 404);
        assert.equal((await promote(projectId, question.id)).status, 400);
        const intents = await stewardRepository.intents(projectId);
        assert.equal(intents.length, 1);
        assert.equal(intents[0]?.intent.kind, "coverage");
        assert.match(intents[0]?.intent.goal ?? "", /total ignores it/);
        assert.equal((await jobsRepository.item(bug.id))?.payload.regressionIntentId, intentId);
        assert.equal(await repoGit.getHeadSha(projectId), head);
        assert.ok((await repoGit.getProjectGit(projectId).status()).isClean());
    });

    test("does not recreate an exact proposal the human already rejected", async () => {
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { jobBudgetSchema } = await import("../../src/core/jobs/schemas");
        const { proposeMutation } = await import("../../src/core/jobs/proposals");
        const projectId = await createProject("Rejected proposal");
        const createJob = () => jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "manual", goal: "Propose coverage", budget: jobBudgetSchema.parse({}) });
        const job = await createJob();
        const params = { title: "Checkout", description: "Coupons and payment" };
        const proposal = await proposeMutation(job, "create_feature", params);
        await jobsRepository.updateItem(proposal.id, { status: "rejected" });
        const next = await createJob();
        await assert.rejects(() => proposeMutation(next, "create_feature", { description: params.description, title: params.title }), /human rejected/);
        assert.equal((await jobsRepository.inbox(projectId)).length, 1);
        const different = await proposeMutation(next, "create_feature", { title: "Login", description: "Access and account sessions" });
        assert.equal(different.status, "pending");
    });

});
