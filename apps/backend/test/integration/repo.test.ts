import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { before, describe, test } from "node:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { simpleGit } from "simple-git";
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
const { repoRemote } = await import("../../src/core/repo/remote");
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

    test("a Spec with only the old spec.robot is indexed as invalid and can be regenerated", async () => {
        const projectId = await createProject();
        const feature = await writer.createFeatureInRepo(projectId, null, "Legado", "");
        const { spec } = await createSpec(projectId, feature.id, "Antigo");
        const root = repoGit.getRepoDir(projectId);
        const git = repoGit.getProjectGit(projectId);
        await fs.rm(path.join(root, spec.path, "spec.ts"));
        await fs.writeFile(path.join(root, spec.path, "spec.robot"), "*** Test Cases ***\nCaso\n    Log    x\n");
        await git.add(["-A"]);
        await git.commit("an old Robot Framework spec");

        await reindexProject(projectId);
        const legacy = await specsRepository.getSpec(spec.id);
        assert.equal(legacy?.status, "invalid");
        assert.equal(legacy?.invalidReason, "This Spec uses the old Robot Framework format; regenerate it in a chat");
        const detail = (await (await api("GET", `/specs/${spec.id}`)).json()) as { content: { testSource: string; legacyRobotSource: string | null } };
        assert.equal(detail.content.testSource, "");
        assert.match(detail.content.legacyRobotSource ?? "", /Test Cases/);

        const { spec: regenerated } = await writer.updateSpecInRepo(legacy!, { testSource: VALID_SPEC });
        assert.equal(regenerated.status, "unverified");
        assert.ok(!existsSync(path.join(root, spec.path, "spec.robot")), "spec.ts replaces the Robot file");
        assert.ok((await git.status()).isClean());
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

    test("PATCH on a spec is blocked while the project has a sync conflict", async () => {
        const projectId = await createProject();
        const feature = await writer.createFeatureInRepo(projectId, null, "F", "");
        const { spec } = await createSpec(projectId, feature.id, "Spec");
        const commits = await commitCount(projectId);

        await projectsRepository.setGitConflictPaths(projectId, ["specs/f/spec/spec.yml"]);
        const blocked = await api("PATCH", `/specs/${spec.id}`, { title: "Novo título" });
        assert.equal(blocked.status, 409);
        assert.match(((await blocked.json()) as { error: string }).error, /sync conflict/);
        assert.equal((await specsRepository.getSpec(spec.id))?.title, "Spec");
        assert.equal(await commitCount(projectId), commits);

        await projectsRepository.setGitConflictPaths(projectId, null);
        const allowed = await api("PATCH", `/specs/${spec.id}`, { title: "Novo título" });
        assert.equal(allowed.status, 200);
        assert.equal((await specsRepository.getSpec(spec.id))?.path, "specs/f/novo-titulo");
        assert.equal(await commitCount(projectId), commits + 1);
    });

    test("a spec in conflict status cannot be edited", async () => {
        const projectId = await createProject();
        const feature = await writer.createFeatureInRepo(projectId, null, "F", "");
        const { spec } = await createSpec(projectId, feature.id, "Spec");
        await specsRepository.updateSpecStatus(spec.id, "conflict");
        const response = await api("PATCH", `/specs/${spec.id}`, { description: "x" });
        assert.equal(response.status, 409);
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
        // A local "GitHub" remote, to observe pushes.
        const remoteDir = tempDir();
        await simpleGit(remoteDir).init(["--bare", "--initial-branch=main"]);
        const projectId = await createProject();
        await projectsRepository.updateGitConnection(projectId, remoteDir, null);
        const feature = await writer.createFeatureInRepo(projectId, null, "F", "");
        await createSpec(projectId, feature.id, "Spec");
        await repoRemote.flushPush(projectId);
        const remoteHead = (await simpleGit(remoteDir).raw(["rev-parse", "main"])).trim();
        assert.equal(remoteHead, await repoGit.getHeadSha(projectId));

        const checkoutDir = repoGit.getRepoDir(projectId);
        const bareDir = repoBare.getBareRepoDir(projectId);
        const calls: string[] = [];
        const originals = {
            commitAll: repoGit.commitAll,
            schedulePush: repoRemote.schedulePush,
            flushPush: repoRemote.flushPush,
        };
        repoGit.commitAll = async (...args) => {
            calls.push("commitAll");
            return originals.commitAll.apply(repoGit, args);
        };
        repoRemote.schedulePush = (...args) => {
            calls.push("schedulePush");
            return originals.schedulePush.apply(repoRemote, args);
        };
        repoRemote.flushPush = async (...args) => {
            calls.push("flushPush");
            return originals.flushPush.apply(repoRemote, args);
        };
        try {
            const response = await api("DELETE", `/projects/${projectId}`);
            assert.equal(response.status, 204);
            await new Promise((resolve) => setTimeout(resolve, 50));
        } finally {
            Object.assign(repoGit, { commitAll: originals.commitAll });
            Object.assign(repoRemote, { schedulePush: originals.schedulePush, flushPush: originals.flushPush });
        }
        assert.deepEqual(calls, []);
        assert.equal(await projectsRepository.getProject(projectId), null);
        assert.deepEqual(await specsRepository.listSpecs(projectId), []);
        assert.deepEqual(await featuresRepository.listFeatures(projectId), []);
        assert.ok(!existsSync(checkoutDir));
        assert.ok(!existsSync(bareDir));
        assert.equal((await simpleGit(remoteDir).raw(["rev-parse", "main"])).trim(), remoteHead, "the remote keeps its history");
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
        await writer.createFeatureInRepo(projectId, null, "Another", "");
        await assert.rejects(() => applyProposal(stale), /repository changed/);
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
        const credential = createJobPolicy(job2, () => {}).tools([{ name: "request_credential", label: "request", description: "test", parameters: Type.Object({}), async execute() { throw new Error("must be intercepted"); } }])[0]!;
        await credential.execute("1", {}, undefined, undefined, {} as never);
        assert.equal((await jobsRepository.get(job2.id))?.status, "blocked");
        assert.equal((await jobsRepository.inbox(projectId))[0]?.kind, "question");
        await assert.rejects(() => credential.execute("2", {}, undefined, undefined, {} as never), /paused/);
        await jobsRepository.update(job2.id, { status: "running", startedAt: new Date().toISOString() });
        await jobsRepository.recover();
        assert.equal((await jobsRepository.get(job2.id))?.status, "queued");
    });
});
