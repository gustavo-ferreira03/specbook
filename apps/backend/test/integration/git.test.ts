import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { before, describe, test } from "node:test";
import { simpleGit, type SimpleGit } from "simple-git";
import { tempDir, useTempStorage } from "../helpers/storage";

useTempStorage();
const { runMigrations } = await import("../../src/infra/db/migrate");
const { repoGit } = await import("../../src/core/repo/git");
const { repoBare, BareStateError } = await import("../../src/core/repo/bare");
const { projectsRepository } = await import("../../src/infra/repositories/projects");

const AUTHOR = ["-c", "user.name=test", "-c", "user.email=test@local", "-c", "commit.gpgsign=false"];

before(async () => {
    await runMigrations();
});

async function newProject(): Promise<{ id: string; checkout: string; git: SimpleGit }> {
    const project = await projectsRepository.createProject("P", "https://app.example.com");
    await repoGit.ensureProjectRepo(project.id, { create: true });
    await repoBare.ensureBareRepo(project.id, repoGit.getRepoDir(project.id));
    return { id: project.id, checkout: repoGit.getRepoDir(project.id), git: repoGit.getProjectGit(project.id) };
}

/** Commits directly in the checkout, without publishing to the bare repository. */
async function commitInCheckout(git: SimpleGit, dir: string, file: string, content: string): Promise<string> {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.writeFile(path.join(dir, file), content);
    await git.add(["-A"]);
    await git.commit(`edit ${file}`);
    return (await git.revparse(["HEAD"])).trim();
}

/** An external Git client: a clone of the bare repository pushing over the file protocol. */
async function cloneBare(projectId: string): Promise<{ dir: string; git: SimpleGit }> {
    const dir = path.join(tempDir(), "clone");
    await simpleGit().clone(repoBare.getBareRepoDir(projectId), dir);
    return { dir, git: simpleGit(dir) };
}

async function pushCommit(client: { dir: string; git: SimpleGit }, file: string, content: string): Promise<string> {
    await fs.mkdir(path.dirname(path.join(client.dir, file)), { recursive: true });
    await fs.writeFile(path.join(client.dir, file), content);
    await client.git.raw([...AUTHOR, "add", "-A"]);
    await client.git.raw([...AUTHOR, "commit", "-m", `client ${file}`]);
    await client.git.raw(["push", "origin", "main"]);
    return (await client.git.revparse(["HEAD"])).trim();
}

async function stateError(projectId: string): Promise<string | null> {
    return (await projectsRepository.getProject(projectId))?.gitExternalSyncError ?? null;
}

