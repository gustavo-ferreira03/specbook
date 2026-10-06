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

    test("publishAfterRewrite force-publishes a rebased checkout", async () => {
        const project = await newProject();
        const base = await repoGit.getHeadSha(project.id);
        const published = await commitInCheckout(project.git, project.checkout, "a.txt", "v1");
        await repoBare.publish(project.id, project.checkout);
        // Simulate the GitHub sync rebase: the published commit is replaced.
        await project.git.raw(["reset", "--hard", base]);
        const rewritten = await commitInCheckout(project.git, project.checkout, "a.txt", "v1 rebased");
        assert.equal((await repoBare.compare(project.id, project.checkout)).relation, "diverged");

        await repoBare.publishAfterRewrite(project.id, project.checkout, published);
        assert.equal(await repoBare.getBareHeadSha(project.id), rewritten);
        assert.equal(await stateError(project.id), null);
    });

    test("publishAfterRewrite refuses to drop commits pushed by a client", async () => {
        const project = await newProject();
        const previousHead = await repoGit.getHeadSha(project.id);
        const pushed = await pushCommit(await cloneBare(project.id), "client.txt", "client");
        await project.git.raw(["reset", "--hard", previousHead]);
        await commitInCheckout(project.git, project.checkout, "rebased.txt", "x");

        await assert.rejects(repoBare.publishAfterRewrite(project.id, project.checkout, previousHead), BareStateError);
        assert.equal(await repoBare.getBareHeadSha(project.id), pushed);
        assert.match((await stateError(project.id)) ?? "", /not part of the GitHub sync/);
    });

    test("publishAfterRewrite behaves like publish without a rewrite", async () => {
        const project = await newProject();
        const previousHead = await repoGit.getHeadSha(project.id);
        const sha = await commitInCheckout(project.git, project.checkout, "a.txt", "a");
        await repoBare.publishAfterRewrite(project.id, project.checkout, previousHead);
        assert.equal(await repoBare.getBareHeadSha(project.id), sha);
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
