import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { createSecretScrubber } from "../../src/core/credentials/scrub";
import { runPlaywrightSuite, type SuiteSpec } from "../../src/core/runner/playwright";
import { analyzeSpecSource } from "../../src/core/runner/validate";
import { tempDir } from "../helpers/storage";

/**
 * Runs real Specs through Playwright Test against a tiny local site. Skipped when the
 * Chromium build of @playwright/test is not installed (pnpm --filter backend browser:install).
 */

const SECRET = "correct-horse-battery";

async function chromiumAvailable(): Promise<boolean> {
    try {
        const { chromium } = await import("@playwright/test");
        const browser = await chromium.launch({ headless: true });
        await browser.close();
        return true;
    } catch {
        return false;
    }
}

function listen(handler: http.RequestListener): Promise<http.Server> {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, "127.0.0.1", () => resolve(server));
    });
}

function origin(server: http.Server): string {
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const available = await chromiumAvailable();
let app: http.Server;
let evil: http.Server;
const explorationRequests: string[] = [];
const externalRequests: string[] = [];

before(async () => {
    evil = await listen((request, response) => {
        externalRequests.push(request.url ?? "");
        response.setHeader("content-type", "text/html");
        response.end('<h1>Phishing</h1><label>Password <input type="password"></label>');
    });
    app = await listen((request, response) => {
        response.setHeader("content-type", "text/html");
        explorationRequests.push(`${request.method} ${request.url}`);
        if (request.url === "/explore") {
            response.end(`<html><head><title>Exploration</title></head><body><h1>Explore</h1>
<img src="/bad-image"><a href="/http-error?token=${SECRET}">Unavailable page</a>
<a href="/delete-account">Account link</a><a href="/%64elete-account">Encoded action</a>
<a href="${origin(evil)}/offsite">External page</a><a href="/redirect-out">Moved page</a>
<a href="/head-unsupported">Old handler</a><input><button></button>
<script>console.error("Broken widget ${SECRET}");fetch("/http-error?password=${SECRET}");</script></body></html>`);
        } else if (request.url === "/redirect-out") {
            response.writeHead(302, { location: `${origin(evil)}/redirect-target` });
            response.end();
        } else if (request.url === "/head-unsupported") {
            response.statusCode = request.method === "HEAD" ? 405 : 200;
            response.end();
        } else if (request.url?.startsWith("/http-error")) {
            response.statusCode = 503;
            response.end("Temporarily unavailable");
        } else if (request.url?.startsWith("/network-error")) {
            request.socket.destroy();
        } else if (request.url === "/diagnostics") {
            response.end(`<h1>Diagnostics ${SECRET}</h1><script>
console.error('Console failure ${SECRET}');
fetch('/http-error?token=hidden-token');
fetch('/network-error').catch(() => {});
setTimeout(() => { throw new Error('Page failure ${SECRET}'); }, 0);
</script>`);
        } else if (request.url?.startsWith("/login")) {
            response.end(`<h1>Sign in</h1>
<label>Password <input id="password" type="password"></label>
<button onclick="document.querySelector('h1').textContent = document.getElementById('password').value === '${SECRET}' ? 'Welcome back' : 'Wrong password'">Sign in</button>
<a href="${origin(evil)}/">Partner login</a>`);
        } else {
            response.end("<h1>Home</h1>");
        }
    });
});

after(() => {
    app?.close();
    evil?.close();
});

function suiteSpec(key: string, source: string, outputDir: string): SuiteSpec {
    const analysis = analyzeSpecSource(source);
    assert.ok(analysis.ok, analysis.ok ? "" : analysis.error);
    return { key, source, analysis: analysis.analysis, outputDir };
}

const LOGIN = `import { test, expect } from "specbook";
test("Sign in", async ({ page, step, secret }) => {
    await step("Open the sign-in page", async () => {
        await page.goto("/login");
    });
    await step("Enter the password", async () => {
        await page.getByLabel("Password").fill(secret("shopper", "password"));
        await page.getByRole("button", { name: "Sign in" }).click();
    });
    await step("See the welcome message", async () => {
        await expect(page.getByRole("heading")).toHaveText("Welcome back");
        await expect(page.getByRole("heading")).toMatchAriaSnapshot('- heading "Welcome back"');
    });
});
`;

const PHISHING = `import { test, expect } from "specbook";
test("Leak attempt", async ({ page, step, secret }) => {
    await step("Follow the partner link", async () => {
        await page.goto("/login");
        await page.getByRole("link", { name: "Partner login" }).click();
        await expect(page.getByRole("heading")).toHaveText("Phishing");
    });
    await step("Type the password on the other origin", async () => {
        await page.getByLabel("Password").fill(secret("shopper", "password"));
    });
});
`;

const FAILING = `import { test, expect } from "specbook";
test("Home shows a greeting", async ({ page, step }) => {
    await step("Open the home page", async () => {
        await page.goto("/");
    });
    await step("See the greeting", async () => {
        await expect(page.getByRole("heading")).toHaveText("Hello", { timeout: 1000 });
    });
});
`;

describe("Playwright runner (real browser)", { skip: available ? false : "Chromium for @playwright/test is not installed" }, () => {
    test("runs a batch with secrets: a passing login and a blocked cross-origin secret", { timeout: 180_000 }, async () => {
        const directory = tempDir();
        const passDir = path.join(directory, "runs", "pass");
        const guardDir = path.join(directory, "runs", "guard");
        const outcome = await runPlaywrightSuite({
            directory: path.join(directory, "batch"),
            baseUrl: `${origin(app)}/`,
            specs: [suiteSpec("pass", LOGIN, passDir), suiteSpec("guard", PHISHING, guardDir)],
            timeoutMs: 150_000,
            secretEnv: { SPECBOOK_SECRET_SHOPPER_PASSWORD: SECRET },
            secretOrigins: { defaultOrigins: [origin(app)], byRef: { SPECBOOK_SECRET_SHOPPER_PASSWORD: [origin(app)] } },
            scrub: createSecretScrubber([SECRET]),
        });
        assert.equal(outcome.processFailure, null);
        assert.deepEqual(
            { ...outcome.results.get("pass"), durationMs: null },
            { status: "passed", durationMs: null, failReason: null, failedStep: null },
        );
        const pass = JSON.parse(await fs.readFile(path.join(passDir, "evidence.json"), "utf8"));
        assert.deepEqual(pass.steps.map((step: { label: string }) => step.label), ["Open the sign-in page", "Enter the password", "See the welcome message"]);
        assert.equal(pass.video, null);
        for (const step of pass.steps) assert.ok(existsSync(path.join(passDir, step.file)));

        const guard = outcome.results.get("guard");
        assert.equal(guard?.status, "failed");
        assert.equal(guard?.failedStep, "Type the password on the other origin");
        assert.match(guard?.failReason ?? "", /Refusing to type a secret: the current page origin is not allowed/);
        const guardEvidence = JSON.parse(await fs.readFile(path.join(guardDir, "evidence.json"), "utf8"));
        assert.equal(guardEvidence.failedStep, "Type the password on the other origin");
        assert.equal(guardEvidence.video, null, "secret runs never record failure videos");

        assert.equal(outcome.reportAvailable, false, "no HTML report when a Spec types secrets");
        assert.ok(!existsSync(path.join(directory, "batch", "report")));
        assert.ok(!existsSync(path.join(directory, "batch", "work")), "the work directory (traces, test-results) is removed");
        const results = await fs.readFile(path.join(directory, "batch", "results.json"), "utf8");
        assert.ok(!results.includes(SECRET));
    });

    test("a failing Spec reports its step, video and HTML report", { timeout: 120_000 }, async () => {
        const directory = tempDir();
        const outcome = await runPlaywrightSuite({
            directory,
            baseUrl: origin(app),
            specs: [suiteSpec("fail", FAILING, directory)],
            timeoutMs: 110_000,
            secretEnv: {},
            secretOrigins: { defaultOrigins: [origin(app)], byRef: {} },
            scrub: createSecretScrubber([]),
        });
        assert.equal(outcome.processFailure, null);
        const result = outcome.results.get("fail");
        assert.equal(result?.status, "failed");
        assert.equal(result?.failedStep, "See the greeting");
        assert.match(result?.failReason ?? "", /toHaveText/);
        assert.doesNotMatch(result?.failReason ?? "", /\u001b\[/);
        assert.equal(outcome.reportAvailable, true);
        assert.ok(existsSync(path.join(directory, "report", "index.html")));
        const evidence = JSON.parse(await fs.readFile(path.join(directory, "evidence.json"), "utf8"));
        assert.equal(evidence.steps.length, 2);
        assert.equal(evidence.video, "evidence/execution.webm");
        assert.match(evidence.errorContext, /heading "Home"/);
    });

    test("retains console, page and network failures with scrubbed error context", { timeout: 120_000 }, async () => {
        const directory = tempDir();
        const outcome = await runPlaywrightSuite({
            directory,
            baseUrl: origin(app),
            specs: [suiteSpec("diagnostics", FAILING.replace('page.goto("/")', 'page.goto("/diagnostics")'), directory)],
            timeoutMs: 110_000,
            secretEnv: {},
            secretOrigins: { defaultOrigins: [origin(app)], byRef: {} },
            scrub: createSecretScrubber([SECRET]),
        });
        assert.equal(outcome.processFailure, null);
        assert.equal(outcome.results.get("diagnostics")?.status, "failed");
        const text = await fs.readFile(path.join(directory, "evidence.json"), "utf8");
        assert.ok(!text.includes(SECRET));
        const evidence = JSON.parse(text);
        const diagnostics = evidence.diagnostics as { kind: string; message: string; url?: string; status?: number }[];
        assert.ok(diagnostics.some((entry) => entry.kind === "console" && entry.message === "Console failure ••••"));
        assert.ok(diagnostics.some((entry) => entry.kind === "pageerror" && entry.message === "Page failure ••••"));
        assert.ok(diagnostics.some((entry) => entry.kind === "response" && entry.status === 503 && entry.url?.endsWith("/http-error")));
        assert.ok(diagnostics.some((entry) => entry.kind === "requestfailed" && entry.url?.endsWith("/network-error")));
        assert.match(evidence.errorContext, /heading "Diagnostics ••••"/);
        assert.equal(outcome.reportAvailable, false, "reports that embed unredacted text are removed");
        assert.ok(!existsSync(path.join(directory, "report")));
        assert.ok(!existsSync(path.join(directory, "work")));

        const passingDirectory = tempDir();
        const passingSource = FAILING.replace('page.goto("/")', 'page.goto("/diagnostics")').replace('"Hello"', '/Diagnostics/');
        const passing = await runPlaywrightSuite({
            directory: passingDirectory,
            baseUrl: origin(app),
            specs: [suiteSpec("diagnostics-pass", passingSource, passingDirectory)],
            timeoutMs: 110_000,
            secretEnv: {},
            secretOrigins: { defaultOrigins: [origin(app)], byRef: {} },
            scrub: createSecretScrubber([SECRET]),
        });
        assert.equal(passing.results.get("diagnostics-pass")?.status, "passed");
        assert.equal(passing.reportAvailable, false, "redaction in an attachment alone removes the report too");
        const passingEvidence = JSON.parse(await fs.readFile(path.join(passingDirectory, "evidence.json"), "utf8"));
        assert.ok(passingEvidence.diagnostics.some((entry: { message: string }) => entry.message === "Console failure ••••"));
        assert.equal(passingEvidence.errorContext, undefined);
    });
});


describe("exploratory page scan", { skip: !available }, () => {
    test("collects actual MCP diagnostics, accessibility and safe links without leaking credentials", { timeout: 60_000 }, async () => {
        const { createRequire } = await import("node:module");
        const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
        const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
        const { chromium } = await import("@playwright/test");
        const { scanPage } = await import("../../src/core/chat/exploration-tools");
        const { minimalChildEnv } = await import("../../src/core/runner/process");
        const require = createRequire(import.meta.url);
        const directory = tempDir("specbook-exploration-");
        const configPath = path.join(directory, "mcp.json");
        await fs.writeFile(configPath, JSON.stringify({ browser: { browserName: "chromium", launchOptions: { headless: true, executablePath: chromium.executablePath(), args: ["--no-sandbox"] } } }));
        const cli = path.join(path.dirname(require.resolve("@playwright/mcp/package.json")), "cli.js");
        const client = new Client({ name: "specbook-scan-test", version: "1.0" });
        const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "--config", configPath], cwd: directory, env: minimalChildEnv({ XDG_CACHE_HOME: directory }), stderr: "ignore" });
        await client.connect(transport);
        try {
            const mcp = { client, tools: [], ensureBrowser: async () => {}, navigate: async (url: string) => { await client.callTool({ name: "browser_navigate", arguments: { url } }); }, close: () => client.close() };
            await mcp.navigate(`${origin(app)}/explore`);
            let evidence = "";
            const scanned = JSON.parse(await scanPage({ baseUrl: origin(app), mcp, scrub: async (value) => createSecretScrubber([SECRET])(value), recordEvidence: async (value) => { evidence = value; return "/activity#scan"; } }));
            assert.equal(scanned.evidenceUrl, "/activity#scan");
            assert.ok(!evidence.includes(SECRET));
            assert.ok(scanned.evidence.scan.accessibility.violations.some((violation: { id: string }) => violation.id === "image-alt" || violation.id === "button-name"));
            assert.ok(scanned.evidence.consoleErrors.some((line: string) => line.includes("Broken widget")));
            assert.ok(scanned.evidence.networkFailures.some((line: string) => line.includes("503")));
            const links = scanned.evidence.scan.links as { url: string; status?: number; result: string }[];
            assert.ok(links.some((link) => link.status === 503 && link.result === "broken"));
            assert.ok(links.some((link) => link.result === "redirect_not_followed"));
            assert.ok(links.some((link) => link.result === "head_unsupported"));
            assert.ok(!explorationRequests.some((request) => request.includes("delete-account") || request.includes("%64elete-account")));
            assert.ok(links.every((link) => new URL(link.url).origin === origin(app)));
            assert.ok(!externalRequests.includes("/offsite") && !externalRequests.includes("/redirect-target"), "external links and redirects are not fetched");
            assert.equal(JSON.parse(evidence).scan.url, `${origin(app)}/explore`);
            await mcp.navigate(origin(evil));
            await assert.rejects(() => scanPage({ baseUrl: origin(app), mcp, scrub: async (value) => value }), /project origin/);
        } finally { await client.close(); }
    });
});

