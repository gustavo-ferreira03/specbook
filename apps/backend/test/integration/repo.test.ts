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
    test("Inbox file previews match the committed bytes for additions and behavior changes", async () => {
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { proposeMutation, applyProposal } = await import("../../src/core/jobs/proposals");
        const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
        const { createJobsRouter } = await import("../../src/infra/web/routes/jobs");
        const projectId = await createProject("Review diffs");
        const job = await jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "manual", goal: "Propose coverage", limits: jobLimitsSchema.parse({}) });
        const router = createJobsRouter();
        const preview = async (id: string) => {
            const response = await router.request(`/projects/${projectId}/overview`);
            assert.equal(response.status, 200);
            const { items } = await response.json() as { items: { id: string; payload: { files: { path: string; before: string | null; after: string }[] } }[] };
            return items.find((item) => item.id === id)!.payload.files;
        };
        const featureProposal = await proposeMutation(job, "create_feature", { title: "Checkout", description: "Coupons: discounts\nPayment" });
        const featureFiles = await preview(featureProposal.id);
        assert.equal(featureFiles[0]?.before, null);
        await applyProposal(featureProposal);
        const feature = (await featuresRepository.listFeatures(projectId))[0]!;
        assert.equal(await fs.readFile(path.join(repoGit.getRepoDir(projectId), feature.path, "feature.yml"), "utf8"), featureFiles[0]?.after);
        const proposal = await proposeMutation(job, "create_spec", { featureId: feature.id, title: "Checkout", description: "", humanSpec: HUMAN_SPEC, testSource: VALID_SPEC });
        const added = await preview(proposal.id);
        assert.equal(added.length, 2);
        assert.ok(added.every((file) => file.before === null));
        await applyProposal(proposal);
        const spec = (await specsRepository.listSpecs(projectId))[0]!;
        for (const file of added) assert.equal(await fs.readFile(path.join(repoGit.getRepoDir(projectId), spec.path, file.path), "utf8"), file.after);
        const yamlFile = path.join(repoGit.getRepoDir(projectId), spec.path, "spec.yml");
        const original = `# Human contract\n${await fs.readFile(yamlFile, "utf8")}`;
        await fs.writeFile(yamlFile, original);
        await repoGit.commitAll(projectId, "test: annotate contract");
        await reindexProject(projectId);
        const sourceOnly = await proposeMutation(job, "update_spec", { specId: spec.id, testSource: VALID_SPEC.replace('page.goto("/")', 'page.goto("/checkout")') });
        const sourceFiles = await preview(sourceOnly.id);
        assert.equal(sourceFiles[0]?.before, original);
        assert.equal(sourceFiles[0]?.after, original, "unchanged YAML retains comments and formatting");
        assert.notEqual(sourceFiles[1]?.before, sourceFiles[1]?.after);
        const behavior = await proposeMutation(job, "update_spec", { specId: spec.id, humanSpec: { ...HUMAN_SPEC, expectedResult: "Discount: applied\nTotal updated" } });
        const changed = await preview(behavior.id);
        assert.equal(changed[0]?.before, original);
        assert.notEqual(changed[0]?.before, changed[0]?.after);
        const approved = await router.request(`/projects/${projectId}/inbox/${behavior.id}/review`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "approve" }),
        });
        assert.equal(approved.status, 200);
        assert.equal(await fs.readFile(yamlFile, "utf8"), changed[0]?.after);
        assert.deepEqual(await preview(behavior.id), changed, "review history retains the proposal snapshot");
    });

    test("proposals preserve the contract, reject stale edits, and replay approval once", async () => {
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { proposeMutation, applyProposal } = await import("../../src/core/jobs/proposals");
        const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
        const projectId = await createProject("Job proposals");
        const feature = await writer.createFeatureInRepo(projectId, null, "Login", "");
        const { spec } = await createSpec(projectId, feature.id, "Login");
        const yamlFile = path.join(repoGit.getRepoDir(projectId), spec.path, "spec.yml");
        const original = `# Contract owned by the human\n${await fs.readFile(yamlFile, "utf8")}`;
        await fs.writeFile(yamlFile, original);
        await repoGit.commitAll(projectId, "test: add comment");
        await reindexProject(projectId);
        const job = await jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "manual", goal: "Fix implementation", limits: jobLimitsSchema.parse({}) });
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
        const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
        const projectId = await createProject("Policy");
        const row = await jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "manual", goal: "Inspect", limits: jobLimitsSchema.parse({ maxActions: 1 }) });
        const job = (await jobsRepository.claim(row.id))!;
        let executed = 0;
        let aborted = false;
        const { Type } = await import("@earendil-works/pi-ai");
        const tools = createJobPolicy(job, () => { aborted = true; }).tools([{ name: "test_tool", label: "test_tool", description: "test", parameters: Type.Object({}), async execute() { executed++; return { content: [], details: undefined }; } }]);
        const tool = tools[0]!;
        await tool.execute("1", {}, undefined, undefined, {} as never);
        assert.equal(executed, 1);
        await assert.rejects(() => tool.execute("2", {}, undefined, undefined, {} as never), /did not reach a confirmed result/i);
        assert.equal(executed, 1);
        assert.ok(aborted);
        assert.equal((await jobsRepository.get(job.id))?.status, "stalled");
        const row2 = await jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "manual", goal: "Credentials", limits: jobLimitsSchema.parse({}) });
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
        const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
        const { createJobsRouter } = await import("../../src/infra/web/routes/jobs");
        const projectId = await createProject("Approval recovery");
        const feature = await writer.createFeatureInRepo(projectId, null, "Login", "");
        const { spec } = await createSpec(projectId, feature.id, "Login");
        const job = await jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "manual", goal: "Fix implementation", limits: jobLimitsSchema.parse({}) });
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
        const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
        const projectId = await createProject("Answer race");
        const job = await jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "manual", goal: "Review", limits: jobLimitsSchema.parse({}) });
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
    test("stays idle without events and only runs requested work in observation mode", async (t) => {
        const { stewardRepository } = await import("../../src/infra/repositories/steward");
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { stopJobWorker } = await import("../../src/core/jobs/worker");
        const { enqueueIntent, processProjectSteward } = await import("../../src/core/steward/engine");
        const { canRunAgentJob } = await import("../../src/core/jobs/pause");
        const { createJobPolicy } = await import("../../src/core/jobs/policy");
        const { createBackgroundTaskTool } = await import("../../src/core/steward/tools");
        const { createJobSchema, jobLimitsSchema } = await import("../../src/core/jobs/schemas");
        await stopJobWorker();
        t.mock.method(globalThis, "fetch", async () => new Response('<script src="/unchanged.js"></script>'));
        const projectId = await createProject("Event decisions");
        for (let i = 0; i < 3; i++) await processProjectSteward(projectId);
        assert.equal((await stewardRepository.intents(projectId)).length, 0, "an empty project does not schedule exploration or planning");
        assert.equal((await jobsRepository.list(projectId)).length, 0);
        assert.equal((await stewardRepository.signals(projectId)).length, 0);
        for (const kind of ["empty_project", "context_changed", "stale_spec", "app_unavailable"]) {
            await stewardRepository.signal({ projectId, key: kind, kind, title: "Changed", body: "Inspect this change" });
        }
        await processProjectSteward(projectId, false);
        assert.equal((await stewardRepository.intents(projectId)).length, 0, "these observations are not automatic work triggers");
        await assert.rejects(() => enqueueIntent(projectId, { kind: "coverage", goal: "Find gaps", reason: "No checks" }, "automatic:gaps"), /explicit human request/);
        await assert.rejects(() => enqueueIntent(projectId, { kind: "explore", goal: "Explore", reason: "No checks" }, "automatic:explore"), /explicit human request/);
        assert.equal(createJobSchema.safeParse({ kind: "planner" }).success, false);
        await stewardRepository.update(projectId, { autonomy: "observe" });
        const feature = await writer.createFeatureInRepo(projectId, null, "Access", "");
        const { spec } = await createSpec(projectId, feature.id, "Sign in");
        const event = await enqueueIntent(projectId, { kind: "regenerate", goal: "Repair sign in", reason: "Invalid check", specIds: [spec.id] }, "event:repair");
        const requested = { kind: "coverage", goal: "Explore sign in", reason: "The human requested missing coverage", priority: 90 };
        const one = await enqueueIntent(projectId, requested, "chat:one", "user");
        const duplicate = await enqueueIntent(projectId, requested, "chat:one", "user");
        assert.equal(one.id, duplicate.id);
        await Promise.all([processProjectSteward(projectId, false), processProjectSteward(projectId, false)]);
        const jobs = await jobsRepository.list(projectId);
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0]?.id, one.id, "dispatch recovery keeps the original identity");
        assert.equal(await canRunAgentJob(jobs[0]!), true);
        assert.equal((await stewardRepository.intents(projectId)).find((item) => item.id === event.id)?.status, "pending");
        const eventJob = await jobsRepository.create({ id: event.id, projectId, chatId: crypto.randomUUID(), trigger: "steward", goal: "Repair sign in", limits: jobLimitsSchema.parse({}) });
        assert.equal(await canRunAgentJob(eventJob), false, "worker dispatch respects observation mode too");
        const tools = createJobPolicy(jobs[0]!, () => undefined).tools([createBackgroundTaskTool(projectId, "chat:policy-check")]);
        assert.equal(tools.some((tool) => ["start_background_task", "propose_intents"].includes(tool.name)), false, "an autonomous session cannot create more work");
        await jobsRepository.update(one.id, { status: "completed" });
        const again = await enqueueIntent(projectId, requested, "chat:two", "user");
        await processProjectSteward(projectId, false);
        assert.equal((await jobsRepository.get(again.id))?.status, "queued", "a fresh explicit request does not wait for a six-hour cooldown");
        await stewardRepository.update(projectId, { paused: true });
        assert.equal(await canRunAgentJob(jobs[0]!), false, "pause still applies to explicit requests");
        const failedRuns = [];
        for (let i = 0; i < 2; i++) {
            const run = await runsRepository.createRun({ specId: spec.id, sourceHash: spec.sourceHash, commitSha: await repoGit.getHeadSha(projectId) });
            await runsRepository.finishRun(run.id, "failed", 1, "Expected sign-in result was missing");
            failedRuns.push(run);
        }
        const firstFailure = { kind: "triage", goal: "Investigate sign in", reason: "The latest check failed", specIds: [spec.id], runId: failedRuns[0]!.id };
        const firstTriage = await enqueueIntent(projectId, firstFailure, `failure:${failedRuns[0]!.id}`);
        const replay = await enqueueIntent(projectId, firstFailure, `failure:${failedRuns[0]!.id}`);
        const nextTriage = await enqueueIntent(projectId, { ...firstFailure, runId: failedRuns[1]!.id }, `failure:${failedRuns[1]!.id}`);
        assert.equal(firstTriage.id, replay.id, "replaying one failure still deduplicates");
        assert.notEqual(firstTriage.fingerprint, nextTriage.fingerprint, "a new failed run cannot be hidden by the previous investigation's cooldown");
    });

    test("trusted automatic fixes compare syntax, not selector-like text inside input values", async () => {
        const { isLocatorOnlyFix } = await import("../../src/core/steward/approval");
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
        const projectId = await createProject("Trusted fixes");
        const job = await jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "manual", goal: "Review", limits: jobLimitsSchema.parse({}) });
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
            assert.equal(signals.filter((signal) => signal.kind === "spec_changed").length, index + 2);
            assert.equal(signals.filter((signal) => signal.kind === "deployment_changed").length, index + 1);
            assert.equal(observation.specGenerations?.[spec.id], index + 2);
            await stewardRepository.update(projectId, { observation });
        }
    });

    test("run prerequisites ask once and resume the original request without exploratory work", async () => {
        const { stewardRepository } = await import("../../src/infra/repositories/steward");
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { stopJobWorker } = await import("../../src/core/jobs/worker");
        const { enqueueIntent, processProjectSteward } = await import("../../src/core/steward/engine");
        await stopJobWorker();
        const projectId = await createProject("Missing run access");
        await stewardRepository.update(projectId, { autonomy: "observe" });
        const feature = await writer.createFeatureInRepo(projectId, null, "Sign in", "");
        const source = VALID_SPEC.replace("{ page, step }", "{ page, step, secret }")
            .replace('await page.goto("/");', 'await page.goto("/");\n        await page.getByLabel("Email").fill(secret("shopper", "email"));');
        const { spec } = await createSpec(projectId, feature.id, "Sign in", source);
        const intent = await enqueueIntent(projectId, { kind: "run_specs", goal: "Verify the preview", reason: "The human requested a preview check", specIds: [spec.id], baseUrl: "https://preview.example.com" }, "chat:missing-access", "user");
        await processProjectSteward(projectId, false);
        const waiting = (await stewardRepository.intents(projectId)).find((item) => item.id === intent.id)!;
        assert.equal(waiting.status, "running");
        const job = (await jobsRepository.get(intent.id))!;
        assert.equal(job.status, "blocked");
        assert.equal(job.kind, "review");
        assert.equal(job.tokensUsed, 0);
        assert.match(job.stopReason ?? "", /credentials.*not configured/);
        const question = (await jobsRepository.inbox(projectId))[0]!;
        assert.equal(question.kind, "question");
        assert.equal(question.payload.waitingFor, "credentials");
        assert.equal(question.payload.runIntentId, intent.id);
        for (let i = 0; i < 3; i++) await processProjectSteward(projectId, false);
        assert.equal((await jobsRepository.inbox(projectId)).length, 1);
        assert.equal((await stewardRepository.intents(projectId)).length, 1);
        await stewardRepository.signal({ projectId, kind: "credentials_changed", key: "access:changed", title: "Access changed", body: "Profiles changed" });
        await processProjectSteward(projectId, false);
        assert.equal((await jobsRepository.get(job.id))?.status, "completed", "answering a run prerequisite never starts an LLM turn");
        assert.equal((await jobsRepository.item(question.id))?.status, "answered");
        const resumed = (await stewardRepository.intents(projectId)).find((item) => item.key === `resume-run:${intent.id}:${question.id}`)!;
        assert.ok(resumed);
        assert.equal(resumed.source, "user");
        assert.equal(resumed.intent.baseUrl, "https://preview.example.com");
        assert.deepEqual(resumed.intent.specIds, [spec.id]);
        // The access signal did not actually add the profile: retry asks the exact prerequisite again, then waits.
        for (let i = 0; i < 3; i++) await processProjectSteward(projectId, false);
        assert.equal((await jobsRepository.get(resumed.id))?.status, "blocked");
        assert.equal((await jobsRepository.list(projectId)).length, 2);
        assert.equal((await jobsRepository.inbox(projectId)).filter((item) => item.status === "pending").length, 1);
        assert.equal((await stewardRepository.intents(projectId)).some((item) => ["explore", "coverage"].includes(item.intent.kind)), false);
    });

    test("keeps independent coverage requests and promoted bug reports distinct", async () => {
        const { enqueueIntent } = await import("../../src/core/steward/engine");
        const projectId = await createProject("Independent coverage");
        const base = { kind: "coverage", reason: "Missing coverage", goal: "Cover login" };
        const login = await enqueueIntent(projectId, base, "chat:login", "user");
        const duplicate = await enqueueIntent(projectId, { ...base, goal: " Cover   LOGIN " }, "chat:repeat", "user");
        const checkout = await enqueueIntent(projectId, { ...base, goal: "Cover checkout" }, "chat:checkout", "user");
        const regression = await enqueueIntent(projectId, base, "regression:bug-one", "user");
        assert.equal(login.fingerprint, duplicate.fingerprint);
        assert.notEqual(login.fingerprint, checkout.fingerprint);
        assert.notEqual(login.fingerprint, regression.fingerprint);
    });

    test("promoting a bug report creates one regression intent without changing the repository", async () => {
        const { createJobsRouter } = await import("../../src/infra/web/routes/jobs");
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { stewardRepository } = await import("../../src/infra/repositories/steward");
        const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
        const { stopJobWorker } = await import("../../src/core/jobs/worker");
        await stopJobWorker();
        const projectId = await createProject("Regression proposal");
        const job = await jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "manual", goal: "Investigate", limits: jobLimitsSchema.parse({}) });
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
        const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
        const { proposeMutation } = await import("../../src/core/jobs/proposals");
        const projectId = await createProject("Rejected proposal");
        const createJob = () => jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "manual", goal: "Propose coverage", limits: jobLimitsSchema.parse({}) });
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