describe("repoBare", () => {
    test("publish copies a checkout that is ahead", async () => {
        const project = await newProject();
        assert.equal((await repoBare.compare(project.id, project.checkout)).relation, "equal");
        const sha = await commitInCheckout(project.git, project.checkout, "specs/a/feature.yml", "title: A\n");
        assert.equal((await repoBare.compare(project.id, project.checkout)).relation, "checkout-ahead");
        await repoBare.publish(project.id, project.checkout);
        assert.equal(await repoBare.getBareHeadSha(project.id), sha);
        assert.equal((await repoBare.compare(project.id, project.checkout)).relation, "equal");
    });

    test("a pushed commit is followed by fast-forward, and publish refuses to overwrite it", async () => {
        const project = await newProject();
        const client = await cloneBare(project.id);
        const pushed = await pushCommit(client, "specs/b/feature.yml", "title: B\n");
        assert.equal((await repoBare.compare(project.id, project.checkout)).relation, "bare-ahead");

        await assert.rejects(repoBare.publish(project.id, project.checkout), BareStateError);
        assert.equal(await repoBare.getBareHeadSha(project.id), pushed);
        assert.match((await stateError(project.id)) ?? "", /has not followed yet/);

        assert.deepEqual(await repoBare.fastForwardCheckout(project.id, project.checkout), { moved: true, sha: pushed });
        assert.equal(await repoGit.getHeadSha(project.id), pushed);
        assert.ok(existsSync(path.join(project.checkout, "specs/b/feature.yml")));
        assert.equal(await stateError(project.id), null);
        assert.deepEqual(await repoBare.fastForwardCheckout(project.id, project.checkout), { moved: false, sha: pushed });
    });

    test("fast-forward refuses a dirty checkout", async () => {
        const project = await newProject();
        await pushCommit(await cloneBare(project.id), "a.txt", "a");
        await fs.writeFile(path.join(project.checkout, "local.txt"), "wip");
        await assert.rejects(repoBare.fastForwardCheckout(project.id, project.checkout), /uncommitted changes/);
        assert.ok(existsSync(path.join(project.checkout, "local.txt")));
    });

    test("diverged histories are never resolved automatically", async () => {
        const project = await newProject();
        const pushed = await pushCommit(await cloneBare(project.id), "remote.txt", "remote");
        const local = await commitInCheckout(project.git, project.checkout, "local.txt", "local");
        assert.equal((await repoBare.compare(project.id, project.checkout)).relation, "diverged");
        await assert.rejects(repoBare.publish(project.id, project.checkout), /diverged/);
        await assert.rejects(repoBare.fastForwardCheckout(project.id, project.checkout), /diverged/);
        assert.equal(await repoBare.getBareHeadSha(project.id), pushed);
        assert.equal(await repoGit.getHeadSha(project.id), local);
        assert.match((await stateError(project.id)) ?? "", /diverged/);
    });

});

describe("pre-receive hook of the canonical repository", () => {
    test("rejects a pushed commit that contains a symbolic link", async () => {
        const project = await newProject();
        const before = await repoBare.getBareHeadSha(project.id);
        const client = await cloneBare(project.id);
        await fs.mkdir(path.join(client.dir, "specs", "x"), { recursive: true });
        await fs.symlink("/etc/passwd", path.join(client.dir, "specs", "x", "spec.yml"));
        await client.git.raw([...AUTHOR, "add", "-A"]);
        await client.git.raw([...AUTHOR, "commit", "-m", "symlink"]);
        await assert.rejects(client.git.raw(["push", "origin", "main"]), /does not accept symbolic links/);
        assert.equal(await repoBare.getBareHeadSha(project.id), before);
    });

    test("rejects a symbolic link hidden in an earlier commit of the push", async () => {
        const project = await newProject();
        const client = await cloneBare(project.id);
        await fs.symlink("/etc/passwd", path.join(client.dir, "link"));
        await client.git.raw([...AUTHOR, "add", "-A"]);
        await client.git.raw([...AUTHOR, "commit", "-m", "add link"]);
        await fs.rm(path.join(client.dir, "link"));
        await fs.writeFile(path.join(client.dir, "ok.txt"), "ok");
        await client.git.raw([...AUTHOR, "add", "-A"]);
        await client.git.raw([...AUTHOR, "commit", "-m", "remove link"]);
        await assert.rejects(client.git.raw(["push", "origin", "main"]), /symbolic links/);
    });

    test("rejects branches other than main, deletions and non-fast-forwards", async () => {
        const project = await newProject();
        const client = await cloneBare(project.id);
        await client.git.raw(["push", "origin", "main:feature"]).then(
            () => assert.fail("push to another branch should fail"),
            (error: Error) => assert.match(error.message, /accepts pushes to refs\/heads\/main only/),
        );
        await assert.rejects(client.git.raw(["push", "origin", ":main"]));
        await pushCommit(client, "a.txt", "a");
        await client.git.raw(["reset", "--hard", "HEAD~1"]);
        await client.git.raw([...AUTHOR, "commit", "--allow-empty", "-m", "other"]);
        await assert.rejects(client.git.raw(["push", "--force", "origin", "main"]));
    });

    test("accepts a regular push", async () => {
        const project = await newProject();
        const sha = await pushCommit(await cloneBare(project.id), "specs/a/feature.yml", "title: A\n");
        assert.equal(await repoBare.getBareHeadSha(project.id), sha);
    });
});

