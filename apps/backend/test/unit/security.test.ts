import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Hono } from "hono";

process.env.LOG_LEVEL ??= "silent";
const { buildHostAllowlist, csrfGuard, frontendProxyOrigin, hostGuard, htmlReportHeaders, isAllowedHost, isAllowedWebsocketOrigin, jsonBodyLimit, REQUEST_HEADER } = await import(
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
    test("literal addresses support published ports and DNS names must be configured", () => {
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
        assert.ok(isAllowedHost(allowlist, "localhost:5000"));
        assert.ok(isAllowedHost(allowlist, "192.168.0.165:8080"));
        assert.ok(isAllowedHost(allowlist, "[2001:db8::1]:8080"));
        assert.ok(!isAllowedHost(allowlist, "127.0.0.1.attacker.example:8080"));
        assert.ok(!isAllowedHost(allowlist, "127.0.0.1:8080@attacker.example"));
        assert.ok(!isAllowedHost(allowlist, "localhost:8080/path"));
        assert.ok(!isAllowedHost(allowlist, "attacker.example:4000"));
        assert.ok(!isAllowedHost(allowlist, undefined));
    });

    test("* disables the check", () => {
        assert.ok(isAllowedHost(buildHostAllowlist(4000, { SPECBOOK_ALLOWED_HOSTS: "*" }), "anything:1"));
    });
});

describe("same-origin frontend proxy", () => {
    test("VNC requires an Origin matching the validated proxy host or configured frontend", () => {
        const allowlist = buildHostAllowlist(4000, {});
        const origins = new Set(["http://localhost:4001"]);
        const headers = new Headers({ "x-specbook-proxy": "1", "x-forwarded-host": "192.168.0.165:8080", "x-forwarded-proto": "http" });
        assert.equal(frontendProxyOrigin(headers, allowlist), "http://192.168.0.165:8080");
        assert.equal(isAllowedWebsocketOrigin(headers, allowlist, origins), false, "missing Origin is never accepted");
        headers.set("origin", "http://192.168.0.165:8080");
        assert.equal(isAllowedWebsocketOrigin(headers, allowlist, origins), true);
        headers.set("origin", "https://attacker.example");
        assert.equal(isAllowedWebsocketOrigin(headers, allowlist, origins), false);
        headers.set("x-forwarded-host", "attacker.example");
        headers.set("x-forwarded-proto", "https");
        assert.equal(frontendProxyOrigin(headers, allowlist), null, "forwarding cannot add a DNS host to the allowlist");
        headers.delete("x-specbook-proxy");
        headers.set("origin", "http://localhost:4001");
        assert.equal(isAllowedWebsocketOrigin(headers, allowlist, origins), true);
    });
});

