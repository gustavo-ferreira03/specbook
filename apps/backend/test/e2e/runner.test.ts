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
import { readReplay, readRecorderSource, REPLAY_FILE, REPLAY_MASK_ATTRIBUTE, MAX_REPLAY_BYTES } from "@specbook/runtime/replay";
import { captureStepScreenshot } from "@specbook/runtime/specbook/screenshot";
import { createReplayImageRecorder } from "@specbook/runtime/specbook/replay-images";

const SECRET = "correct-horse-battery";

function recordedInputValues(events: { data?: unknown }[]): string[] {
    const values: unknown[] = [];
    const collect = (node: { tagName?: string; attributes?: Record<string, unknown>; childNodes?: unknown[] }) => {
        if (["input", "textarea"].includes(String(node.tagName))) values.push(node.attributes?.value);
        for (const child of node.childNodes ?? []) collect(child as typeof node);
    };
    for (const event of events) {
        const data = event.data as { node?: object; source?: number; text?: unknown; adds?: { node: object }[]; attributes?: { attributes: Record<string, unknown> }[] } | undefined;
        if (data?.node) collect(data.node);
        for (const add of data?.adds ?? []) collect(add.node);
        for (const change of data?.attributes ?? []) values.push(change.attributes.value);
        if (data?.source === 5) values.push(data.text);
    }
    return values.filter((value): value is string => typeof value === "string");
}

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
    test("inlines replay images at rendered resolution and refreshes loaded, revealed and resized images", { timeout: 30_000 }, async () => {
        const { chromium } = await import("@playwright/test");
        const browser = await chromium.launch({ headless: true });
        try {
            const context = await browser.newContext({ deviceScaleFactor: 3 });
            const page = await context.newPage();
            await page.setContent(`<img id="small" style="width:50px;height:25px"><img id="hidden" style="display:none;width:70px;height:35px">
                <img id="contained" style="width:80px;height:80px;object-fit:contain"><img id="large" style="width:800px;height:400px">
                <img id="filled" style="width:100px;height:100px">
                <img id="auto" style="width:53.1px;height:auto"><img id="max" style="max-width:71px;height:auto"><img id="natural">
                <img id="late" style="width:30px;height:15px"><div class="__specbookSecret"><img id="blocked" style="width:20px;height:10px"></div>`);
            await page.evaluate(async () => {
                const canvas = document.createElement("canvas");
                canvas.width = 400;
                canvas.height = 200;
                const context = canvas.getContext("2d")!;
                context.fillStyle = "#4466aa";
                context.fillRect(0, 0, 400, 200);
                const source = canvas.toDataURL();
                await Promise.all([...document.images].filter((image) => image.id !== "late").map(async (image) => { image.src = source; await image.decode(); }));
            });
            await page.addScriptTag({ content: await readRecorderSource() });
            const result = await page.evaluate(async (factory) => {
                const events: { type: number; timestamp: number; data: { node?: { tagName?: string; id: number; attributes?: Record<string, string>; childNodes?: unknown[] }; attributes?: { id: number; attributes: Record<string, string> }[] } }[] = [];
                const target = globalThis as unknown as { rrweb: {
                    record: ((options: unknown) => () => void) & { mirror: unknown };
                    Replayer: new (events: unknown[], options: unknown) => { pause: (time: number) => void; getMirror: () => { getNode: (id: number) => Node }; destroy: () => void };
                } };
                const prototypes = [HTMLCanvasElement.prototype.toDataURL, CanvasRenderingContext2D.prototype.drawImage];
                const images = (0, eval)(`(${factory})`)((event: never) => events.push(event), target.rrweb.record.mirror);
                const stop = target.rrweb.record({ emit(event: never) { events.push(images.process(event)); }, inlineImages: true,
                    dataURLOptions: { type: "image/webp", quality: 0.8 }, blockClass: "__specbookSecret", recordCanvas: false });
                const initial: Record<string, { size: number[] | null; id: number }> = {};
                const before: Record<string, number[]> = {};
                const inspect = {
                    async dimensions(source: string): Promise<number[]> {
                        const image = new Image();
                        image.src = source;
                        await image.decode();
                        return [image.naturalWidth, image.naturalHeight];
                    },
                    async visit(node: { tagName?: string; id: number; attributes?: Record<string, string>; childNodes?: unknown[] }): Promise<void> {
                        if (node.tagName === "img" && node.attributes?.id) initial[node.attributes.id] = {
                            size: node.attributes.rr_dataURL ? await inspect.dimensions(node.attributes.rr_dataURL) : null, id: node.id };
                        await Promise.all((node.childNodes ?? []).map((child) => inspect.visit(child as Parameters<typeof inspect.visit>[0])));
                    },
                    box(element: Element): number[] {
                        const rectangle = element.getBoundingClientRect();
                        return [rectangle.width, rectangle.height];
                    },
                };
                await inspect.visit(events.find((event) => event.type === 2)!.data.node!);
                document.querySelectorAll("img[id]").forEach((image) => { before[image.id] = inspect.box(image); });
                const initialEvents = events.slice();
                const source = (document.getElementById("small") as HTMLImageElement).src;
                const small = document.getElementById("small")!;
                small.style.width = "120px";
                small.style.height = "60px";
                document.getElementById("hidden")!.style.display = "inline";
                const late = document.getElementById("late") as HTMLImageElement;
                late.src = source;
                await late.decode();
                await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const updates: Record<string, number[]> = {};
                for (const event of events) {
                    for (const change of event.data.attributes ?? []) {
                        if (!change.attributes.rr_dataURL) continue;
                        const element = (target.rrweb.record.mirror as { getNode: (id: number) => Element | null }).getNode(change.id);
                        if (element?.id) updates[element.id] = await inspect.dimensions(change.attributes.rr_dataURL);
                    }
                }
                images.stop();
                stop();
                const count = events.length;
                small.style.width = "160px";
                await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const root = document.createElement("div");
                root.style.position = "fixed";
                root.style.left = "-10000px";
                document.body.appendChild(root);
                const player = new target.rrweb.Replayer(initialEvents, { root, showWarning: false });
                player.pause(initialEvents[initialEvents.length - 1].timestamp - initialEvents[0].timestamp + 1);
                await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const replayBoxes: Record<string, number[]> = {};
                for (const [name, image] of Object.entries(initial)) {
                    const element = player.getMirror().getNode(image.id) as HTMLImageElement;
                    if (element.src) await element.decode().catch(() => undefined);
                    replayBoxes[name] = inspect.box(element);
                }
                player.destroy();
                const updatedPlayer = new target.rrweb.Replayer(events, { root, showWarning: false });
                updatedPlayer.pause(events[events.length - 1].timestamp - events[0].timestamp + 1);
                await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const updatedSources: Record<string, number[]> = {};
                for (const name of ["small", "hidden", "late"]) {
                    const element = updatedPlayer.getMirror().getNode(initial[name].id) as HTMLImageElement;
                    await element.decode();
                    updatedSources[name] = [element.naturalWidth, element.naturalHeight];
                }
                updatedPlayer.destroy();
                return { initial, updates, originalSize: [(small as HTMLImageElement).naturalWidth, (small as HTMLImageElement).naturalHeight],
                    unchangedPrototypes: prototypes[0] === HTMLCanvasElement.prototype.toDataURL && prototypes[1] === CanvasRenderingContext2D.prototype.drawImage,
                    stopped: count === events.length, before, replayBoxes, updatedSources };
            }, createReplayImageRecorder.toString());
            assert.deepEqual(result.initial.small.size, [100, 50], "DPR is capped at 2x");
            assert.deepEqual(result.initial.contained.size, [160, 80], "object-fit keeps the source aspect ratio");
            assert.deepEqual(result.initial.filled.size, [200, 200], "object-fit fill uses both rendered dimensions");
            assert.deepEqual(result.initial.hidden.size, [400, 200], "hidden images retain their quality until laid out");
            assert.deepEqual(result.initial.large.size, [400, 200], "images are never upscaled");
            assert.equal(result.initial.late.size, null);
            assert.deepEqual(result.updates.small, [240, 120]);
            assert.deepEqual(result.updates.hidden, [140, 70]);
            assert.deepEqual(result.updates.late, [60, 30]);
            assert.deepEqual(result.updatedSources.small, [240, 120], "resize refresh updates the player image source");
            assert.deepEqual(result.updatedSources.hidden, [140, 70]);
            assert.deepEqual(result.updatedSources.late, [60, 30]);
            for (const name of ["small", "contained", "large", "auto", "max", "natural"]) {
                assert.deepEqual(result.replayBoxes[name], result.before[name], `${name}: intrinsic resizing keeps the original layout`);
            }
            assert.ok(!result.updates.blocked, "blocked images are never inlined");
            assert.deepEqual(result.originalSize, [400, 200]);
            assert.ok(result.unchangedPrototypes && result.stopped);
        } finally { await browser.close(); }
    });

    test("captures WebP with input masks across frames and shadow roots, and safely falls back to PNG", { timeout: 30_000 }, async () => {
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
                <input type="password" value="unconfigured-password" style="left:400px;top:10px">
                <input type="password" value="marked-secret" style="left:400px;top:50px">
                <span style="left:400px;top:90px">••••</span>
                <span style="top:170px">standard_user</span>
                <span style="left:400px;top:170px">standard_user</span>
                <input type="password" value="${SECRET}" style="left:400px;top:130px">
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
                    // Mean channel difference from a password field with the same value; WebP is lossy, so identical renders differ slightly.
                    const pairs: Record<string, number[]> = { password: [10, 10, 400, 10], marked: [10, 50, 400, 50], shadow: [10, 130, 400, 130], framed: [210, 20, 400, 130], pageText: [10, 90, 400, 90], publicText: [10, 170, 400, 170] };
                    const differences: Record<string, number> = {};
                    for (const [name, [ax, ay, bx, by]] of Object.entries(pairs)) {
                        const a = context.getImageData(ax, ay, 140, 30).data, b = context.getImageData(bx, by, 140, 30).data;
                        let total = 0;
                        for (let index = 0; index < a.length; index++) total += Math.abs(a[index] - b[index]);
                        differences[name] = total / a.length;
                    }
                    return { width: image.width, height: image.height, differences };
                }, `data:${result.contentType};base64,${bytes.toString("base64")}`);
                assert.equal(pixels.width, 600);
                assert.equal(pixels.height, 300);
                const { pageText, publicText, ...inputs } = pixels.differences;
                for (const [name, value] of Object.entries(inputs)) assert.ok(value < 3, `${name} input renders as password dots (${value})`);
                assert.ok(pageText < 3, "sensitive values in page text are hidden");
                assert.ok(publicText < 3, "non-sensitive page text stays visible");
                assert.equal(await page.locator('span[style="top:90px"]').innerText(), SECRET, "the original page text is restored after capture");
                assert.equal(await page.locator("input[data-specbook-secret]").evaluate((input) => getComputedStyle(input).getPropertyValue("-webkit-text-security")), "none");
                assert.equal(await page.locator("[data-specbook-evidence-style]").count(), 0);
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
        assert.ok(!recorded.includes(SECRET), "sensitive values never reach recorded text or inputs");
        assert.ok(!recordedInputValues(events).some((value) => value.includes(SECRET)), "typed secret values never reach the recording");
        assert.ok(recorded.includes("prefilled-public-value"), "plain input values stay visible, as in screenshots");
        assert.ok(!recorded.includes("prefilled-private-value"), "password inputs are blocked");
        assert.ok(!recorded.includes("Cross-origin frame private content"), "cross-origin iframe contents are excluded");
        assert.ok(recorded.includes(REPLAY_MASK_ATTRIBUTE), "secret and password fields are covered like in screenshots");
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
        assert.ok(!recordedInputValues(blockedEvents).some((value) => value.includes(SECRET)));

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
