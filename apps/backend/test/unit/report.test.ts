import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { describe, test } from "node:test";
import { createSecretScrubber } from "../../src/core/credentials/scrub";
import { isStepScreenshot, readEvidenceManifest, stepScreenshotContentType, writeRunEvidence } from "@specbook/runtime/evidence";
import { executableSource } from "@specbook/runtime/playwright";
import { parsePlaywrightReport, stripAnsi } from "@specbook/runtime/report";
import { analyzeSpecSource } from "@specbook/runtime/validate";
import { prepareReportSection, renderHtmlReport } from "@specbook/runtime/html-report";
import { decodeReplay, encodeReplay, MAX_REPLAY_BYTES, MAX_REPLAY_RAW_BYTES, packReplayEvents, restoreReplayEvents, REPLAY_FILE, REPLAY_LIMIT_NOTE, type ReplayEvent } from "@specbook/runtime/replay";
import { tempDir, VALID_SPEC } from "../helpers/storage";

function report(suites: unknown[], errors: unknown[] = []): string {
    return JSON.stringify({ config: {}, suites, errors, stats: {} });
}

function fileSuite(file: string, result: Record<string, unknown>, annotations: unknown[] = []): unknown {
    return {
        title: file,
        file,
        specs: [{ title: "T", file, tests: [{ annotations, status: "expected", results: [result] }] }],
    };
}

describe("parsePlaywrightReport", () => {
    test("reads structured failure annotations without classifying error prose", () => {
        const parsed = parsePlaywrightReport(report([
            fileSuite("assertion.spec.ts", { status: "failed", errors: [{ message: "No LLM model; session expired" }], attachments: [] }, [{ type: "specbook-error-code", description: "assertion" }]),
            fileSuite("setup.spec.ts", { status: "failed", errors: [{ message: "Localized setup failure" }], attachments: [] }),
        ]));
        assert.equal(parsed.files.get("assertion")?.errorCode, "assertion");
        assert.equal(parsed.files.get("setup")?.errorCode, "infrastructure");
    });

    test("maps each spec file to its result, keyed by run id", () => {
        const parsed = parsePlaywrightReport(report([
            fileSuite("run-a.spec.ts", {
                status: "passed",
                duration: 1234.4,
                errors: [],
                steps: [{ title: "Open" }],
                attachments: [{ name: "specbook-step-01", path: "/w/test-results/a/step.png", contentType: "image/png" }],
            }),
            fileSuite("run-b.spec.ts", {
                status: "failed",
                duration: 50,
                errors: [{ message: "\u001b[31mError: expect(locator).toHaveText(expected) failed\u001b[39m\n\nExpected: \"Welcome\"" }],
                steps: [{ title: "Open" }, { title: "See the dashboard", error: { message: "x" } }],
                annotations: [{ type: "specbook-failed-step", description: "See the dashboard" }],
                attachments: [{ name: "video", path: "/w/test-results/b/video.webm", contentType: "video/webm" }],
            }),
        ]));
        const a = parsed.files.get("run-a");
        assert.deepEqual(a && { status: a.status, durationMs: a.durationMs, failReason: a.failReason, failedStep: a.failedStep }, {
            status: "passed", durationMs: 1234, failReason: null, failedStep: null,
        });
        assert.equal(a?.attachments[0].name, "specbook-step-01");
        const b = parsed.files.get("run-b");
        assert.equal(b?.status, "failed");
        assert.equal(b?.failedStep, "See the dashboard");
        assert.match(b?.failReason ?? "", /^Error: expect\(locator\)\.toHaveText\(expected\) failed\n\nExpected: "Welcome"$/);
    });

    test("falls back to the failing step and to test-level annotations", () => {
        const fromSteps = parsePlaywrightReport(report([
            fileSuite("x.spec.ts", { status: "timedOut", errors: [], steps: [{ title: "Log in", error: {} }], attachments: [] }),
        ])).files.get("x");
        assert.equal(fromSteps?.status, "failed");
        assert.equal(fromSteps?.failedStep, "Log in");
        assert.equal(fromSteps?.failReason, "The test timed out");
        const fromTest = parsePlaywrightReport(report([
            fileSuite("y.spec.ts", { status: "failed", errors: [{ message: "boom" }], steps: [], attachments: [] }, [
                { type: "specbook-failed-step", description: "Pay" },
            ]),
        ])).files.get("y");
        assert.equal(fromTest?.failedStep, "Pay");
    });

    test("nested suites, skipped tests and load errors", () => {
        const parsed = parsePlaywrightReport(report(
            [{ title: "z.spec.ts", file: "z.spec.ts", specs: [], suites: [fileSuite("z.spec.ts", { status: "skipped", errors: [], attachments: [] })] }],
            [{ message: "\u001b[31mError: No tests found\u001b[39m" }],
        ));
        assert.equal(parsed.files.get("z")?.status, "error");
        assert.deepEqual(parsed.errors, ["Error: No tests found"]);
        assert.throws(() => parsePlaywrightReport("{}"), /no suites/);
        assert.equal(stripAnsi("\u001b[2mdim\u001b[22m"), "dim");
    });
});

