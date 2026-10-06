import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Hono } from "hono";

process.env.LOG_LEVEL ??= "silent";
const { buildHostAllowlist, csrfGuard, hostGuard, isAllowedHost, jsonBodyLimit, REQUEST_HEADER } = await import(
    "../../src/infra/web/security"
);

function appWith(env: NodeJS.ProcessEnv = {}, maxBody = 64): Hono {
    const app = new Hono();
    app.use("*", hostGuard(buildHostAllowlist(4000, env)));
    app.use("*", csrfGuard());
    app.use("*", jsonBodyLimit(maxBody));
    app.get("/health", (c) => c.json({ ok: true }));
    app.get("/projects", (c) => c.json({ ok: true }));
    app.post("/projects", async (c) => c.json({ received: (await c.req.text()).length }));
    app.post("/git/p/git-receive-pack", async (c) => c.json({ received: (await c.req.text()).length }));
    return app;
}

function request(path: string, init: RequestInit & { host?: string } = {}): Request {
    const headers = new Headers(init.headers);
    headers.set("host", init.host ?? "localhost:4000");
    return new Request(`http://${init.host ?? "localhost:4000"}${path}`, { ...init, headers });
}

describe("host allowlist", () => {
    test("localhost on the API port and configured origins are allowed", () => {
        const allowlist = buildHostAllowlist(4000, {
            FRONTEND_ORIGIN: "http://specbook.lan:4001",
            SPECBOOK_ALLOWED_HOSTS: "Internal.Example , exact.example:8443",
        });
        assert.ok(isAllowedHost(allowlist, "localhost:4000"));
        assert.ok(isAllowedHost(allowlist, "127.0.0.1:4000"));
        assert.ok(isAllowedHost(allowlist, "[::1]:4000"));
        assert.ok(isAllowedHost(allowlist, "SPECBOOK.LAN:4001"));
        assert.ok(isAllowedHost(allowlist, "internal.example:1234"), "entries without a port match any port");
        assert.ok(isAllowedHost(allowlist, "exact.example:8443"));
        assert.ok(!isAllowedHost(allowlist, "exact.example:9999"));
        assert.ok(!isAllowedHost(allowlist, "localhost:5000"));
        assert.ok(!isAllowedHost(allowlist, "attacker.example:4000"));
        assert.ok(!isAllowedHost(allowlist, undefined));
    });

    test("* disables the check", () => {
        assert.ok(isAllowedHost(buildHostAllowlist(4000, { SPECBOOK_ALLOWED_HOSTS: "*" }), "anything:1"));
    });
});

describe("security middleware", () => {
    test("host guard rejects unknown hosts except for /health and Git HTTP", async () => {
        const app = appWith();
        assert.equal((await app.request(request("/projects"))).status, 200);
        assert.equal((await app.request(request("/projects", { host: "rebind.attacker:4000" }))).status, 421);
        assert.equal((await app.request(request("/health", { host: "rebind.attacker:4000" }))).status, 200);
    });

    test("state-changing requests need the custom header", async () => {
        const app = appWith();
        const missing = await app.request(request("/projects", { method: "POST", body: "{}" }));
        assert.equal(missing.status, 403);
        assert.match((await missing.json()).error, /X-Specbook-Request/);
        const wrong = await app.request(request("/projects", { method: "POST", body: "{}", headers: { [REQUEST_HEADER]: "0" } }));
        assert.equal(wrong.status, 403);
        const ok = await app.request(request("/projects", { method: "POST", body: "{}", headers: { [REQUEST_HEADER]: "1" } }));
        assert.equal(ok.status, 200);
        assert.equal((await app.request(request("/projects", { method: "GET" }))).status, 200);
        const git = await app.request(request("/git/p/git-receive-pack", { method: "POST", body: "x" }));
        assert.equal(git.status, 200, "Git Smart HTTP authenticates with its own token");
    });

    test("JSON bodies above the limit are rejected, Git HTTP is exempt", async () => {
        const app = appWith({}, 64);
        const headers = { [REQUEST_HEADER]: "1", "content-type": "application/json" };
        const small = await app.request(request("/projects", { method: "POST", body: "x".repeat(64), headers }));
        assert.equal(small.status, 200);
        const big = await app.request(request("/projects", { method: "POST", body: "x".repeat(65), headers }));
        assert.equal(big.status, 413);
        const git = await app.request(request("/git/p/git-receive-pack", { method: "POST", body: "x".repeat(1000) }));
        assert.equal(git.status, 200);
    });
});
