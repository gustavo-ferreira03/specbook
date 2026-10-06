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

before(async () => {
    evil = await listen((_request, response) => {
        response.setHeader("content-type", "text/html");
        response.end('<h1>Phishing</h1><label>Password <input type="password"></label>');
    });
    app = await listen((request, response) => {
        response.setHeader("content-type", "text/html");
        if (request.url?.startsWith("/http-error")) {
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
        assert.equal(guardEvidence.video, "evidence/execution.webm");

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