describe("plain-language autonomous presentation", () => {
    test("unfinished updates stay out of Inbox, stopped attempts offer help, and stale updates disappear", async () => {
        const { projectPresentation } = await import("../../src/core/jobs/presentation");
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
        const { proposeMutation } = await import("../../src/core/jobs/proposals");
        const projectId = await createProject("Understandable updates");
        const feature = await writer.createFeatureInRepo(projectId, null, "Store", "");
        const { spec } = await createSpec(projectId, feature.id, "View results");
        const job = await jobsRepository.create({ projectId, specId: spec.id, kind: "regenerate", chatId: crypto.randomUUID(), trigger: "steward", goal: "Repair the check", limits: jobLimitsSchema.parse({}) });
        await jobsRepository.update(job.id, { status: "running" });
        const source = VALID_SPEC.replace('page.goto("/")', 'page.goto("/results")');
        const item = await proposeMutation(job, "update_spec", { specId: spec.id, testSource: source });
        const error = 'TimeoutError: expected result did not appear\n    at Object.click (/home/gus/specbook/src/core/runner/guard.ts:279:36)\n> 279 | await locator.click();\n      | ^\nArtifact: /tmp/specbook/storage/runs/private/error.txt';
        await jobsRepository.updateItem(item.id, { payload: { ...item.payload, verification: { status: "failed", failReason: error, screenshots: [] } } });
        assert.equal((await projectPresentation(projectId)).items.length, 0);
        await jobsRepository.update(job.id, { status: "stalled" });
        const paused = await projectPresentation(projectId);
        assert.equal(paused.items.length, 1);
        assert.equal(paused.items[0]?.presentation.type, "help");
        assert.match(paused.items[0]?.presentation.title ?? "", /Look at it together\?/);
        assert.equal(paused.summary.pausedCount, 0, "an unfinished attempt is not a user-requested pause");
        assert.equal(paused.summary.paused, false);
        assert.doesNotMatch(JSON.stringify(paused), /\/home\/gus|\/tmp\/specbook|src\/core\/runner|Object\.click|279 \|/);
        await writer.updateSpecWithLock(spec.id, { testSource: source });
        assert.equal((await projectPresentation(projectId)).items.length, 0, "an outdated failed suggestion is not a new decision");
        const { stewardRepository } = await import("../../src/infra/repositories/steward");
        await stewardRepository.update(projectId, { autonomy: "observe" });
        const observing = await projectPresentation(projectId);
        assert.equal(observing.summary.pausedCount, 0);
        assert.equal(observing.summary.paused, false);
        assert.match(observing.summary.statusText, /is watching/);
        assert.doesNotMatch(observing.summary.statusText, /tomorrow/);
        assert.equal(observing.activity[0]?.status, "stopped");
        assert.match(observing.activity[0]?.nextStep ?? "", /Discuss the check/);
        await jobsRepository.update(job.id, { status: "running" });
        const working = await projectPresentation(projectId);
        assert.equal(working.activity[0]?.status, "working");
        assert.match(working.summary.statusText, /is working on/);
    });

    test("groups repeated observations and investigations around one check and pairs the same screenshot step", async () => {
        const { projectPresentation } = await import("../../src/core/jobs/presentation");
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { stewardRepository } = await import("../../src/infra/repositories/steward");
        const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
        const { proposeMutation } = await import("../../src/core/jobs/proposals");
        const { sourceHashOf } = await import("../../src/core/repo/writer");
        const { runsDir } = await import("../../src/core/paths");
        const projectId = await createProject("Grouped story");
        const feature = await writer.createFeatureInRepo(projectId, null, "Store", "");
        const { spec } = await createSpec(projectId, feature.id, "Open results");
        const run = await runsRepository.createRun({ specId: spec.id, sourceHash: spec.sourceHash, commitSha: await repoGit.getHeadSha(projectId) });
        await runsRepository.finishRun(run.id, "failed", 1, "Missing results");
        await fs.mkdir(path.join(runsDir, run.id), { recursive: true });
        await fs.writeFile(path.join(runsDir, run.id, "evidence.json"), JSON.stringify({ failedStep: "Abrir a página", steps: [{ label: "Abrir a página", file: "evidence/step-01.png" }] }));
        const job = await jobsRepository.create({ projectId, runId: run.id, specId: spec.id, kind: "regenerate", chatId: crypto.randomUUID(), trigger: "steward", goal: "Repair", limits: jobLimitsSchema.parse({}) });
        const source = VALID_SPEC.replace('page.goto("/")', 'page.goto("/results")');
        const item = await proposeMutation(job, "update_spec", { specId: spec.id, testSource: source });
        await jobsRepository.updateItem(item.id, { payload: { ...item.payload, verification: { id: crypto.randomUUID(), status: "passed", sourceHash: sourceHashOf(source), screenshots: ["evidence/step-01.png", "evidence/step-02.png"] } } });
        await jobsRepository.update(job.id, { status: "completed" });
        await jobsRepository.log(job.id, "browser_snapshot:completed", "Captured the page");
        await jobsRepository.log(job.id, "proposal:verified", `${item.id}: passed`);
        for (const key of ["changed:one", "changed:two"]) await stewardRepository.signal({ projectId, key, kind: "invalid_spec", title: "Internal invalid status", body: "Internal detail", payload: { specIds: [spec.id] } });
        const view = await projectPresentation(projectId);
        assert.equal(view.activity.length, 1);
        assert.equal(view.activity[0]?.subject.id, spec.id);
        assert.deepEqual(new Set(view.activity[0]?.timeline.map((entry) => entry.label)), new Set(["Noticed", "Tested update", "Your decision"]));
        const times = view.activity[0]!.timeline.map((entry) => entry.createdAt);
        assert.deepEqual(times, [...times].sort(), "decision and evidence dates are chronological even when investigation ends later");
        assert.doesNotMatch(JSON.stringify(view.activity), /Reviewed the check and the available application evidence/);
        assert.notEqual(view.activity[0]?.timeline[0]?.detail, view.activity[0]?.summary);
        assert.match(view.items[0]?.presentation.screenshots.before?.url ?? "", /step-01\.png$/);
        assert.match(view.items[0]?.presentation.screenshots.after?.url ?? "", /step-01\.png$/);
        assert.equal(view.items[0]?.presentation.type, "update");
        assert.equal(view.items[0]?.presentation.summary, "Missing results. The expected behavior stays the same.");
        assert.doesNotMatch(view.items[0]?.presentation.summary ?? "", /passed/);
        assert.match(view.items[0]?.presentation.workDone ?? "", /passed/);
        assert.match(view.activity[0]?.title ?? "", /needs an update before it can run/);
        assert.equal(view.summary.attentionCount, 1);
        assert.match(view.summary.statusText, /is watching/);
    });

    test("keeps internal browser failures out of Inbox and removes source frames from optional diagnostics", async () => {
        const { projectPresentation } = await import("../../src/core/jobs/presentation");
        const { sanitizeTechnicalDetails, isInfrastructureFailure } = await import("../../src/core/jobs/presentation-errors");
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
        const projectId = await createProject("Service recovery");
        for (const display of [118, 119]) {
            const job = await jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "steward", goal: "Inspect", limits: jobLimitsSchema.parse({}) });
            await jobsRepository.update(job.id, { status: "blocked" });
            await jobsRepository.addItem({ projectId, jobId: job.id, kind: "question", title: "Job needs help", body: `O navegador não iniciou devido ao conflito do servidor X (display ${display}).` });
        }
        const view = await projectPresentation(projectId);
        assert.deepEqual(view.items, []);
        assert.equal(view.summary.attentionCount, 0);
        assert.ok(view.summary.systemHealth);
        assert.match(view.summary.systemHealth.message, /resume automatically/);
        assert.equal(view.activity.length, 0, "infrastructure recovery is represented by one health notice");
        const technical = sanitizeTechnicalDetails('TimeoutError: missing button\n    at Object.click (/home/gus/app/src/core/runner/guard.ts:279)\n> 279 | await locator.click()\n    ^\nC:\\Users\\gus\\specbook\\error.log\nSee /var/log/specbook/errors.txt\nURL: https://app.example.com/results');
        assert.match(technical, /TimeoutError: missing button/);
        assert.match(technical, /https:\/\/app.example.com\/results/);
        assert.doesNotMatch(technical, /\/home|C:\\Users|\/var\/log|guard\.ts|locator\.click|\bat Object/);
        assert.equal(isInfrastructureFailure("The application returned HTTP 503"), false);
        assert.equal(isInfrastructureFailure("browserType.launch: Xvfb failed"), true);
        assert.equal(isInfrastructureFailure("BrowserUnavailableError"), true);
        assert.equal(isInfrastructureFailure("Specbook couldn’t start its browser."), true);
        assert.equal(isInfrastructureFailure("Specbook could not start its browser."), true);
    });

    test("overview separates decisions from failing checks and keeps health independent of pause", async () => {
        const { projectOverview } = await import("../../src/core/jobs/overview");
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
        const { db } = await import("../../src/infra/db/client");
        const { inboxItems } = await import("../../src/infra/db/schema");
        const { eq } = await import("drizzle-orm");
        const projectId = await createProject("Organized overview");
        const { stewardRepository } = await import("../../src/infra/repositories/steward");
        await stewardRepository.update(projectId, { paused: true });
        const feature = await writer.createFeatureInRepo(projectId, null, "Survey", "");
        const checks = await Promise.all(["Passing", "Failing", "Flaky", "Paused one", "Paused two", "Unchecked", "Invalid"].map(async (title) => (await createSpec(projectId, feature.id, title)).spec));
        const [passing, failing, flaky, pausedOne, pausedTwo, unchecked, invalid] = checks;
        for (const spec of [passing!, failing!, flaky!]) {
            const status = spec.id === failing!.id ? "failed" : "passed";
            const run = await runsRepository.createRun({ specId: spec.id, sourceHash: spec.sourceHash, commitSha: await repoGit.getHeadSha(projectId) });
            await runsRepository.finishRun(run.id, status, 5, status === "failed" ? "Result did not appear" : null);
            await specsRepository.updateSpecStatus(spec.id, status);
            if (spec.id === flaky!.id) await runsRepository.markFlaky(run.id, run.id);
        }
        await specsRepository.updateSpecStatus(invalid!.id, "invalid", "spec.ts is missing");
        const previous = await jobsRepository.create({ projectId, specId: pausedOne!.id, kind: "explore", chatId: crypto.randomUUID(), trigger: "steward", goal: "Explore surveys", limits: jobLimitsSchema.parse({}) });
        await jobsRepository.update(previous.id, { status: "completed" });
        for (const spec of [pausedOne!, pausedTwo!]) {
            const job = await jobsRepository.create({ projectId, specId: spec.id, kind: "regenerate", chatId: crypto.randomUUID(), trigger: "steward", goal: "Update check", limits: jobLimitsSchema.parse({}) });
            await jobsRepository.update(job.id, { status: "stalled" });
        }
        const questionJob = await jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "steward", goal: "Clarify survey access", limits: jobLimitsSchema.parse({}) });
        await jobsRepository.update(questionJob.id, { status: "blocked" });
        const newer = await jobsRepository.addItem({ projectId, jobId: questionJob.id, kind: "question", title: "Should guests see survey results?", body: "Which results should be visible to guests?" });
        const older = await jobsRepository.addItem({ projectId, jobId: questionJob.id, kind: "question", title: "Should drafts appear in the survey list?", body: "Should the survey list include drafts?" });
        await db.update(inboxItems).set({ createdAt: "2024-01-01T00:00:00.000Z" }).where(eq(inboxItems.id, older.id));
        const failedRun = (await runsRepository.listRuns(failing!.id))[0]!;
        const bug = await jobsRepository.addItem({ projectId, jobId: questionJob.id, kind: "bug_report", title: "Deleting a survey shows an error", body: "Deleting the survey leaves it in the list.", payload: { specId: failing!.id, runId: failedRun.id } });
        const regeneration = await jobsRepository.create({ projectId, specId: invalid!.id, kind: "regenerate", chatId: crypto.randomUUID(), trigger: "steward", goal: "Restore the invalid check", limits: jobLimitsSchema.parse({}) });
        await jobsRepository.update(regeneration.id, { status: "completed", classification: "application_bug" });
        const invalidFinding = await jobsRepository.addItem({ projectId, jobId: regeneration.id, kind: "bug_report", title: "The results page cannot open", body: "Opening the results page leaves an empty screen." });
        const view = await projectOverview(projectId);
        assert.deepEqual(view.needsYou.map((item) => item.id), [older.id, newer.id]);
        assert.equal(view.summary.attentionCount, 2);
        assert.equal(view.failing.length, 2);
        assert.equal(view.failing.find((item) => item.specId === failing!.id)?.triageStatus, "App bug reported");
        assert.equal(view.failing.find((item) => item.specId === invalid!.id)?.triageStatus, "App bug reported");
        assert.deepEqual(view.failing.find((item) => item.specId === invalid!.id)?.inboxIds, [invalidFinding.id]);
        assert.equal(view.needsYou.some((item) => item.id === invalidFinding.id), false, "a bug found while regenerating an invalid check appears only under that failing check");
        assert.equal(view.summary.paused, true);
        assert.deepEqual(view.summary.specHealth, { total: 7, passing: 1, failing: 2, flaky: 1, not_checked: 3, running: 0 });
        assert.equal(view.specHealth[pausedOne!.id]?.status, "not_checked");
        assert.equal(view.specHealth[unchecked!.id]?.status, "not_checked");
        assert.equal(view.specHealth[invalid!.id]?.label, "Check needs an update");
        assert.equal(view.specHealth[flaky!.id]?.status, "flaky");
        assert.equal(view.recentRuns.length, 3, "recent activity contains actual runs, not completed agent sessions");
        assert.equal(view.stories.some((story) => story.inboxIds.includes(older.id)), true, "pending decisions retain a detail timeline");
        const finding = await jobsRepository.addItem({ projectId, jobId: previous.id, kind: "bug_report", title: "An export link is broken", body: "Opening export returns 404." });
        const withFinding = await projectOverview(projectId);
        const decision = withFinding.needsYou.find((item) => item.id === finding.id);
        assert.match(decision?.presentation.title ?? "", /^Add a regression check.*\?$/);
        assert.equal(withFinding.items.find((item) => item.id === finding.id)?.presentation.title, decision?.presentation.title);
        assert.equal(withFinding.summary.attentionCount, 3);
        assert.match(view.summary.nextCheck, /Resume Specbook/);
        await stewardRepository.update(projectId, { paused: false });
        const oldTriage = await jobsRepository.create({ projectId, specId: failing!.id, runId: failedRun.id, kind: "failure_triage", chatId: crypto.randomUUID(), trigger: "spec_failure", goal: "Investigate the previous failure", limits: jobLimitsSchema.parse({}) });
        await jobsRepository.update(oldTriage.id, { status: "completed", classification: "application_bug" });
        const passingRun = await runsRepository.createRun({ specId: failing!.id, sourceHash: failing!.sourceHash, commitSha: await repoGit.getHeadSha(projectId) });
        await runsRepository.finishRun(passingRun.id, "passed", 1, null);
        const newFailure = await runsRepository.createRun({ specId: failing!.id, sourceHash: failing!.sourceHash, commitSha: await repoGit.getHeadSha(projectId) });
        await runsRepository.finishRun(newFailure.id, "failed", 1, "A different element is missing");
        const uncheckedFailure = await projectOverview(projectId);
        const currentFailure = uncheckedFailure.failing.find((entry) => entry.specId === failing!.id)!;
        assert.equal(currentFailure.triageStatus, "Latest check failed");
        assert.equal(currentFailure.storyId, undefined, "old triage details do not stand in for the latest failure evidence");
        assert.ok(!currentFailure.inboxIds.includes(bug.id));
        const retry = await runsRepository.createRun({ specId: failing!.id, sourceHash: failing!.sourceHash, commitSha: await repoGit.getHeadSha(projectId), retryOf: newFailure.id });
        await runsRepository.finishRun(retry.id, "failed", 1, "The same element is still missing");
        const currentTriage = await jobsRepository.create({ projectId, specId: failing!.id, runId: newFailure.id, kind: "failure_triage", chatId: crypto.randomUUID(), trigger: "spec_failure", goal: "Investigate the current failure", limits: jobLimitsSchema.parse({}) });
        await jobsRepository.update(currentTriage.id, { status: "running" });
        assert.equal((await projectOverview(projectId)).failing.find((entry) => entry.specId === failing!.id)?.triageStatus, "Investigating…", "the original and retry belong to the same investigation");
    });

    test("overview keeps a batch live through retry and links the final grouped result to run evidence", async () => {
        const { projectOverview } = await import("../../src/core/jobs/overview");
        const { createJobsRouter } = await import("../../src/infra/web/routes/jobs");
        const { runBatchesDir } = await import("../../src/core/paths");
        const { stewardRepository } = await import("../../src/infra/repositories/steward");
        const { db } = await import("../../src/infra/db/client");
        const { projectSignals } = await import("../../src/infra/db/schema");
        const { eq } = await import("drizzle-orm");
        const projectId = await createProject("Batch overview");
        const feature = await writer.createFeatureInRepo(projectId, null, "Login", "");
        const { spec } = await createSpec(projectId, feature.id, "Sign in");
        const commitSha = await repoGit.getHeadSha(projectId);
        const original = await runsRepository.createRun({ specId: spec.id, sourceHash: spec.sourceHash, commitSha, automate: true });
        await runsRepository.finishRun(original.id, "failed", 10, "Login button was not visible");
        const batchId = crypto.randomUUID();
        await fs.mkdir(path.join(runBatchesDir, batchId), { recursive: true });
        const batch = {
            id: batchId, projectId, label: "Login checks", status: "failed", startedAt: original.startedAt, durationMs: 10, failReason: null,
            specs: [{ runId: original.id, specId: spec.id, commitSha, sourceHash: spec.sourceHash, markdownHash: spec.markdownHash, title: spec.title, status: "failed", durationMs: 10, failReason: "Login button was not visible" }],
        } satisfies import("../../src/core/runner/batch").RunBatch;
        await fs.writeFile(path.join(runBatchesDir, batchId, "batch.json"), JSON.stringify(batch));
        await stewardRepository.signal({ projectId, kind: "deployment", key: "deploy:preview", title: "Preview deployed", body: "Check the preview" });
        const signal = (await stewardRepository.signals(projectId))[0]!;
        const runIntent = { kind: "run_specs" as const, goal: "Check login", reason: "Login changed", specIds: [spec.id], priority: 50 };
        const deployment = await stewardRepository.addIntent({ projectId, key: `signal:${signal.id}`, fingerprint: "deploy:preview", intent: runIntent, priority: 50, reason: runIntent.reason });
        await stewardRepository.updateIntent(deployment.id, { status: "completed" });
        const resumed = await stewardRepository.addIntent({ projectId, key: `resume-run:${deployment.id}:answer`, fingerprint: "resumed:preview", intent: runIntent, priority: 50, reason: runIntent.reason });
        await stewardRepository.updateIntent(resumed.id, { status: "running", batchId });
        const pending = await projectOverview(projectId);
        assert.equal(pending.recentRuns.length, 1);
        assert.equal(pending.recentRuns[0]?.id, `batch:${batchId}`);
        assert.equal(pending.recentRuns[0]?.status, "working");
        assert.equal(pending.recentRuns[0]?.counts.running, 1);
        assert.equal(pending.recentRuns[0]?.trigger, "deploy", "resumed deployments retain their original trigger");
        await runsRepository.finishRun(original.id, "passed", 10, null);
        assert.deepEqual((await projectOverview(projectId)).recentRuns[0]?.counts, { total: 1, passed: 0, failed: 0, flaky: 0, running: 1 }, "pending automation is counted once even after a passing result");
        await runsRepository.finishRun(original.id, "failed", 10, "Login button was not visible");
        const retry = await runsRepository.createRun({ specId: spec.id, sourceHash: spec.sourceHash, commitSha, retryOf: original.id });
        await runsRepository.finishRun(retry.id, "passed", 20, null);
        await runsRepository.markFlaky(original.id, retry.id);
        assert.deepEqual((await projectOverview(projectId)).recentRuns[0]?.counts, { total: 1, passed: 0, failed: 0, flaky: 0, running: 1 }, "marking flaky before acknowledgment never duplicates the result count");
        await runsRepository.acknowledgeAutomation(original.id);
        await specsRepository.updateSpecStatus(spec.id, "passed");
        const router = new Hono().route("/", createJobsRouter());
        const response = await router.request(`/projects/${projectId}/overview`);
        assert.equal(response.status, 200);
        const view = await response.json() as Awaited<ReturnType<typeof projectOverview>>;
        assert.equal(view.recentRuns[0]?.status, "completed");
        assert.equal(view.recentRuns.length, 1, "batch runs and retries are not repeated as standalone history rows");
        assert.match(view.recentRuns[0]?.title ?? "", /1 passed on retry/);
        assert.equal(view.recentRuns[0]?.outcome, "flaky");
        assert.equal(view.recentRuns[0]?.timeline[0]?.specId, spec.id);
        assert.equal(view.recentRuns[0]?.timeline[0]?.runId, retry.id);
        assert.equal(view.recentRuns[0]?.updatedAt, new Date(Date.parse(retry.startedAt) + 20).toISOString());
        assert.equal(view.specHealth[spec.id]?.status, "flaky");
        assert.equal((await router.request(`/projects/${crypto.randomUUID()}/overview`)).status, 404);
        await fs.writeFile(path.join(runBatchesDir, batchId, "batch.json"), JSON.stringify({ ...batch, trigger: "deploy" }));
        await db.delete(projectSignals).where(eq(projectSignals.projectId, projectId));
        await stewardRepository.updateIntent(resumed.id, { status: "completed" });
        const finished = await stewardRepository.addIntent({ projectId, key: "login:old", fingerprint: "login:old", intent: runIntent, priority: 50, reason: runIntent.reason });
        await stewardRepository.updateIntent(finished.id, { status: "completed", batchId });
        await stewardRepository.addIntent({ projectId, key: "login:new", fingerprint: "login:new", intent: runIntent, priority: 50, reason: runIntent.reason });
        const again = await projectOverview(projectId);
        assert.equal(again.recentRuns.length, 1, "a pending intention is not a new run");
        assert.equal(again.recentRuns[0]?.id, `batch:${batchId}`);
        assert.equal(again.recentRuns[0]?.trigger, "deploy", "stored run triggers survive observation retention and missing original signals");
        assert.equal(again.stories.some((story) => story.status === "queued" && story.specId === spec.id), true);
    });
});

