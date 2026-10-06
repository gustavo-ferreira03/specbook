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

test("coverage gives each confirmed area the Specs of its feature and of its tested routes", async () => {
    const { Hono } = await import("hono");
    const { EMPTY_PROJECT_CONTEXT } = await import("../../src/infra/db/schema");
    const { featuresRepository } = await import("../../src/infra/repositories/features");
    const { specsRepository } = await import("../../src/infra/repositories/specs");
    const { projectContextsRepository } = await import("../../src/infra/repositories/project-contexts");
    const { projectCoverage } = await import("../../src/core/coverage");
    const { createAreaFeatures, sourceHashOf, markdownHashOf } = await import("../../src/core/repo/writer");
    const { serializeSpecYaml } = await import("../../src/core/repo/yaml");
    const { createCoverageRouter } = await import("../../src/infra/web/routes/coverage");
    const project = await newProject();
    const feature = await featuresRepository.createFeature(project.id, null, "Checkout", "", "checkout");
    const apiFeature = await featuresRepository.createFeature(project.id, null, "API", "", "api");
    const addSpec = async (title: string, target: string, api = false) => {
        const source = `import { test, expect } from "specbook";\ntest(${JSON.stringify(title)}, async ({ ${api ? "request" : "page"}, step }) => {\n    await step("Open", async () => { ${api ? `const response = await request.get(${JSON.stringify(target)}); await expect(response).toBeOK();` : `await page.goto(${JSON.stringify(target)}); await expect(page.getByRole("heading")).toBeVisible();`} });\n});\n`;
        const yaml = serializeSpecYaml({ title, description: "", humanSpec: { preconditions: [], steps: ["Open"], expectedResult: "The Spec passes", postconditions: [] } });
        const spec = await specsRepository.createSpecRecord({ projectId: project.id, featureId: api ? apiFeature.id : feature.id, title, description: "", path: `specs/${sourceHashOf(title).slice(0, 8)}`, sourceHash: sourceHashOf(source), markdownHash: markdownHashOf(yaml) });
        await fs.mkdir(path.join(project.checkout, spec.path), { recursive: true });
        await fs.writeFile(path.join(project.checkout, spec.path, "spec.ts"), source);
        await fs.writeFile(path.join(project.checkout, spec.path, "spec.yml"), yaml);
        return spec;
    };
    const checkout = await addSpec("Checkout page", "/checkout");
    const settings = await addSpec("Settings page", "/settings");
    const api = await addSpec("Admin can manage accounts", "/api/users/42", true);
    const invalid = await specsRepository.createSpecRecord({ projectId: project.id, featureId: feature.id, title: "Checkout broken", description: "", path: "specs/broken", sourceHash: "bad", markdownHash: "bad", status: "invalid" });
    const context = { ...EMPTY_PROJECT_CONTEXT, areas: [
        { name: "checkout", description: "Purchase flow", routes: ["/checkout", "/checkout/shipping"] },
        { name: "Settings", description: "Preferences", routes: ["/settings"] },
        { name: "Accounts", description: "API users", routes: ["/api/users/{id}"] },
        { name: "Reports", description: "Usage report", routes: ["/reports"] },
        { name: "Api", description: "Public API", routes: [] },
    ] };
    const contextDraft = await projectContextsRepository.createProjectContextDraft(project.id, { goal: "Explore", startUrl: "https://app.example.com", safetyNotes: [] });
    await projectContextsRepository.replaceProjectContextDraft(contextDraft.id, context);
    assert.equal((await projectCoverage(project.id)).confirmed, false);
    assert.deepEqual((await projectCoverage(project.id)).areas, [], "unconfirmed discovery cannot claim coverage");
    await projectContextsRepository.confirmProjectContextRevision(contextDraft.id);
    const result = await projectCoverage(project.id);
    assert.equal(result.confirmed, true);
    assert.deepEqual(result.areas.map((area) => area.coverage), ["partial", "covered", "covered", "uncovered", "covered"]);
    assert.deepEqual(result.areas[0]?.specs.map((spec) => spec.id), [checkout.id, settings.id, invalid.id], "an area holds every Spec of the feature with its title");
    assert.deepEqual(result.areas[0]?.uncoveredRoutes, ["/checkout/shipping"]);
    assert.equal(result.areas[0]?.featureId, feature.id);
    assert.deepEqual(result.areas[1]?.specs.map((spec) => spec.id), [settings.id], "a tested route places a Spec of another feature in the area");
    assert.equal(result.areas[1]?.featureId, null);
    assert.deepEqual(result.areas[2]?.specs.map((spec) => spec.id), [api.id], "literal API requests cover parameterized routes");
    const app = new Hono().route("/", createCoverageRouter());
    assert.equal((await app.request("/projects/00000000-0000-4000-8000-000000000000/coverage")).status, 404);
    assert.equal((await app.request(`/projects/${project.id}/coverage`)).status, 200);
    await project.git.add(["-A"]);
    await project.git.commit("specs");
    await createAreaFeatures(project.id, context);
    assert.deepEqual((await featuresRepository.listFeatures(project.id)).map((item) => item.title).sort(), ["API", "Accounts", "Checkout", "Reports", "Settings"], "areas reuse features with the same title in any case");
    await fs.rm(path.join(project.checkout, api.path, "spec.ts"));
    await fs.symlink("/etc/passwd", path.join(project.checkout, api.path, "spec.ts"));
    const unsafe = await projectCoverage(project.id);
    assert.equal(unsafe.areas[2]?.coverage, "uncovered", "coverage reads refuse repository symlinks");
    assert.equal(unsafe.areas[4]?.reason, "Specs need repairing");
});
