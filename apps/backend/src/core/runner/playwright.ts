import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunStatus } from "../../infra/db/schema";
import { writeRunEvidence } from "./evidence";
import { runNodeCli } from "./process";
import { parsePlaywrightReport, stripAnsi, type SpecFileResult } from "./report";
import { RUNTIME_ENV, type SecretOriginPolicy, type SpecbookRuntime } from "./specbook/guard";
import type { SpecAnalysis } from "./validate";

const require = createRequire(import.meta.url);

/** Per-test timeout inside Playwright; the process timeout of the caller bounds the whole run. */
const TEST_TIMEOUT_MS = 100_000;
const EXPECT_TIMEOUT_MS = 5_000;
const ACTION_TIMEOUT_MS = 15_000;
const NAVIGATION_TIMEOUT_MS = 30_000;

export interface SuiteSpec {
    /** Run id: names the test file (tests/<key>.spec.ts) and the result. */
    key: string;
    /** Validated spec.ts source. */
    source: string;
    analysis: SpecAnalysis;
    /** runs/<runId>: receives evidence/ and evidence.json. */
    outputDir: string;
}

export interface SuiteSpecResult {
    status: Exclude<RunStatus, "running">;
    durationMs: number | null;
    failReason: string | null;
    failedStep: string | null;
}

export interface SuiteOutcome {
    results: Map<string, SuiteSpecResult>;
    /** Set when Playwright itself failed (timeout, crash, no report). */
    processFailure: string | null;
    /** True when <directory>/report/index.html was kept. */
    reportAvailable: boolean;
}

export interface SuiteOptions {
    /** Directory of this execution: work/, report/ and results.json are created here. */
    directory: string;
    baseUrl: string;
    specs: SuiteSpec[];
    timeoutMs: number;
    secretEnv: Record<string, string>;
    secretOrigins: SecretOriginPolicy;
    scrub: (text: string) => string;
}

function playwrightCli(): string {
    return require.resolve("@playwright/test/cli");
}

/**
 * The file that implements the "specbook" module: the bundle next to dist/index.js in
 * production, the TypeScript source when the backend runs from src/ (dev and tests).
 */
export function specbookModulePath(): string {
    const candidates = [
        new URL("./specbook-fixtures.mjs", import.meta.url),
        new URL("./specbook/fixtures.ts", import.meta.url),
    ].map((url) => fileURLToPath(url));
    const found = candidates.find((candidate) => existsSync(candidate));
    if (!found) throw new Error("The specbook test module was not found; run pnpm --filter backend build");
    return found;
}

/** The spec.ts source with its "specbook" import pointing at the real module. */
export function executableSource(source: string, analysis: SpecAnalysis, modulePath: string): string {
    const { start, end } = analysis.importSource;
    return `${source.slice(0, start)}${JSON.stringify(modulePath)}${source.slice(end)}`;
}

function isInside(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function playwrightConfig(options: SuiteOptions, withHtmlReport: boolean): Record<string, unknown> {
    const file = (spec: SuiteSpec) => `${spec.key}.spec.ts`;
    const plain = options.specs.filter((spec) => spec.analysis.secretRefs.length === 0).map(file);
    const secret = options.specs.filter((spec) => spec.analysis.secretRefs.length > 0).map(file);
    const projects = [
        // Traces record typed values and DOM snapshots, so Specs that type secrets never record one.
        plain.length ? { name: "specbook", testMatch: plain, use: { trace: "retain-on-failure" } } : null,
        secret.length ? { name: "specbook-secrets", testMatch: secret, use: { trace: "off" } } : null,
    ].filter(Boolean);
    const reporter: unknown[] = [["line"], ["json", { outputFile: "results.json" }]];
    if (withHtmlReport) reporter.push(["html", { outputFolder: "../report", open: "never" }]);
    return {
        testDir: "tests",
        outputDir: "test-results",
        workers: 1,
        fullyParallel: false,
        retries: 0,
        repeatEach: 1,
        forbidOnly: true,
        maxFailures: 0,
        timeout: TEST_TIMEOUT_MS,
        expect: { timeout: EXPECT_TIMEOUT_MS },
        preserveOutput: "always",
        updateSnapshots: "none",
        captureGitInfo: { commit: false, diff: false },
        reporter,
        use: {
            baseURL: options.baseUrl,
            browserName: "chromium",
            headless: true,
            viewport: { width: 1280, height: 720 },
            video: { mode: "retain-on-failure", size: { width: 1280, height: 720 } },
            screenshot: "off",
            trace: "off",
            actionTimeout: ACTION_TIMEOUT_MS,
            navigationTimeout: NAVIGATION_TIMEOUT_MS,
            acceptDownloads: false,
        },
        projects,
    };
}

async function writeWorkDir(workDir: string, options: SuiteOptions, withHtmlReport: boolean): Promise<void> {
    const modulePath = specbookModulePath();
    await fs.mkdir(path.join(workDir, "tests"), { recursive: true });
    await Promise.all([
        // Pin module format and TypeScript settings so nothing is inherited from parent directories.
        fs.writeFile(path.join(workDir, "package.json"), JSON.stringify({ private: true, type: "module" }), "utf8"),
        fs.writeFile(path.join(workDir, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }), "utf8"),
        fs.writeFile(
            path.join(workDir, "playwright.config.mjs"),
            `export default ${JSON.stringify(playwrightConfig(options, withHtmlReport), null, 2)};\n`,
            "utf8",
        ),
        ...options.specs.map((spec) =>
            fs.writeFile(path.join(workDir, "tests", `${spec.key}.spec.ts`), executableSource(spec.source, spec.analysis, modulePath), "utf8"),
        ),
    ]);
}

