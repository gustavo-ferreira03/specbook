import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { writeRunEvidence } from "../../src/core/runner/evidence";
import { executableSource } from "../../src/core/runner/playwright";
import { parsePlaywrightReport, stripAnsi } from "../../src/core/runner/report";
import { analyzeSpecSource } from "../../src/core/runner/validate";
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
    test("copies step screenshots and the failure video and writes evidence.json", async () => {
        const work = tempDir();
        const output = tempDir();
        await fs.writeFile(path.join(work, "step1.png"), "png1");
        await fs.writeFile(path.join(work, "step2.png"), "png2");
        await fs.writeFile(path.join(work, "video.webm"), "webm");
        const manifest = await writeRunEvidence(output, "failed", {
            failedStep: "Log in",
            attachments: [
                { name: "specbook-step-02", path: path.join(work, "step2.png"), contentType: "image/png" },
                { name: "specbook-step-01", path: path.join(work, "step1.png"), contentType: "image/png" },
                { name: "specbook-step-03", path: path.join(work, "missing.png"), contentType: "image/png" },
                { name: "trace", path: path.join(work, "trace.zip"), contentType: "application/zip" },
                { name: "video", path: path.join(work, "video.webm"), contentType: "video/webm" },
            ],
        }, ["Open", "Log in"]);
        assert.deepEqual(manifest, {
            steps: [
                { number: 1, label: "Open", file: "evidence/step-01.png" },
                { number: 2, label: "Log in", file: "evidence/step-02.png" },
            ],
            video: "evidence/execution.webm",
            failedStep: "Log in",
        });
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, "evidence.json"), "utf8")), manifest);
        assert.equal(await fs.readFile(path.join(output, "evidence", "step-02.png"), "utf8"), "png2");

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
});