describe("browser display ownership", { skip: process.env.SPECBOOK_TEST_VNC !== "1" ? "Set SPECBOOK_TEST_VNC=1 on a host with Xvfb and x11vnc" : false }, () => {
    test("allocates across concurrent backends and cleans only its children after an abrupt exit", { timeout: 30_000 }, async () => {
        const { spawn } = await import("node:child_process");
        const net = await import("node:net");
        const { startVncStack, stopVncStack, getVncSession } = await import("../../src/core/browser/vnc");
        const { minimalChildEnv } = await import("../../src/core/runner/process");
        const stacks: Awaited<ReturnType<typeof startVncStack>>[] = [];
        let owner: ReturnType<typeof spawn> | undefined;
        const listening = (port: number): Promise<boolean> => new Promise((resolve) => {
            const socket = net.createConnection(port, "127.0.0.1");
            const finish = (result: boolean) => { socket.destroy(); resolve(result); };
            socket.once("data", (data) => finish(data.toString().startsWith("RFB ")));
            socket.once("error", () => finish(false));
            socket.setTimeout(1000, () => finish(false));
        });
        try {
            await Promise.all([0, 1].map(async () => { stacks.push(await startVncStack()); }));
            assert.equal(new Set(stacks.map((stack) => stack.display)).size, 2);
            assert.equal(new Set(stacks.map((stack) => stack.port)).size, 2);
            assert.ok((await Promise.all(stacks.map((stack) => listening(stack.port)))).every(Boolean));
            const moduleUrl = new URL("../../src/core/browser/vnc.ts", import.meta.url).href;
            owner = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
                import { startVncStack } from ${JSON.stringify(moduleUrl)};
                console.log(JSON.stringify(await startVncStack()));
            `], { stdio: ["pipe", "pipe", "pipe"], env: minimalChildEnv() });
            const childStack = await new Promise<{ id: string; display: string; port: number }>((resolve, reject) => {
                let output = "";
                let error = "";
                const timer = setTimeout(() => reject(new Error("Browser owner did not start")), 12_000);
                owner!.stdout!.on("data", (chunk: Buffer) => {
                    output += chunk.toString();
                    if (output.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(output.split("\n")[0])); }
                });
                owner!.stderr!.on("data", (chunk: Buffer) => { error += chunk.toString(); });
                owner!.once("error", (cause) => { clearTimeout(timer); reject(cause); });
                owner!.once("exit", () => { clearTimeout(timer); reject(new Error(error || "Browser owner exited before startup")); });
            });
            assert.ok(stacks.every((stack) => stack.display !== childStack.display && stack.port !== childStack.port));
            assert.ok(await listening(childStack.port));
            const lock = `/tmp/.X${childStack.display.slice(1)}-lock`;
            const exit = new Promise<void>((resolve) => owner!.once("exit", () => resolve()));
            owner.kill("SIGKILL");
            await exit;
            for (let attempt = 0; attempt < 60 && await listening(childStack.port); attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
            assert.equal(await listening(childStack.port), false, "the orphaned supervisor stops its own VNC process");
            for (let attempt = 0; attempt < 60 && await fs.stat(lock).catch(() => null); attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
            assert.equal(await fs.stat(lock).catch(() => null), null, "the owned X server exits and removes its lock");
            assert.ok((await Promise.all(stacks.map((stack) => listening(stack.port)))).every(Boolean), "another backend's displays keep running");
            await Promise.all(stacks.map((stack) => stopVncStack(stack.id)));
            assert.ok(stacks.every((stack) => getVncSession(stack.id) === null));
            assert.ok((await Promise.all(stacks.map((stack) => listening(stack.port)))).every((open) => !open), "stop waits until the sockets are closed");
        } finally {
            if (owner?.exitCode === null && owner.signalCode === null) owner.kill("SIGTERM");
            await Promise.all(stacks.map((stack) => stopVncStack(stack.id)));
        }
    });
});
