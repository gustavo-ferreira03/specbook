import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { createSecretScrubber } from "../../src/core/credentials/scrub";
import { runPlaywrightSuite, type SuiteSpec } from "@specbook/runtime/playwright";
import { analyzeSpecSource } from "@specbook/runtime/validate";
import { tempDir } from "../helpers/storage";
import { readReplay, REPLAY_FILE, MAX_REPLAY_BYTES } from "@specbook/runtime/replay";
import { captureStepScreenshot } from "@specbook/runtime/specbook/screenshot";

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
        response.end('<h1>Phishing</h1><p>Cross-origin frame private content</p><label>Password <input type="password"></label>');
    });
    app = await listen((request, response) => {
        response.setHeader("content-type", "text/html");
        explorationRequests.push(`${request.method} ${request.url}`);
        if (request.url === "/api/echo") {
            response.setHeader("content-type", "application/json");
            response.setHeader("set-cookie", `session=${SECRET}`);
            let body = "";
            request.on("data", (chunk) => { body += chunk; });
            request.on("end", () => {
                response.end(JSON.stringify({ ok: true, method: request.method, token: request.headers["x-token"], data: body ? JSON.parse(body) : null }));
            });
        } else if (request.url === "/slow-cleanup") {
            setTimeout(() => response.end("Cleaned"), 6000).unref();
        } else if (request.url === "/api/redirect-out") {
            response.writeHead(307, { location: `${origin(evil)}/api/secret-target` });
            response.end();
        } else if (request.url === "/explore") {
            response.end(`<html><head><title>Exploration</title></head><body><h1>Explore</h1>
<img src="/bad-image"><a href="/http-error?token=${SECRET}">Unavailable page</a>
<a href="/delete-account">Account link</a><a href="/%64elete-account">Encoded action</a>
<a href="${origin(evil)}/offsite">External page</a><a href="/redirect-out">Moved page</a>
<a href="/head-unsupported">Old handler</a><input><button></button>
<script>console.error("Broken widget ${SECRET}");fetch("/http-error?password=${SECRET}");</script></body></html>`);
        } else if (request.url === "/policy") {
            response.end(`<h1>Policy</h1><button onclick="fetch('/unsafe-action')">Delete account</button>
<button onclick="document.querySelector('h1').textContent = 'Opened'">Products</button>
<a href="${origin(evil)}/policy-offsite">External</a><a href="/policy-redirect">Moved</a>`);
        } else if (request.url === "/policy-redirect") {
            response.writeHead(302, { location: `${origin(evil)}/policy-redirect-target` });
            response.end();
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
<label>Username <input value="prefilled-public-value"></label>
<label>Password <input id="password" type="password" value="prefilled-private-value"></label>
<button onclick="document.querySelector('h1').textContent = document.getElementById('password').value === '${SECRET}' ? 'Welcome back' : 'Wrong password'">Sign in</button>
<a href="${origin(evil)}/">Partner login</a><iframe src="${origin(evil)}/"></iframe>`);
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
        await page.reload();
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
    test("captures WebP with secret masks across frames and shadow roots, and safely falls back to PNG", { timeout: 30_000 }, async () => {
        const { chromium } = await import("@playwright/test");
        const browser = await chromium.launch({ headless: true });
        try {
            const context = await browser.newContext({ viewport: { width: 600, height: 300 } });
            const page = await context.newPage();
            await page.setContent(`<style>body{margin:0}input,span{position:absolute;left:10px;width:140px;height:30px;box-sizing:border-box}input{border:0;background:white}span{display:block;background:white}</style>
                <input type="password" value="unconfigured-password" style="top:10px">
                <input data-specbook-secret value="marked-secret" style="top:50px">
                <span style="top:90px">${SECRET}</span>
                <div id="shadow" style="position:absolute;left:10px;top:130px"></div>
                <iframe style="position:absolute;left:200px;top:10px;width:160px;height:100px;border:0" srcdoc="<body style='margin:0'><input value='${SECRET}' style='position:absolute;left:10px;top:10px;width:140px;height:30px;border:0;box-sizing:border-box'>"></iframe>`);
            await page.locator("#shadow").evaluate((host, secret) => {
                const root = host.attachShadow({ mode: "open" });
                root.innerHTML = `<input value="${secret}" style="width:140px;height:30px;border:0;box-sizing:border-box">`;
            }, SECRET);
            const directory = tempDir("specbook-screenshot-");
            const capture = async (extension: "webp" | "png") => {
                const result = await captureStepScreenshot(page, path.join(directory, extension), [SECRET]);
                assert.equal(result.contentType, `image/${extension}`);
                assert.ok(result.file.endsWith(`.${extension}`));
                const bytes = await fs.readFile(result.file);
                if (extension === "webp") {
                    assert.equal(bytes.subarray(0, 4).toString(), "RIFF");
                    assert.equal(bytes.subarray(8, 12).toString(), "WEBP");
                }
                const pixels = await page.evaluate(async (source) => {
                    const image = new Image();
                    image.src = source;
                    await image.decode();
                    const canvas = document.createElement("canvas");
                    canvas.width = image.width;
                    canvas.height = image.height;
                    const context = canvas.getContext("2d")!;
                    context.drawImage(image, 0, 0);
                    return { width: image.width, height: image.height,
                        colors: [[50, 25], [50, 65], [50, 105], [50, 145], [250, 35]].map(([x, y]) => [...context.getImageData(x, y, 1, 1).data]) };
                }, `data:${result.contentType};base64,${bytes.toString("base64")}`);
                assert.equal(pixels.width, 600);
                assert.equal(pixels.height, 300);
                for (const color of pixels.colors) assert.ok(color.slice(0, 3).every((channel) => Math.abs(channel - 119) <= 3), JSON.stringify(color));
                assert.equal(await page.locator("[data-specbook-evidence-mask], [popover]").count(), 0);
                assert.equal(await page.locator("input[data-specbook-secret]").inputValue(), "marked-secret");
            };
            await capture("webp");
            const newSession = context.newCDPSession;
            context.newCDPSession = async () => { throw new Error("CDP unavailable"); };
            try { await capture("png"); }
            finally { context.newCDPSession = newSession; }
            const frame = page.mainFrame();
            const evaluateHandle = frame.evaluateHandle;
            const screenshot = page.screenshot;
            let unsafeCaptures = 0;
            frame.evaluateHandle = async () => new Promise<never>(() => {});
            context.newCDPSession = async () => { unsafeCaptures++; throw new Error("Unexpected capture"); };
            page.screenshot = async () => { unsafeCaptures++; throw new Error("Unexpected capture"); };
            try {
                const target = path.join(directory, "unavailable");
                await assert.rejects(captureStepScreenshot(page, target, [SECRET]), /Browser evidence timed out/);
                assert.equal(unsafeCaptures, 0, "unavailable secret mask discovery never falls back to an unmasked capture");
                assert.ok(!existsSync(`${target}.webp`) && !existsSync(`${target}.png`));
            } finally {
                frame.evaluateHandle = evaluateHandle;
                context.newCDPSession = newSession;
                page.screenshot = screenshot;
            }
        } finally { await browser.close(); }
    });

    test("runs a batch with secrets: a passing login and a blocked cross-origin secret", { timeout: 180_000 }, async () => {
        const directory = tempDir();
        const passDir = path.join(directory, "runs", "pass");
        const guardDir = path.join(directory, "runs", "guard");
        const outcome = await runPlaywrightSuite({
            directory: path.join(directory, "batch"),
            baseUrl: `${origin(app)}/`,
            specs: [{ ...suiteSpec("pass", LOGIN, passDir), humanSpec: { preconditions: ["Open the sign-in page"], steps: ["Enter the password"], expectedResult: "See the welcome message", postconditions: [] } }, suiteSpec("guard", PHISHING, guardDir)],
            timeoutMs: 150_000,
            secretEnv: { SPECBOOK_SECRET_SHOPPER_PASSWORD: SECRET },
            secretOrigins: { defaultOrigins: [origin(app)], byRef: { SPECBOOK_SECRET_SHOPPER_PASSWORD: [origin(app)] } },
            scrub: createSecretScrubber([SECRET]),
        });
        assert.equal(outcome.processFailure, null);
        assert.deepEqual(
            { ...outcome.results.get("pass"), durationMs: null },
            { status: "passed", durationMs: null, failReason: null, failedStep: null, errorCode: null },
        );
        const pass = JSON.parse(await fs.readFile(path.join(passDir, "evidence.json"), "utf8"));
        assert.deepEqual(pass.steps.map((step: { label: string }) => step.label), ["Open the sign-in page", "Enter the password", "See the welcome message"]);
        assert.equal(pass.video, null);
        for (const step of pass.steps) {
            assert.ok(existsSync(path.join(passDir, step.file)));
            assert.ok(step.file.endsWith(".webp"));
        }
        assert.equal(pass.replay.file, REPLAY_FILE);
        assert.ok(pass.replay.bytes > 0 && pass.replay.bytes <= MAX_REPLAY_BYTES);
        const events = await readReplay(passDir);
        assert.ok(events);
        assert.ok(events.filter((event) => event.type === 2).length >= 3, "replay survives the first navigation and reload");
        assert.ok(events.every((event, index) => index === 0 || events[index - 1].timestamp <= event.timestamp));
        const recorded = JSON.stringify(events);
        assert.ok(!recorded.includes(SECRET), "DOM text, scripts and input values are scrubbed before replay is stored");
        assert.ok(!recorded.includes("prefilled-public-value") && !recorded.includes("prefilled-private-value"), "initial text and password input values are masked");
        assert.ok(!recorded.includes("Cross-origin frame private content"), "cross-origin iframe contents are excluded");
        assert.ok(recorded.includes("__specbookSecret"), "secret fields are blocked in addition to masking every input");
        const markers = events.filter((event) => event.type === 5).map((event) => event.data as { tag: string; payload: { number: number; kind: string; phase: string; outcome: string } });
        assert.deepEqual(markers.map(({ tag, payload }) => [tag, payload.number, payload.kind, payload.phase, payload.outcome]), [
            ["specbook-step", 1, "precondition", "start", "running"], ["specbook-step", 1, "precondition", "end", "passed"],
            ["specbook-step", 2, "step", "start", "running"], ["specbook-step", 2, "step", "end", "passed"],
            ["specbook-step", 3, "expected", "start", "running"], ["specbook-step", 3, "expected", "end", "passed"],
        ]);

        const guard = outcome.results.get("guard");
        assert.equal(guard?.status, "failed");
        assert.equal(guard?.failedStep, "Type the password on the other origin");
        assert.match(guard?.failReason ?? "", /Refusing to type a secret: the current page origin is not allowed/);
        const guardEvidence = JSON.parse(await fs.readFile(path.join(guardDir, "evidence.json"), "utf8"));
        assert.equal(guardEvidence.failedStep, "Type the password on the other origin");
        assert.equal(guardEvidence.video, null, "secret runs must not record values in failure videos");
        const blockedEvents = await readReplay(guardDir);
        assert.ok(blockedEvents);
        assert.ok(JSON.stringify(blockedEvents).includes('"outcome":"failed"'));
        assert.ok(!JSON.stringify(blockedEvents).includes(SECRET));

        assert.ok(!existsSync(path.join(directory, "batch", "report")));
        assert.ok(!existsSync(path.join(directory, "batch", "work")), "the work directory (traces, test-results) is removed");
        const results = await fs.readFile(path.join(directory, "batch", "results.json"), "utf8");
        assert.ok(!results.includes(SECRET));
    });

    test("a failing Spec reports its step and video", { timeout: 120_000 }, async () => {
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
        const evidence = JSON.parse(await fs.readFile(path.join(directory, "evidence.json"), "utf8"));
        assert.equal(evidence.steps.length, 2);
        assert.equal(evidence.video, "evidence/execution.webm");
        assert.match(evidence.errorContext, /heading "Home"/);
        const events = await readReplay(directory);
        assert.ok(events);
        const ending = events.filter((event) => event.type === 5).at(-1)?.data as { payload: { number: number; outcome: string } };
        assert.deepEqual({ number: ending.payload.number, outcome: ending.payload.outcome }, { number: 2, outcome: "failed" });
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
        const passingEvidence = JSON.parse(await fs.readFile(path.join(passingDirectory, "evidence.json"), "utf8"));
        assert.ok(passingEvidence.diagnostics.some((entry: { message: string }) => entry.message === "Console failure ••••"));
        assert.equal(passingEvidence.errorContext, undefined);
    });
});

describe("Playwright runner (API)", () => {
    test("slow cleanup has a separate budget and leaves a passing result intact", { timeout: 30_000 }, async () => {
        const directory = tempDir();
        const source = 'import { test, expect } from "specbook"; test("Cleanup budget", async ({ page, request, step, cleanup }) => { await cleanup(async () => { await page.goto("/diagnostics"); await request.get("/slow-cleanup"); }); await step("Check the page", async () => { const response = await request.get("/"); await expect(response).toBeOK(); }); });';
        const write = fs.writeFile;
        fs.writeFile = async (file, contents, options) => write(file, String(file).endsWith("playwright.config.mjs") ? String(contents).replace('"timeout": 100000', '"timeout": 3000') : contents, options);
        let outcome;
        try {
            outcome = await runPlaywrightSuite({ directory, baseUrl: origin(app), specs: [suiteSpec("cleanup", source, path.join(directory, "output"))], timeoutMs: 25_000,
                secretEnv: {}, secretOrigins: { defaultOrigins: [], byRef: {} }, scrub: (value) => value });
        } finally { fs.writeFile = write; }
        assert.equal(outcome.processFailure, null);
        assert.equal(outcome.results.get("cleanup")?.status, "passed");
        assert.ok(explorationRequests.includes("GET /slow-cleanup"), "registered cleanup runs after the check");
        const replay = await readReplay(path.join(directory, "output"));
        assert.ok(replay);
        assert.ok(!JSON.stringify(replay).includes("Diagnostics"), "registered cleanup is excluded from replay evidence");
    });

    test("uses no browser page, redacts secret request/response evidence and rejects off-origin redirects", { timeout: 90_000 }, async () => {
        const directory = tempDir("specbook-api-");
        const passDir = path.join(directory, "pass");
        const blockDir = path.join(directory, "blocked");
        const source = `import { test, expect } from "specbook";
test("API echo", async ({ request, step, secret }) => {
    await step("Send a request with a protected token", async () => {
        const response = await request.post("/api/echo", { headers: { "x-token": secret("service", "token") }, data: { email: secret("service", "token"), value: 42 } });
        await expect(response).toBeOK();
        await expect(response.status()).toBe(200);
        await expect(response.headers()["content-type"]).toBe("application/json");
        await expect(await response.json()).toMatchObject({ ok: true, method: "POST", data: { value: 42 } });
    });
});`;
        const blocked = source.replace('"/api/echo"', '"/api/redirect-out"');
        const outcome = await runPlaywrightSuite({
            directory: path.join(directory, "batch"), baseUrl: origin(app),
            specs: [suiteSpec("api-pass", source, passDir), suiteSpec("api-blocked", blocked, blockDir)], timeoutMs: 75_000,
            secretEnv: { SPECBOOK_SECRET_SERVICE_TOKEN: SECRET },
            secretOrigins: { defaultOrigins: [origin(app)], byRef: { SPECBOOK_SECRET_SERVICE_TOKEN: [origin(app)] } },
            scrub: createSecretScrubber([SECRET]),
        });
        assert.equal(outcome.processFailure, null);
        assert.equal(outcome.results.get("api-pass")?.status, "passed");
        assert.equal(outcome.results.get("api-blocked")?.status, "failed");
        assert.match(outcome.results.get("api-blocked")?.failReason ?? "", /API request origin is not allowed/);
        assert.ok(!externalRequests.includes("/api/secret-target"));
        const text = await fs.readFile(path.join(passDir, "evidence.json"), "utf8");
        assert.ok(!text.includes(SECRET));
        const evidence = JSON.parse(text);
        assert.deepEqual(evidence.steps, [], "API-only checks do not create a browser page or blank screenshots");
        assert.equal(evidence.video, null);
        assert.equal(evidence.apiSteps[0].label, "Send a request with a protected token");
        assert.equal(evidence.apiSteps[0].requests[0].method, "POST");
        assert.equal(evidence.apiSteps[0].requests[0].status, 200);
        assert.equal(evidence.apiSteps[0].requests[0].requestHeaders["x-token"], "••••");
        const results = await fs.readFile(path.join(directory, "batch", "results.json"), "utf8");
        assert.ok(!results.includes(SECRET));
    });
});


describe("exploratory page scan", { skip: !available }, () => {
    test("collects actual MCP diagnostics, accessibility and safe links without leaking credentials", { timeout: 60_000 }, async () => {
        const { createRequire } = await import("node:module");
        const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
        const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
        const { chromium } = await import("@playwright/test");
        const { scanPage } = await import("../../src/core/chat/exploration-tools");
        const { minimalChildEnv } = await import("@specbook/runtime/process");
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
        const { minimalChildEnv } = await import("@specbook/runtime/process");
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


describe("agent browser policy (real MCP)", { skip: process.env.SPECBOOK_TEST_VNC !== "1" }, () => {
    test("verifies actual click targets and blocks off-origin documents including redirects", { timeout: 90_000 }, async () => {
        const { launchBrowserMcp, readBrowserSnapshot } = await import("../../src/core/browser/mcp");
        const { startVncStack, stopVncStack } = await import("../../src/core/browser/vnc");
        const { createDiscoveryBrowserPolicy } = await import("../../src/core/chat/discovery-policy");
        const stack = await startVncStack();
        const directory = tempDir("specbook-browser-policy-");
        let mcp: Awaited<ReturnType<typeof launchBrowserMcp>> | undefined;
        try {
            mcp = await launchBrowserMcp({ workDir: directory, display: stack.display, navigationOrigins: [origin(app)] });
            const navigation = await mcp.client.callTool({ name: "browser_navigate", arguments: { url: `${origin(app)}/policy` } });
            assert.ok(!navigation.isError, JSON.stringify(navigation));
            const snapshot = await readBrowserSnapshot(mcp);
            const ref = (name: string) => {
                const target = snapshot.split("\n").find((line) => line.includes(`"${name}"`))?.match(/\[ref=([^\]]+)\]/)?.[1];
                assert.ok(target, snapshot);
                return target;
            };
            const policy = createDiscoveryBrowserPolicy({ brief: { startUrl: origin(app) } } as Parameters<typeof createDiscoveryBrowserPolicy>[0], mcp);
            await assert.rejects(policy.beforeCall!("browser_click", { target: `aria-ref=${ref("Delete account")}`, element: "Products" }), /actual button Delete account/);
            const args = { target: `aria-ref=${ref("Products")}`, element: "Products" };
            await policy.beforeCall!("browser_click", args);
            const click = await mcp.client.callTool({ name: "browser_click", arguments: args });
            assert.ok(!click.isError, JSON.stringify(click));
            assert.match(await readBrowserSnapshot(mcp), /Opened/);
            assert.ok(!explorationRequests.some((entry) => entry.includes("unsafe-action")));

            const blocked = (url: string) => mcp!.navigate(url).catch((error: Error) => assert.match(error.message, /ERR_BLOCKED_BY_CLIENT/));
            await blocked(`${origin(app)}/policy-redirect`);
            await blocked(`${origin(evil)}/policy-offsite`);
            await mcp.navigate(`${origin(app)}/policy`);
            assert.match(await readBrowserSnapshot(mcp), /Policy/);
            assert.ok(!externalRequests.some((url) => url.startsWith("/policy-")), "forbidden documents are never fetched, even through allowed-origin redirects");
        } finally {
            await mcp?.close();
            await stopVncStack(stack.id);
        }
    });
});