describe("repoGit.recoverInterruptedState", () => {
    test("removes a stale index.lock", async () => {
        const project = await newProject();
        const lock = path.join(project.checkout, ".git", "index.lock");
        await fs.writeFile(lock, "");
        await fs.writeFile(path.join(project.checkout, "a.txt"), "a");
        await assert.rejects(project.git.add(["-A"]), /index\.lock/);
        await repoGit.recoverInterruptedState(project.id);
        assert.ok(!existsSync(lock));
        await project.git.add(["-A"]);
    });

    test("aborts a pending rebase and restores HEAD", async () => {
        const project = await newProject();
        const base = await repoGit.getHeadSha(project.id);
        await commitInCheckout(project.git, project.checkout, "f.txt", "base\n");
        const mainHead = await commitInCheckout(project.git, project.checkout, "f.txt", "main\n");
        await project.git.raw(["checkout", "-b", "other", base]);
        await commitInCheckout(project.git, project.checkout, "f.txt", "other\n");
        await project.git.raw(["checkout", "main"]);
        await project.git.rebase(["other"]).catch(() => undefined);
        assert.ok(existsSync(path.join(project.checkout, ".git", "rebase-merge")), "the rebase stopped on a conflict");
        await assert.rejects(repoGit.assertRepoWritableUnlocked(project.id), /unfinished rebase/);

        await repoGit.recoverInterruptedState(project.id);
        assert.ok(!existsSync(path.join(project.checkout, ".git", "rebase-merge")));
        assert.equal(await repoGit.getHeadSha(project.id), mainHead);
        await repoGit.assertRepoWritableUnlocked(project.id);
    });

    test("removes stale locks of the bare repository", async () => {
        const project = await newProject();
        const lock = path.join(repoBare.getBareRepoDir(project.id), "HEAD.lock");
        await fs.writeFile(lock, "");
        await repoGit.recoverInterruptedState(project.id);
        assert.ok(!existsSync(lock));
    });

    test("refuses to run while a repository operation holds the lock", async () => {
        const project = await newProject();
        let release: () => void = () => {};
        const held = repoGit.withRepoLock(project.id, () => new Promise<void>((resolve) => (release = resolve)));
        await assert.rejects(repoGit.recoverInterruptedState(project.id), /Refusing to recover/);
        release();
        await held;
    });
});