test("agent evaluation records outcomes and decisions without prompts or credentials", async () => {
    const { execFileSync } = await import("node:child_process");
    const { jobsRepository } = await import("../../src/infra/repositories/jobs");
    const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
    const { jobMetricsPath, recordAgentMetric } = await import("../../src/core/jobs/metrics");
    const projectId = await createProject("Evaluation records");
    const secret = "private-input-never-exported";
    const job = await jobsRepository.create({ projectId, chatId: crypto.randomUUID(), kind: "failure_triage", trigger: "spec_failure", goal: secret, limits: jobLimitsSchema.parse({}) });
    await jobsRepository.claim(job.id);
    await jobsRepository.update(job.id, { classification: "test_drift", tokensUsed: 123, actionsUsed: 4, elapsedMs: 500 });
    const item = await jobsRepository.addItem({ projectId, jobId: job.id, kind: "spec_fix", title: secret, body: secret });
    await jobsRepository.log(job.id, "proposal:verified", `${item.id}: passed`);
    await jobsRepository.log(job.id, "inbox:reject", item.id);
    const current = (await jobsRepository.get(job.id))!;
    await recordAgentMetric(current, "decision", { itemId: item.id, decision: "approve", actor: "agent" });
    const records = (await fs.readFile(jobMetricsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.jobId === job.id);
    assert.deepEqual(records.map((event) => event.event), ["created", "started", "classified", "item_created", "verified", "decision", "decision"]);
    assert.equal(records[2].classification, "test_drift");
    assert.equal(records[4].verificationStatus, "passed");
    assert.equal(records[5].actor, "human");
    assert.equal(records[6].actor, "agent");
    assert.equal(records[6].tokensUsed, 123);
    assert.doesNotMatch(JSON.stringify(records), new RegExp(secret));
    const csv = execFileSync(process.execPath, ["scripts/export-metrics.mjs", jobMetricsPath, "--agent"], { encoding: "utf8" });
    assert.match(csv, /classification,tokensUsed,actionsUsed,elapsedMs/);
    assert.match(csv, new RegExp(`${item.id},,reject,human`));
    assert.doesNotMatch(csv, new RegExp(secret));
});
