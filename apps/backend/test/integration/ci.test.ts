import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { before, describe, test } from "node:test";
import { Hono } from "hono";
import { useTempStorage } from "../helpers/storage";

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
const { getRunBatchDirectory, getRunBatch } = await import("../../src/core/runner/batch");
const { createCiRouter, createCiSettingsRouter } = await import("../../src/infra/web/routes/ci");
const { createEnvironmentsRouter } = await import("../../src/infra/web/routes/environments");
const { buildHostAllowlist, csrfGuard, hostGuard, jsonBodyLimit } = await import("../../src/infra/web/security");

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
    test("public CI links follow the runtime frontend origin", async () => {
        const { project, batch } = await fixture();
        const response = await app.request(`/projects/${project.id}/ci`, { headers: {
            ...browserHeaders, "x-specbook-proxy": "1", "x-forwarded-host": "192.168.0.165:8080", "x-forwarded-proto": "http",
        } });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.batches[0].url, `http://192.168.0.165:8080/p/${project.id}/settings?tab=ci#ci-batch-${batch.id}`);
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
        const client = await app.request(`/ci/projects/${project.id}/client.mjs`, { headers });
        assert.equal(client.status, 200);
        assert.match(await client.text(), /SPECBOOK_CI_TOKEN/);
    });

    test("restricts CI origins and private targets, deduplicates SHA-less deploys and persists token limits", async () => {
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
        const { resolveTarget, isPrivateAddress } = await import("../../src/core/network/targets");
        const { createRunProxy } = await import("../../src/core/network/proxy");
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

    test("the standalone client recovers transient GET failures and never retries a trigger", async () => {
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
                response.end(failTrigger ? "Unavailable" : JSON.stringify({ batch: { id: "batch-id" }, url: "http://example.com/results", complete: false }));
            } else if (request.url?.includes("format=junit")) response.end('<testsuite tests="1" failures="0"/>');
            else if (request.url?.includes("format=markdown")) response.end("## Specbook: passed");
            else {
                polls++;
                if (polls === 1) { response.statusCode = 503; response.end("Restarting"); }
                else if (polls === 2) request.socket.destroy();
                else response.end(JSON.stringify({ complete: true, status: "passed", qualityGate: { passed: true, failures: 0, flaky: 0, knownBugs: 0 } }));
            }
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const directory = path.join(storage, "client-results");
        const runClient = () => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
            const child = spawn(process.execPath, [path.join(backendRoot, "scripts", "specbook-ci.mjs")], {
                env: { ...process.env, SPECBOOK_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, SPECBOOK_PROJECT_ID: "project-id", SPECBOOK_CI_TOKEN: "test-ci-token", SPECBOOK_TIMEOUT_SECONDS: "20",
                    SPECBOOK_JUNIT_PATH: path.join(directory, "junit.xml"), SPECBOOK_SUMMARY_PATH: path.join(directory, "summary.md") },
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
                    response.end(JSON.stringify({ batch: { id: "batch-id" }, url: "https://example.com/results", complete: true, status: passing ? "passed" : "failed", qualityGate: { passed: passing, failures: passing ? 0 : 1, flaky: 0, knownBugs: 0 } }));
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
        const marker = `<!-- specbook:${crypto.createHash("sha256").update(`${api}/specbook/project-id`).digest("hex")} -->`;
        comments.push({ id: 1, body: `${marker}\nHuman comment`, user: { login: "human" } });
        for (let index = 0; index < 100; index++) comments.push({ id: index + 2, body: "Other comment", user: { login: "human" } });
        notes.push({ id: 1, body: `${marker}\nSomeone else's note`, author: { id: 12 }, system: false });
        await fs.writeFile(path.join(directory, "event.json"), JSON.stringify({ pull_request: { number: 42 } }));
        const runClient = (env: Record<string, string> = {}, args: string[] = []) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
            const child = spawn(process.execPath, [path.join(backendRoot, "scripts", "specbook-ci.mjs"), ...args], {
                env: { ...process.env, SPECBOOK_API_URL: `${api}/specbook`, SPECBOOK_PROJECT_ID: "project-id", SPECBOOK_CI_TOKEN: "test-ci-token", SPECBOOK_ENVIRONMENT: "production", SPECBOOK_COMMENT_PROVIDER: "none", SPECBOOK_TIMEOUT_SECONDS: "20",
                    SPECBOOK_JUNIT_PATH: path.join(directory, "junit.xml"), SPECBOOK_SUMMARY_PATH: path.join(directory, "summary.md"), GITHUB_EVENT_PATH: path.join(directory, "event.json"), GITHUB_REPOSITORY: "example/application", GITHUB_API_URL: `${api}/github`, GITHUB_TOKEN: "github-test-token",
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
            assert.match(noContext.output, /no merge request/);
            const beforeFailure = commentPosts;
            failComment = true;
            const failed = await runClient({ SPECBOOK_COMMENT_PROVIDER: "github", SPECBOOK_PROJECT_ID: "other-project" });
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

    test("CI snippets match the guide and include merge-request pipelines without duplicate push jobs", async () => {
        const { ciSnippet } = await import("../../../frontend/src/lib/ci-snippets");
        const { parse } = await import("yaml");
        const { backendRoot } = await import("../../src/core/paths");
        const guide = await fs.readFile(path.resolve(backendRoot, "../../docs/ci.md"), "utf8");
        const examples = [...guide.matchAll(/```(?:yaml|groovy)\n([\s\S]*?)\n```/g)].map((match) => match[1]);
        const providers = ["github", "gitlab", "bitbucket", "circleci", "jenkins"] as const;
        for (const [index, provider] of providers.entries()) {
            const snippet = ciSnippet(provider, "https://specbook.example.com/api", "<project-id>", false, false);
            assert.equal(snippet, examples[index], `${provider} settings and documentation must agree`);
            if (provider !== "jenkins") assert.ok(parse(snippet));
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