test("coverage uses confirmed context, tested routes and current runs from the selected environment", async () => {
    const { Hono } = await import("hono");
    const { EMPTY_PROJECT_CONTEXT } = await import("../../src/infra/db/schema");
    const { featuresRepository } = await import("../../src/infra/repositories/features");
    const { specsRepository } = await import("../../src/infra/repositories/specs");
    const { runsRepository } = await import("../../src/infra/repositories/runs");
    const { projectContextsRepository } = await import("../../src/infra/repositories/project-contexts");
    const { environmentsRepository } = await import("../../src/infra/repositories/environments");
    const { projectCoverage } = await import("../../src/core/coverage");
    const { resolveRunEnvironment } = await import("../../src/core/environments");
    const { sourceHashOf, markdownHashOf } = await import("../../src/core/repo/writer");
    const { serializeSpecYaml } = await import("../../src/core/repo/yaml");
    const { runsDir } = await import("../../src/core/paths");
    const { getRunBatchDirectory } = await import("../../src/core/runner/batch");
    const { createCoverageRouter } = await import("../../src/infra/web/routes/coverage");
    const project = await newProject();
    const feature = await featuresRepository.createFeature(project.id, null, "Checkout", "", "checkout");
    const apiFeature = await featuresRepository.createFeature(project.id, null, "API", "", "api");
    await environmentsRepository.create(project.id, { name: "Staging", baseUrl: "https://staging.example.com", allowedOrigins: [], credentialOverrides: {} });
    const production = await resolveRunEnvironment(project.id);
    const staging = await resolveRunEnvironment(project.id, "staging");
    const addSpec = async (title: string, target: string, api = false) => {
        const source = `import { test, expect } from "specbook";\ntest(${JSON.stringify(title)}, async ({ ${api ? "request" : "page"}, step }) => {\n    await step("Open", async () => { ${api ? `const response = await request.get(${JSON.stringify(target)}); await expect(response).toBeOK();` : `await page.goto(${JSON.stringify(target)}); await expect(page.getByRole("heading")).toBeVisible();`} });\n});\n`;
        const yaml = serializeSpecYaml({ title, description: "", humanSpec: { preconditions: [], steps: ["Open"], expectedResult: "The Spec passes", postconditions: [] } });
        const spec = await specsRepository.createSpecRecord({ projectId: project.id, featureId: api ? apiFeature.id : feature.id, title, description: "", path: `specs/${sourceHashOf(title).slice(0, 8)}`, sourceHash: sourceHashOf(source), markdownHash: markdownHashOf(yaml) });
        await fs.mkdir(path.join(project.checkout, spec.path), { recursive: true });
        await fs.writeFile(path.join(project.checkout, spec.path, "spec.ts"), source);
        await fs.writeFile(path.join(project.checkout, spec.path, "spec.yml"), yaml);
        return { spec, yaml };
    };
    const checkout = await addSpec("Checkout page", "/checkout");
    const settings = await addSpec("Settings page", "/settings");
    const api = await addSpec("Admin can manage accounts", "/api/users/42", true);
    const stale = await addSpec("Checkout confirmation", "/checkout/confirmation");
    const running = await addSpec("Checkout running", "/checkout/running");
    const invalid = await specsRepository.createSpecRecord({ projectId: project.id, featureId: feature.id, title: "Checkout broken", description: "", path: "specs/broken", sourceHash: "bad", markdownHash: "bad", status: "invalid" });
    const addRun = async (input: typeof checkout, environment: typeof production, status: "passed" | "failed" | "running", retryOf?: string) => {
        const run = await runsRepository.createRun({ specId: input.spec.id, sourceHash: input.spec.sourceHash, commitSha: "test", environment, retryOf });
        await fs.mkdir(path.join(runsDir, run.id), { recursive: true });
        await fs.writeFile(path.join(runsDir, run.id, "spec.yml"), input.yaml);
        if (status !== "running") await runsRepository.finishRun(run.id, status, 10, status === "failed" ? "Spec failed" : null);
        return (await runsRepository.getRun(run.id))!;
    };
    const passed = await addRun(checkout, production, "passed");
    const stagingFailed = await addRun(checkout, staging, "failed");
    const failed = await addRun(stale, production, "failed");
    const retry = await addRun(stale, production, "passed", failed.id);
    await runsRepository.markFlaky(failed.id, retry.id);
    await addRun(running, production, "running");
    await addRun(settings, production, "passed");
    const rule = "Admin can manage accounts";
    const context = { ...EMPTY_PROJECT_CONTEXT, areas: [
        { name: "Checkout", description: "Purchase flow", routes: ["/checkout", "/checkout/shipping"] },
        { name: "Settings", description: "Preferences", routes: ["/settings"] },
        { name: "Accounts", description: "API users", routes: ["/api/users/{id}"] },
        { name: "Reports", description: "Usage report", routes: ["/reports"] },
    ], roles: [{ name: "Admin", capabilities: ["Manage accounts"] }, { name: "Viewer", capabilities: ["Read reports"] }], businessRules: [rule] };
    const brief = { goal: "Explore", startUrl: "https://app.example.com", safetyNotes: [] };
    const contextDraft = await projectContextsRepository.createProjectContextDraft(project.id, brief);
    await projectContextsRepository.replaceProjectContextDraft(contextDraft.id, context);
    assert.equal((await projectCoverage(project.id)).confirmed, false);
    assert.deepEqual((await projectCoverage(project.id)).areas, [], "unconfirmed discovery cannot claim coverage");
    await projectContextsRepository.confirmProjectContextRevision(contextDraft.id);
    const batch = async (date: string, environment: typeof production, run: typeof passed, knownBug = false) => {
        const id = `${date.replace(/\D/g, "")}-${run.id}`;
        const directory = getRunBatchDirectory(id);
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, "batch.json"), JSON.stringify({ id, projectId: project.id, label: date, status: run.status, startedAt: date, durationMs: 10, failReason: null, environment,
            ...(knownBug ? { ci: { knownBugSpecIds: [run.specId], qualityGate: { failOnFlaky: false, failOnKnownBugs: false } } } : {}),
            specs: [{ runId: run.id, specId: run.specId, title: "Spec", sourceHash: run.sourceHash, markdownHash: "yaml", commitSha: "test", status: run.status, durationMs: 10, failReason: run.failReason }] }));
        return id;
    };
    const older = await batch("2026-01-01T00:00:00.000Z", production, passed);
    const newer = await batch("2026-01-02T00:00:00.000Z", production, failed);
    await batch("2026-01-03T00:00:00.000Z", staging, stagingFailed, true);
    const result = await projectCoverage(project.id);
    assert.equal(result.confirmed, true);
    assert.equal(result.environment.name, "Production");
    assert.deepEqual(result.areas.filter((area) => area.kind === "area").map((area) => area.coverage), ["partial", "covered", "covered", "uncovered"]);
    assert.deepEqual(result.areas[0]?.matchedRoutes, ["/checkout"]);
    assert.deepEqual(result.areas[2]?.specIds, [api.spec.id], "literal API requests cover parameterized routes");
    assert.equal(result.areas.find((area) => area.kind === "role" && area.name === "Admin")?.coverage, "covered");
    assert.equal(result.areas.find((area) => area.kind === "role" && area.name === "Viewer")?.coverage, "uncovered");
    assert.equal(result.areas.find((area) => area.kind === "rule")?.coverage, "covered");
    assert.deepEqual(result.features.find((row) => row.id === feature.id)?.counts, { passing: 2, failing: 0, flaky: 1, notRun: 0, invalid: 1, running: 1 });
    assert.deepEqual(result.trend.map((row) => [row.id, row.passRate]), [[older, 100], [newer, 100]], "retry passes count as flaky passes and history is chronological");
    const staged = await projectCoverage(project.id, "staging");
    assert.equal(staged.features.find((row) => row.id === feature.id)?.counts.failing, 1);
    assert.equal(staged.trend[0]?.passRate, 0, "a known bug allowed by the CI gate still reduces the actual pass rate");
    const changedYaml = checkout.yaml.replace("The Spec passes", "A new expected behavior");
    await fs.writeFile(path.join(project.checkout, checkout.spec.path, "spec.yml"), changedYaml);
    await specsRepository.updateSpecRecord(checkout.spec.id, { markdownHash: markdownHashOf(changedYaml) });
    assert.equal((await projectCoverage(project.id)).features.find((row) => row.id === feature.id)?.counts.notRun, 1, "a changed behavior cannot reuse a passing run of the previous contract");
    const app = new Hono().route("/", createCoverageRouter());
    assert.equal((await app.request(`/projects/${project.id}/coverage?environment=missing`)).status, 400);
    assert.equal((await app.request("/projects/00000000-0000-4000-8000-000000000000/coverage")).status, 404);
    assert.equal((await app.request(`/projects/${project.id}/coverage?environment=Staging`)).status, 200);
    await fs.rm(path.join(project.checkout, api.spec.path, "spec.ts"));
    await fs.symlink("/etc/passwd", path.join(project.checkout, api.spec.path, "spec.ts"));
    const unsafe = await projectCoverage(project.id);
    assert.equal(unsafe.features.find((row) => row.id === apiFeature.id)?.counts.invalid, 1, "coverage reads refuse repository symlinks");
    assert.equal(invalid.status, "invalid");
});
