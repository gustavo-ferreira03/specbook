import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { scrub } from "./credentials";
import { normalizeServerUrl, request, responseJson, RemoteError, scrubTokens, rememberToken } from "./remote";
import { ciCommentContext, publishCiComment, scrubCi } from "./ci-comment";

const ciResultSchema = z.object({
    batch: z.object({ id: z.string(), durationMs: z.number().nullable().optional(), environment: z.object({ name: z.string() }).nullable().optional() }),
    status: z.string(), complete: z.boolean(), url: z.string(),
    qualityGate: z.object({ passed: z.boolean(), failures: z.number(), flaky: z.number(), knownBugs: z.number(), awaitingDeploy: z.number().default(0) }),
    results: z.array(z.object({
        specId: z.string(), runId: z.string(), title: z.string(), status: z.string(),
        failReason: z.string().nullable().optional(), durationMs: z.number().nullable().optional(),
        flaky: z.boolean(), knownBug: z.boolean(), failsGate: z.boolean(), awaitingDeploy: z.boolean().default(false), url: z.string(),
    })),
});
export interface CiOptions {
    url?: string; token?: string; project?: string; environment?: string; baseUrl?: string;
    featureId?: string; specIds?: string; timeout?: string; report?: string; junit?: string; summary?: string;
    commitSha?: string; ref?: string; buildUrl?: string; failOnFlaky?: boolean; failOnKnownBugs?: boolean; comment?: string;
}
const flag = (name: string) => {
    const value = process.env[name];
    if (value === undefined || value === "false" || value === "0") return false;
    if (value === "true" || value === "1") return true;
    throw new Error(`${name} must be true or false`);
};
const required = (value: string | undefined, name: string) => { if (!value) throw new Error(`${name} is required`); return value; };

export async function runCi(options: CiOptions) {
    const token = required(options.token ?? process.env.SPECBOOK_TOKEN, "SPECBOOK_TOKEN or --token");
    rememberToken(token);
    let api = normalizeServerUrl(required(options.url ?? process.env.SPECBOOK_URL, "SPECBOOK_URL or --url"));
    const project = required(options.project ?? process.env.SPECBOOK_PROJECT, "SPECBOOK_PROJECT or --project");
    if (!z.string().uuid().safeParse(project).success) throw new Error("Use the project id for SPECBOOK_PROJECT or --project");
    const timeoutMs = Number(options.timeout ?? process.env.SPECBOOK_TIMEOUT_SECONDS ?? 3600) * 1000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Use a positive timeout in seconds");
    const deadline = Date.now() + timeoutMs;
    const context = await ciCommentContext(options.comment ?? process.env.SPECBOOK_COMMENT_PROVIDER ?? "none");
    const specIds = (options.specIds ?? process.env.SPECBOOK_SPEC_IDS)?.split(",").map((id) => id.trim()).filter(Boolean);
    const featureId = options.featureId ?? process.env.SPECBOOK_FEATURE_ID;
    if (featureId && specIds?.length) throw new Error("Select a feature or Specs, not both");
    if (featureId && !z.string().uuid().safeParse(featureId).success || specIds?.some((id) => !z.string().uuid().safeParse(id).success)) throw new Error("Use remote ids for --feature-id and --spec-ids");
    const baseUrl = options.baseUrl ?? process.env.SPECBOOK_BASE_URL;
    const buildUrl = options.buildUrl ?? process.env.SPECBOOK_BUILD_URL;
    if (baseUrl) normalizeServerUrl(baseUrl);
    if (buildUrl) normalizeServerUrl(buildUrl);
    const input = {
        environment: options.environment ?? process.env.SPECBOOK_ENVIRONMENT,
        ...(featureId ? { featureId } : {}), ...(specIds?.length ? { specIds } : {}),
        baseUrl, commitSha: options.commitSha ?? process.env.SPECBOOK_COMMIT_SHA,
        ref: options.ref ?? process.env.SPECBOOK_REF, buildUrl,
        qualityGate: { failOnFlaky: options.failOnFlaky ?? flag("SPECBOOK_FAIL_ON_FLAKY"), failOnKnownBugs: options.failOnKnownBugs ?? flag("SPECBOOK_FAIL_ON_KNOWN_BUGS") },
    };
    const get = async (route: string, method = "GET", body?: unknown) => {
        for (let attempt = 0; ; attempt++) {
            if (Date.now() >= deadline) throw new Error("Timed out waiting for Specbook results");
            try {
                return await request({ url: api, token }, route, { method, body, timeoutMs: Math.max(1, Math.min(35_000, deadline - Date.now())), frontendFallback: method === "POST" });
            } catch (error) {
                if (method !== "GET" || error instanceof RemoteError && error.status < 500 || attempt >= 4 || Date.now() >= deadline) throw error;
                await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.min(5000, 500 * 2 ** attempt, deadline - Date.now()))));
            }
        }
    };
    const route = `/ci/projects/${encodeURIComponent(project)}/runs`;
    const started = await get(route, "POST", input);
    api = started.url.slice(0, -route.length);
    let result = await responseJson(started, ciResultSchema);
    const resultRoute = `/ci/runs/${encodeURIComponent(result.batch.id)}`;
    while (!result.complete) result = await responseJson(await get(`${resultRoute}?wait=true`), ciResultSchema);
    const files = {
        report: path.resolve(options.report ?? process.env.SPECBOOK_REPORT_PATH ?? "specbook-report.html"),
        junit: path.resolve(options.junit ?? process.env.SPECBOOK_JUNIT_PATH ?? "specbook-junit.xml"),
        summary: path.resolve(options.summary ?? process.env.SPECBOOK_SUMMARY_PATH ?? "specbook-summary.md"),
    };
    if (new Set(Object.values(files)).size !== 3) throw new Error("Report, JUnit and summary paths must be different");
    let summaryText = "";
    for (const [format, file] of [["html", files.report], ["junit", files.junit], ["markdown", files.summary]]) {
        const text = scrubCi(await scrubTokens(await scrub(await (await get(`${resultRoute}?format=${format}`)).text())));
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, text, "utf8");
        if (format === "markdown") summaryText = text;
    }
    await publishCiComment(context, api, project, summaryText);
    return { batchId: result.batch.id, status: result.status, environment: result.batch.environment?.name ?? input.environment ?? null,
        durationMs: result.batch.durationMs ?? null, qualityGate: result.qualityGate, results: result.results, ...files, url: result.url };
}

export type CiResult = Awaited<ReturnType<typeof runCi>>;