function statusOf(result: SpecFileResult): Exclude<RunStatus, "running"> {
    return result.status;
}

/**
 * Runs the given Specs in one Playwright Test invocation (one worker, headless
 * Chromium) and stores each Spec's evidence in its outputDir. Callers hold the spec
 * locks and a run slot. Secrets reach only this child process, through env vars.
 */
export async function runPlaywrightSuite(options: SuiteOptions): Promise<SuiteOutcome> {
    const directory = options.directory;
    const workDir = path.join(directory, "work");
    const reportDir = path.join(directory, "report");
    const usesSecrets = options.specs.some((spec) => spec.analysis.secretRefs.length > 0);
    // The HTML report embeds every Playwright API step, including typed values, in a
    // compressed archive the scrubber cannot read: it is only produced without secrets.
    const withHtmlReport = !usesSecrets;
    await fs.rm(workDir, { recursive: true, force: true });
    await fs.rm(reportDir, { recursive: true, force: true });
    await writeWorkDir(workDir, options, withHtmlReport);

    const runtime: SpecbookRuntime = { baseURL: options.baseUrl, secretOrigins: options.secretOrigins };
    const results = new Map<string, SuiteSpecResult>();
    let processFailure: string | null = null;
    let reportAvailable = false;
    try {
        const processResult = await runNodeCli(playwrightCli(), ["test", "--config", "playwright.config.mjs"], {
            cwd: workDir,
            timeoutMs: options.timeoutMs,
            env: {
                ...options.secretEnv,
                [RUNTIME_ENV]: JSON.stringify(runtime),
                FORCE_COLOR: "0",
                NO_COLOR: "1",
                PLAYWRIGHT_HTML_OPEN: "never",
            },
        });
        const output = stripAnsi(processResult.output).trim();
        const rawReport = await fs.readFile(path.join(workDir, "results.json"), "utf8").catch(() => null);
        const report = rawReport === null ? null : options.scrub(rawReport);
        if (report !== null) await fs.writeFile(path.join(directory, "results.json"), report, "utf8");
        // A secret value that surfaced in the results may also be inside the report.
        if (report !== null && rawReport !== report) await fs.rm(reportDir, { recursive: true, force: true });

        if (processResult.timedOut) processFailure = `Run timed out after ${Math.round(options.timeoutMs / 1000)}s`;
        else if (report === null) processFailure = output || `Playwright exited with code ${processResult.code} without a report`;
        else if (processResult.code !== 0 && processResult.code !== 1) {
            processFailure = output || `Playwright exited with code ${processResult.code}`;
        }

        let parsed: ReturnType<typeof parsePlaywrightReport> | null = null;
        if (report !== null) {
            try {
                parsed = parsePlaywrightReport(report);
            } catch (error) {
                processFailure ??= `Could not read the Playwright report: ${error instanceof Error ? error.message : String(error)}`;
            }
        }
        if (parsed && parsed.errors.length > 0 && !processFailure) {
            const missing = options.specs.some((spec) => !parsed.files.has(spec.key));
            if (missing) processFailure = parsed.errors.join("\n\n");
        }

        for (const spec of options.specs) {
            const fileResult = parsed?.files.get(spec.key) ?? null;
            const safeResult = fileResult
                ? { ...fileResult, attachments: fileResult.attachments.filter((attachment) => isInside(workDir, path.resolve(workDir, attachment.path))) }
                : null;
            const status = safeResult ? statusOf(safeResult) : "error";
            await fs.mkdir(spec.outputDir, { recursive: true });
            await writeRunEvidence(spec.outputDir, status, safeResult, spec.analysis.steps);
            results.set(spec.key, {
                status,
                durationMs: safeResult?.durationMs ?? null,
                failReason: safeResult ? safeResult.failReason : processFailure ?? "Playwright produced no result for this Spec",
                failedStep: safeResult?.failedStep ?? null,
            });
        }
        reportAvailable = withHtmlReport && existsSync(path.join(reportDir, "index.html"));
    } finally {
        // test-results holds traces, error contexts and copies of the attachments.
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
    return { results, processFailure, reportAvailable };
}