describe("run evidence", () => {
    test("deduplicates image attributes and inline CSS while reading historical recordings", async () => {
        const image = `data:image/webp;base64,${"abcd".repeat(20_000)}`;
        const events: ReplayEvent[] = [
            { type: 4, timestamp: 1, data: { width: 1280, height: 720 } },
            { type: 2, timestamp: 2, data: { node: { attributes: { src: image }, childNodes: [
                { attributes: { src: image, style: `background:url("${image}"); color:red` } },
                { textContent: `body{background-image:url(${image})}` },
            ] } } },
        ];
        const packed = packReplayEvents(events);
        assert.ok(packed);
        assert.deepEqual(packed.assets, [image]);
        assert.ok(JSON.stringify(packed).length < JSON.stringify(events).length / 3);
        assert.deepEqual(restoreReplayEvents(packed), events);
        const stored = await encodeReplay(events);
        assert.ok(stored);
        assert.equal(JSON.parse(gunzipSync(stored).toString()).assets.length, 1);
        assert.deepEqual(await decodeReplay(stored), events);
        assert.deepEqual(await decodeReplay(gzipSync(JSON.stringify(events))), events);
    });

    test("rejects malformed references, excessive nesting and expanded asset bombs", async () => {
        const events: ReplayEvent[] = [{ type: 4, timestamp: 1 }, { type: 2, timestamp: 2 }];
        const packed = { version: 1, assets: ["data:image/png;base64,cG5n"], events };
        for (const invalid of [
            { ...packed, version: 2 },
            { ...packed, assets: ["https://example.com/image.png"] },
            { ...packed, events: [...events, { type: 3, timestamp: 3, data: { __specbookReplayAsset: -1 } }] },
            { ...packed, events: [...events, { type: 3, timestamp: 3, data: { __specbookReplayAsset: 1 } }] },
            { ...packed, events: [...events, { type: 3, timestamp: 3, data: { __specbookReplayAsset: 0, extra: "ignored" } }] },
            { ...packed, events: [...events, { type: 3, timestamp: 3, data: { __specbookReplayString: [{ unexpected: 0 }] } }] },
        ]) assert.equal(await decodeReplay(gzipSync(JSON.stringify(invalid))), null);
        let deep: unknown = "leaf";
        for (let index = 0; index < 257; index++) deep = { child: deep };
        assert.equal(restoreReplayEvents([...events, { type: 3, timestamp: 3, data: deep }]), null);
        const bomb = { ...packed, assets: [`data:image/png;base64,${"A".repeat(Math.floor(MAX_REPLAY_RAW_BYTES / 3))}`],
            events: [...events, { type: 3, timestamp: 3, data: Array.from({ length: 4 }, () => ({ __specbookReplayAsset: 0 })) }] };
        assert.equal(await decodeReplay(gzipSync(JSON.stringify(bomb))), null);
        const prototype = JSON.parse('[{"type":4,"timestamp":1},{"type":2,"timestamp":2,"data":{"__proto__":{"polluted":true}}}]');
        const restored = restoreReplayEvents(packReplayEvents(prototype));
        assert.ok(restored);
        assert.deepEqual(restored, prototype);
        assert.equal(Object.getPrototypeOf(restored[1].data), Object.prototype);
        assert.equal(({} as Record<string, unknown>).polluted, undefined);
    });

    test("scrubs sensitive page content in a compressed replay and rejects recordings beyond its limits", async () => {
        const work = tempDir();
        const output = tempDir();
        const pageText = "text the page itself shows";
        const events: ReplayEvent[] = [
            { type: 4, timestamp: 1, data: { width: 1280, height: 720, href: "https://example.com" } },
            { type: 2, timestamp: 2, data: { node: { type: 0, childNodes: [{ type: 3, textContent: pageText }] } } },
        ];
        const data = await encodeReplay(events);
        assert.ok(data);
        const file = path.join(work, "replay.json");
        await fs.writeFile(file, JSON.stringify(events));
        const manifest = await writeRunEvidence(output, "passed", { failedStep: null, attachments: [{ name: "specbook-replay", path: file, contentType: "application/json" }] }, [], createSecretScrubber([pageText, "1"]));
        assert.equal(manifest.replay?.file, REPLAY_FILE);
        const stored = await fs.readFile(path.join(output, REPLAY_FILE));
        assert.equal(manifest.replay?.bytes, stored.length);
        const replay = await decodeReplay(stored);
        assert.ok(replay);
        assert.ok(!JSON.stringify(replay).includes(pageText), "sensitive values are scrubbed from recorded text");
        assert.ok(JSON.stringify(replay).includes("••••"));
        assert.equal(replay[0].timestamp, 1, "scrubbing short secrets preserves numeric event data");
        assert.deepEqual(await readEvidenceManifest(output), manifest);
        for (const invalid of [Buffer.from("not gzip"), gzipSync("{}"), gzipSync("[]"), Buffer.alloc(MAX_REPLAY_BYTES + 1), gzipSync(Buffer.alloc(MAX_REPLAY_RAW_BYTES + 1))]) {
            assert.equal(await decodeReplay(invalid), null);
        }
        await fs.writeFile(file, "[]");
        const rejected = await writeRunEvidence(output, "passed", { failedStep: null, attachments: [{ name: "specbook-replay", path: file, contentType: "application/json" }] }, []);
        assert.equal(rejected.replay, undefined);
        assert.equal(await fs.stat(path.join(output, REPLAY_FILE)).catch(() => null), null);
        const noteFile = path.join(work, "replay-note.txt");
        await fs.writeFile(noteFile, REPLAY_LIMIT_NOTE);
        const omitted = await writeRunEvidence(output, "passed", { failedStep: null, attachments: [{ name: "specbook-replay-unavailable", path: noteFile, contentType: "text/plain" }] }, []);
        assert.equal(omitted.replayUnavailable, REPLAY_LIMIT_NOTE);
    });

    test("embeds one offline player for multiple recordings and keeps old reports free of replay UI", async () => {
        const directory = tempDir();
        await fs.mkdir(path.join(directory, "evidence"));
        const events: ReplayEvent[] = [
            { type: 4, timestamp: 1, data: { width: 1280, height: 720, href: "https://example.com" } },
            { type: 2, timestamp: 2, data: { node: { type: 0, childNodes: [
                { type: 2, tagName: "img", attributes: { src: "https://example.com/image.png", onload: "alert(1)", style: "background:url(https://example.com/bg.png)" } },
                { type: 2, tagName: "img", attributes: { src: "data:image/png;base64,cG5n" } },
                { type: 3, textContent: '@import "https://example.com/font.css"; body{background:url(https://example.com/bg.png)}' },
            ] } } },
            { type: 5, timestamp: 3, data: { tag: "specbook-step", payload: { phase: "start", number: 1, title: "Open", kind: "step", outcome: "running" } } },
        ];
        const compressed = await encodeReplay(events);
        assert.ok(compressed);
        await fs.writeFile(path.join(directory, REPLAY_FILE), compressed);
        await fs.writeFile(path.join(directory, "evidence.json"), JSON.stringify({ steps: [], video: null, failedStep: null, replay: { file: REPLAY_FILE, bytes: compressed.length } }));
        const section = await prepareReportSection({ directory, item: { runId: "a", title: "A", status: "passed", durationMs: 1, failReason: null }, humanSpec: { preconditions: [], steps: ["Open"], expectedResult: "Ready", postconditions: [] } });
        assert.ok(section.replay);
        const offline = restoreReplayEvents(JSON.parse(gunzipSync(Buffer.from(section.replay, "base64")).toString()));
        assert.ok(offline);
        const nodes = (offline[1].data as { node: { childNodes: { attributes: Record<string, unknown>; textContent: string }[] } }).node.childNodes;
        assert.equal(nodes[0].attributes.src, undefined);
        assert.equal(nodes[0].attributes.onload, undefined);
        assert.equal(nodes[0].attributes.style, 'background:url("data:,")');
        assert.equal(nodes[1].attributes.src, "data:image/png;base64,cG5n");
        assert.ok(!nodes[2].textContent.includes("https:"));
        const data = { startedAt: "2026-10-12T00:00:00Z", durationMs: 2, qualityGate: { passed: true, failures: 0 }, sections: [section, { ...section, item: { ...section.item, runId: "b" } }] };
        const html = await renderHtmlReport(data);
        assert.equal((html.match(/class="replay-data"/g) ?? []).length, 2);
        assert.equal((html.match(/id="specbook-replay-bootstrap"/g) ?? []).length, 1);
        assert.ok(html.includes("replay-hit") && html.includes("Replay timeline"));
        const libraries = [...html.matchAll(/<script id="specbook-replay-library" type="application\/octet-stream">([^<]+)<\/script>/g)];
        assert.equal(libraries.length, 1);
        assert.match(gunzipSync(Buffer.from(libraries[0][1], "base64")).toString(), /rrwebPlayer/);
        assert.ok(!html.includes('function(e,t){"object"==typeof exports'));
        assert.match(html, /data-replay-step="1"/);
        assert.match(html, /connect-src 'none'/);
        const waiting = await renderHtmlReport({ ...data, sections: [{ ...section, tone: "failed", item: { ...section.item, status: "failed", failReason: "Error: expect(locator).toHaveCount(expected) failed\nExpected: 2\nReceived: 1\nTimeout: 5000ms" } }] });
        assert.match(waiting, /Waited 5\.0s for 2 elements; saw 1/);
        assert.match(waiting, /data-wait-ms="5000"/);
        const historical = await renderHtmlReport({ ...data, sections: [{ ...section, replay: null }] });
        assert.ok(!historical.includes('class="replay"'));
        assert.ok(!historical.includes('id="specbook-replay-bootstrap"'));
        const capped = await renderHtmlReport({ ...data, sections: [{ ...section, replay: null, replayUnavailable: REPLAY_LIMIT_NOTE }] });
        assert.match(capped, /Replay omitted because it exceeded/);
    });

    test("reports historical execution order by title and normalizes failed step titles", async () => {
        const directory = tempDir();
        await fs.mkdir(path.join(directory, "evidence"));
        for (const number of [1, 2]) await fs.writeFile(path.join(directory, "evidence", `step-0${number}.png`), "png");
        await fs.writeFile(path.join(directory, "evidence.json"), JSON.stringify({
            steps: [{ number: 1, label: "Open the page", file: "evidence/step-01.png" }, { number: 2, label: "The page is shown", file: "evidence/step-02.png" }],
            failedStep: "  THE page   is shown.;", video: null,
        }));
        const section = await prepareReportSection({ directory, item: { runId: "history", title: "History", status: "failed", durationMs: 1, failReason: "Failed" },
            humanSpec: { preconditions: ["An account exists"], steps: ["Open the page"], expectedResult: "The page is shown", postconditions: ["Sign out"] } });
        assert.deepEqual(section.steps.map(({ label, kind, ordinal, state }) => ({ label, kind, ordinal, state })), [
            { label: "Open the page", kind: "step", ordinal: 1, state: "passed" },
            { label: "The page is shown", kind: "expected", ordinal: null, state: "failed" },
        ]);
        await fs.writeFile(path.join(directory, "evidence.json"), JSON.stringify({ steps: [{ number: 1, label: "Historical action", file: "evidence/step-01.png" }], video: null, failedStep: null }));
        const fallback = await prepareReportSection({ directory, item: section.item, humanSpec: { preconditions: ["An account exists"], steps: ["Open the page"], expectedResult: "The page is shown", postconditions: [] } });
        assert.equal(fallback.steps[0].kind, "step");
        assert.equal(fallback.steps[0].ordinal, 1);
        await fs.writeFile(path.join(directory, "evidence.json"), JSON.stringify({ steps: [1, 2, 3, 4].map((number) => ({ number, label: "Check state", file: `evidence/step-0${number}.png` })), video: null, failedStep: null }));
        const duplicates = await prepareReportSection({ directory, item: { ...section.item, status: "passed" },
            humanSpec: { preconditions: ["Check state"], steps: ["Check state"], expectedResult: "Check state", postconditions: ["Check state"] } });
        assert.deepEqual(duplicates.steps.map(({ kind, ordinal }) => [kind, ordinal]), [["precondition", null], ["step", 1], ["expected", null], ["postcondition", null]]);
    });

    test("validates stored manifests and supports older step entries", async () => {
        const directory = tempDir();
        const file = path.join(directory, "evidence.json");
        const empty = { steps: [], video: null, failedStep: null };
        assert.deepEqual(await readEvidenceManifest(directory), empty);
        await fs.writeFile(file, JSON.stringify({ failedStep: "Open", steps: [{ label: "Open", file: "evidence/step-01.png" }] }));
        assert.deepEqual(await readEvidenceManifest(directory), { steps: [{ number: 1, label: "Open", file: "evidence/step-01.png" }], video: null, failedStep: "Open" });
        for (const invalid of ["{", JSON.stringify({ steps: "invalid" }), JSON.stringify({ diagnostics: [{ kind: "console", message: 123 }] }), JSON.stringify({ steps: [{ number: 1, label: "Open", file: "../private.png" }] })]) {
            await fs.writeFile(file, invalid);
            assert.deepEqual(await readEvidenceManifest(directory), empty);
        }
        for (const valid of ["evidence/step-01.png", "evidence/step-100.png", "evidence/step-01.webp", "evidence/step-100.webp"]) assert.equal(isStepScreenshot(valid), true);
        for (const invalid of ["evidence/step-1.png", "evidence/step-1000.png", "../evidence/step-01.png", "evidence/step-01.png/extra", "evidence/step-1.webp", "evidence/step-01.webp/extra", "evidence/step-01.avif", "evidence/step-01.jpg"]) assert.equal(isStepScreenshot(invalid), false);
        assert.equal(stepScreenshotContentType("evidence/step-01.png"), "image/png");
        assert.equal(stepScreenshotContentType("evidence/step-01.webp"), "image/webp");
    });

    test("copies step screenshots and the failure video and writes evidence.json", async () => {
        const work = tempDir();
        const output = tempDir();
        await fs.writeFile(path.join(work, "step1.webp"), "webp1");
        await fs.writeFile(path.join(work, "step2.png"), "png2");
        await fs.writeFile(path.join(work, "video.webm"), "webm");
        const manifest = await writeRunEvidence(output, "failed", {
            failedStep: "Log in",
            attachments: [
                { name: "specbook-step-02", path: path.join(work, "step2.png"), contentType: "image/png" },
                { name: "specbook-step-01", path: path.join(work, "step1.webp"), contentType: "image/webp" },
                { name: "specbook-step-03", path: path.join(work, "missing.png"), contentType: "image/png" },
                { name: "trace", path: path.join(work, "trace.zip"), contentType: "application/zip" },
                { name: "video", path: path.join(work, "video.webm"), contentType: "video/webm" },
            ],
        }, ["Open", "Log in"]);
        assert.deepEqual(manifest, {
            steps: [
                { number: 1, label: "Open", file: "evidence/step-01.webp" },
                { number: 2, label: "Log in", file: "evidence/step-02.png" },
            ],
            video: "evidence/execution.webm",
            failedStep: "Log in",
        });
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, "evidence.json"), "utf8")), manifest);
        assert.deepEqual(await readEvidenceManifest(output), manifest);
        assert.equal(await fs.readFile(path.join(output, "evidence", "step-02.png"), "utf8"), "png2");
        assert.equal(await fs.readFile(path.join(output, "evidence", "step-01.webp"), "utf8"), "webp1");

        const passed = await writeRunEvidence(tempDir(), "passed", {
            failedStep: null,
            attachments: [{ name: "video", path: path.join(work, "video.webm"), contentType: "video/webm" }],
        }, []);
        assert.equal(passed.video, null, "videos are kept for failures only");
    });

    test("the executable source imports the real module instead of \"specbook\"", () => {
        const analysis = analyzeSpecSource(VALID_SPEC);
        assert.ok(analysis.ok);
        const source = executableSource(VALID_SPEC, analysis.analysis, "/app/dist/specbook-fixtures.mjs");
        assert.match(source, /^import \{ test, expect \} from "\/app\/dist\/specbook-fixtures\.mjs";/);
        assert.equal(source.split("\n").length, VALID_SPEC.split("\n").length, "line numbers stay the same");
    });

    test("retains bounded diagnostics and error context after scrubbing secrets", async () => {
        const work = tempDir();
        const output = tempDir();
        const diagnosticFile = path.join(work, "diagnostics.json");
        const contextFile = path.join(work, "error-context.md");
        const secret = "private-password";
        await fs.writeFile(diagnosticFile, JSON.stringify([{ kind: "console", message: `Login failed for ${secret}` }]));
        await fs.writeFile(contextFile, `- heading "${secret}"\n${"x".repeat(40_000)}`);
        const attachments = [
            { name: "specbook-diagnostics", path: diagnosticFile, contentType: "application/json" },
            { name: "error-context", path: contextFile, contentType: "text/markdown" },
        ];
        const manifest = await writeRunEvidence(output, "failed", { failedStep: "Log in", attachments }, [], createSecretScrubber([secret]));
        assert.deepEqual(manifest.diagnostics, [{ kind: "console", message: "Login failed for ••••" }]);
        assert.equal(manifest.errorContext?.length, 32_000);
        assert.ok(manifest.errorContext?.startsWith('- heading "••••"'));
        assert.ok(!(await fs.readFile(path.join(output, "evidence.json"), "utf8")).includes(secret));

        const passed = await writeRunEvidence(output, "passed", { failedStep: null, attachments }, [], createSecretScrubber([secret]));
        assert.equal(passed.errorContext, undefined);
        assert.equal(passed.diagnostics?.length, 1, "diagnostics also accompany passing runs");
        await fs.writeFile(diagnosticFile, JSON.stringify([{ kind: "console", message: "x".repeat(2001) }]));
        const invalid = await writeRunEvidence(output, "failed", { failedStep: null, attachments }, []);
        assert.equal(invalid.diagnostics, undefined, "malformed or oversized diagnostics are ignored");
    });
});