describe("security middleware", () => {
    test("runner uploads accept large base64 artifacts and reject invalid characters and padding", async () => {
        const { randomUUID } = await import("node:crypto");
        const { runnerCompleteRequestSchema } = await import("@specbook/runtime/runner-protocol");
        const completion = (content: string) => ({ leaseId: randomUUID(), durationMs: 1, processFailure: null,
            results: [{ runId: randomUUID(), status: "passed", durationMs: 1, failReason: null, failedStep: null,
                artifacts: [{ path: "evidence/replay.json.gz", content }] }] });
        const large = Buffer.alloc(8 * 1024 * 1024 + 1, 123).toString("base64");
        assert.equal(runnerCompleteRequestSchema.safeParse(completion(large)).success, true);
        for (const content of ["", "AAAA", "AA==", "AAA="]) assert.equal(runnerCompleteRequestSchema.safeParse(completion(content)).success, true);
        for (const content of ["A", "AAAA=", "A===", "AA=A", "A A=", "AAA\n", `${large.slice(0, -4)}AA-=`]) {
            assert.equal(runnerCompleteRequestSchema.safeParse(completion(content)).success, false);
        }
    });

    test("replay reports permit their inline scripts while retaining isolated, offline frames", async () => {
        const { createHash } = await import("node:crypto");
        const script = "window.replayReady = true;";
        const headers = htmlReportHeaders(`<script>${script}</script><script type="application/octet-stream">events</script>`);
        const policy = headers["Content-Security-Policy"];
        assert.ok(policy.includes(`script-src 'sha256-${createHash("sha256").update(script).digest("base64")}'`));
        assert.ok(!policy.includes(createHash("sha256").update("events").digest("base64")));
        assert.match(policy, /default-src 'none'/);
        assert.match(policy, /frame-src about: blob:/);
        assert.match(policy, /sandbox allow-scripts/);
        assert.match(policy, /sandbox allow-scripts allow-same-origin/);
        assert.match(policy, /connect-src 'none'/);
        assert.match(htmlReportHeaders("<p>No replay</p>")["Content-Security-Policy"], /script-src 'none'/);
    });

    test("HTTP replay reports can read their sandboxed frame while scripts and network requests stay blocked", { timeout: 15_000 }, async (context) => {
        const { chromium } = await import("@playwright/test");
        const browser = await chromium.launch({ headless: true }).catch(() => null);
        if (!browser) { context.skip("Chromium unavailable"); return; }
        try {
            const page = await browser.newPage();
            const html = `<body><script>
                const frame = document.createElement('iframe');
                frame.setAttribute('sandbox', 'allow-same-origin');
                document.body.appendChild(frame);
                window.replayFrameReadable = !!frame.contentDocument;
                const script = frame.contentDocument.createElement('script');
                script.textContent = 'window.untrustedReplayExecuted = true';
                frame.contentDocument.body.appendChild(script);
                fetch('https://outside.invalid/').catch(() => window.networkBlocked = true);
            </script>`;
            const requests: string[] = [];
            page.on("request", (request) => requests.push(request.url()));
            await page.route("**/*", (route) => route.fulfill({ status: 200, headers: htmlReportHeaders(html),
                body: html + "<script>window.untrustedOuterExecuted = true</script>" }));
            await page.goto("http://127.0.0.1:4894/report");
            await page.waitForFunction(() => (window as unknown as { networkBlocked?: boolean }).networkBlocked);
            const result = await page.evaluate(() => {
                const globals = window as unknown as { replayFrameReadable?: boolean; untrustedOuterExecuted?: boolean };
                const frame = document.querySelector("iframe")!;
                return { frameReadable: globals.replayFrameReadable, outerScript: globals.untrustedOuterExecuted === true,
                    replayScript: (frame.contentWindow as unknown as { untrustedReplayExecuted?: boolean }).untrustedReplayExecuted === true };
            });
            assert.deepEqual(result, { frameReadable: true, outerScript: false, replayScript: false });
            assert.deepEqual(requests, ["http://127.0.0.1:4894/report"]);
        } finally { await browser.close(); }
    });

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

describe("bounded API documentation reads", () => {
    test("pins an allowed address, excludes credentials and rejects redirects, binary data and oversized responses", async () => {
        const http = await import("node:http");
        const { readApiDocumentation } = await import("../../src/core/network/documentation");
        let lookups = 0;
        let visits = 0;
        const server = http.createServer((request, response) => {
            visits++;
            assert.equal(request.headers.cookie, undefined);
            assert.equal(request.headers.authorization, undefined);
            assert.match(request.headers.host ?? "", /^docs\.example\.test:/);
            if (request.url === "/redirect") { response.writeHead(302, { location: "http://127.0.0.1:1/private" }); response.end(); return; }
            if (request.url === "/binary") { response.writeHead(200, { "content-type": "application/octet-stream" }); response.end("binary"); return; }
            if (request.url === "/large") { response.writeHead(200, { "content-type": "text/plain" }); response.end("x".repeat(131_073)); return; }
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ openapi: "3.1.0", paths: { "/health": { get: {} } } }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as import("node:net").AddressInfo).port;
        const origin = `http://docs.example.test:${port}`;
        const options = { origins: [origin], allowPrivate: true, resolver: async () => { lookups++; return [{ address: "127.0.0.1", family: 4 }]; } };
        try {
            const document = await readApiDocumentation(`${origin}/openapi.json`, options);
            assert.equal(lookups, 1);
            assert.equal(document.contentType, "application/json");
            assert.equal(JSON.parse(document.text).openapi, "3.1.0");
            await assert.rejects(() => readApiDocumentation(`${origin}/redirect`, options), /redirects/);
            await assert.rejects(() => readApiDocumentation(`${origin}/binary`, options), /did not return text/);
            await assert.rejects(() => readApiDocumentation(`${origin}/large`, options), /larger than 128 KiB/);
            assert.equal(visits, 4);
            await assert.rejects(() => readApiDocumentation(`${origin}/openapi.json`, { ...options, origins: [] }), /origin is not allowed/);
            await assert.rejects(() => readApiDocumentation(`${origin}/openapi.json`, { ...options, allowPrivate: false }), /Private, loopback/);
            await assert.rejects(() => readApiDocumentation(`http://127.0.0.1:${port}/openapi.json`, { ...options, origins: [`http://127.0.0.1:${port}`], allowPrivate: false }), /Private, loopback/);
            const controller = new AbortController();
            controller.abort();
            await assert.rejects(() => readApiDocumentation(`${origin}/openapi.json`, { ...options, signal: controller.signal }), /abort/i);
            assert.equal(visits, 4);
            assert.equal(lookups, 5, "blocked origins and cancelled requests never resolve; checked addresses are not looked up again by HTTP");
        } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
    });
});
