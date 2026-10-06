#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

function redact(value) {
    for (const token of [process.env.SPECBOOK_CI_TOKEN, process.env.GITHUB_TOKEN, process.env.SPECBOOK_GITLAB_TOKEN, process.env.CI_JOB_TOKEN].filter(Boolean).sort((a, b) => b.length - a.length)) {
        value = value.replaceAll(token, "[REDACTED]");
    }
    return value;
}

function options() {
    const values = { environment: process.env.SPECBOOK_ENVIRONMENT, comment: process.env.SPECBOOK_COMMENT_PROVIDER ?? "none" };
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index++) {
        const [name, inline] = args[index].split(/=(.*)/s);
        if (name === "--help") {
            console.log("Usage: node specbook-ci.mjs [--environment <name>] [--comment github|gitlab|none]\nConfigure SPECBOOK_API_URL, SPECBOOK_PROJECT_ID and SPECBOOK_CI_TOKEN in the CI environment.");
            return null;
        }
        if (!["--environment", "--comment"].includes(name)) throw new Error(`Unknown option: ${name}`);
        const value = inline ?? args[++index];
        if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
        values[name.slice(2)] = value;
    }
    if (!["github", "gitlab", "none"].includes(values.comment)) throw new Error("SPECBOOK_COMMENT_PROVIDER must be github, gitlab or none");
    if (values.environment !== undefined && !values.environment.trim()) throw new Error("Environment name cannot be empty");
    return values;
}

function httpUrl(value, name) {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`${name} must be an HTTP(S) URL without credentials, query or fragment`);
    return url.href.replace(/\/$/, "");
}

function number(value, name) {
    if (!/^[1-9]\d*$/.test(String(value))) throw new Error(`${name} must be a positive integer`);
    return String(value);
}

async function commentContext(provider) {
    if (provider === "none") return null;
    if (provider === "github") {
        let pullRequest = process.env.SPECBOOK_PR_NUMBER;
        if (!pullRequest && process.env.GITHUB_EVENT_PATH) {
            const event = JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
            pullRequest = event.pull_request?.number;
        }
        if (!pullRequest) { console.log("Specbook: no pull request in this job; comment skipped"); return null; }
        const repository = required("GITHUB_REPOSITORY");
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("GITHUB_REPOSITORY must be owner/repository");
        return { provider, api: httpUrl(process.env.GITHUB_API_URL ?? "https://api.github.com", "GITHUB_API_URL"),
            route: `/repos/${repository}/issues/${number(pullRequest, "Pull request number")}/comments`, repository,
            headers: { Authorization: `Bearer ${required("GITHUB_TOKEN")}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } };
    }
    const mergeRequest = process.env.CI_MERGE_REQUEST_IID;
    if (!mergeRequest) { console.log("Specbook: no merge request in this job; note skipped"); return null; }
    if (!process.env.SPECBOOK_GITLAB_TOKEN) throw new Error("GitLab note publishing requires SPECBOOK_GITLAB_TOKEN: a project access token with api scope. CI_JOB_TOKEN cannot create or update merge-request notes.");
    const project = process.env.CI_MERGE_REQUEST_PROJECT_ID || required("CI_PROJECT_ID");
    return { provider, api: httpUrl(required("CI_API_V4_URL"), "CI_API_V4_URL"),
        route: `/projects/${encodeURIComponent(project)}/merge_requests/${number(mergeRequest, "Merge request number")}/notes`,
        headers: { "PRIVATE-TOKEN": required("SPECBOOK_GITLAB_TOKEN") } };
}

async function publishComment(context, api, project, summary) {
    if (!context) return;
    const deadline = Date.now() + 60_000;
    async function request(route, method = "GET", body) {
        if (Date.now() >= deadline) throw new Error("Timed out publishing the Specbook comment");
        const response = await fetch(`${context.api}${route}`, { method, headers: { ...context.headers, "Content-Type": "application/json" },
            ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(Math.min(30_000, Math.max(1, deadline - Date.now()))) });
        if (!response.ok) throw new Error(`${context.provider === "github" ? "GitHub" : "GitLab"} comment API returned HTTP ${response.status}; reports are saved locally`);
        return response.status === 204 ? null : response.json();
    }
    const marker = `<!-- specbook:${crypto.createHash("sha256").update(`${api}/${project}`).digest("hex")} -->`;
    let body = `${marker}\n${redact(summary)}`;
    if (Buffer.byteLength(body, "utf8") > 60_000) body = `${Buffer.from(body).subarray(0, 55_000).toString("utf8").replace(/\uFFFD$/, "")}\n\nSummary truncated. Open the run link above or download specbook-summary.md from the job artifacts for all results.`;
    const author = context.provider === "gitlab" ? number((await request("/user")).id, "GitLab token user ID") : null;
    const matches = [];
    for (let page = 1; ; page++) {
        const comments = await request(`${context.route}?per_page=100&page=${page}`);
        if (!Array.isArray(comments)) throw new Error("Comment API returned an invalid list");
        matches.push(...comments.filter((comment) => typeof comment.body === "string" && comment.body.startsWith(marker)
            && (context.provider === "github" ? comment.user?.login === "github-actions[bot]" : String(comment.author?.id) === author && !comment.system)));
        if (comments.length < 100) break;
        if (page === 100) throw new Error("Too many comments to safely locate the Specbook summary");
    }
    const commentRoute = (comment) => context.provider === "github" ? `/repos/${context.repository}/issues/comments/${number(comment.id, "Comment ID")}` : `${context.route}/${number(comment.id, "Note ID")}`;
    if (matches.length) {
        await request(commentRoute(matches[0]), context.provider === "github" ? "PATCH" : "PUT", { body });
        for (const duplicate of matches.slice(1)) await request(commentRoute(duplicate), "DELETE");
    } else await request(context.route, "POST", { body });
    console.log(`Specbook: ${context.provider === "github" ? "pull request comment" : "merge request note"} ${matches.length ? "updated" : "created"}`);
}

function required(name) {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
}

function flag(name) {
    const value = process.env[name];
    if (value === undefined || value === "false" || value === "0") return false;
    if (value === "true" || value === "1") return true;
    throw new Error(`${name} must be true or false`);
}

async function main() {
    const selected = options();
    if (!selected) return;
    const api = httpUrl(required("SPECBOOK_API_URL"), "SPECBOOK_API_URL");
    const project = required("SPECBOOK_PROJECT_ID");
    const token = required("SPECBOOK_CI_TOKEN");
    const comment = await commentContext(selected.comment);
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const timeout = Math.floor(Number(process.env.SPECBOOK_TIMEOUT_SECONDS ?? 3600) * 1000);
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("SPECBOOK_TIMEOUT_SECONDS must be positive");
    const deadline = Date.now() + timeout;
    async function request(route, options = {}) {
        const safeToRetry = !options.method || options.method === "GET";
        for (let attempt = 0; ; attempt++) {
            if (Date.now() >= deadline) throw new Error("Timed out waiting for Specbook results");
            let retryable = true;
            try {
                const response = await fetch(`${api}${route}`, { ...options, headers, redirect: "error", signal: AbortSignal.timeout(Math.min(35_000, Math.max(1, deadline - Date.now()))) });
                const body = await response.text();
                if (!response.ok) {
                    retryable = response.status >= 500;
                    throw new Error(`Specbook returned HTTP ${response.status}: ${redact(body).slice(0, 1000)}`);
                }
                return new Response(body, { status: response.status, headers: response.headers });
            } catch (error) {
                if (!safeToRetry || !retryable || attempt >= 4 || Date.now() >= deadline) throw error;
                console.log(`Specbook: retrying GET after a connection or server error (${attempt + 1}/4)`);
                await new Promise((resolve) => setTimeout(resolve, Math.min(5000, 500 * 2 ** attempt, deadline - Date.now())));
            }
        }
    }
    const input = {
        ...(selected.environment ? { environment: selected.environment } : {}),
        ...(process.env.SPECBOOK_FEATURE_ID ? { featureId: process.env.SPECBOOK_FEATURE_ID } : {}),
        ...(process.env.SPECBOOK_SPEC_IDS ? { specIds: process.env.SPECBOOK_SPEC_IDS.split(",").map((id) => id.trim()).filter(Boolean) } : {}),
        ...(process.env.SPECBOOK_BASE_URL ? { baseUrl: process.env.SPECBOOK_BASE_URL } : {}),
        ...(process.env.SPECBOOK_COMMIT_SHA ? { commitSha: process.env.SPECBOOK_COMMIT_SHA } : {}),
        ...(process.env.SPECBOOK_REF ? { ref: process.env.SPECBOOK_REF } : {}),
        ...(process.env.SPECBOOK_BUILD_URL ? { buildUrl: process.env.SPECBOOK_BUILD_URL } : {}),
        qualityGate: { failOnFlaky: flag("SPECBOOK_FAIL_ON_FLAKY"), failOnKnownBugs: flag("SPECBOOK_FAIL_ON_KNOWN_BUGS") },
    };
    let result = await (await request(`/ci/projects/${encodeURIComponent(project)}/runs`, { method: "POST", body: JSON.stringify(input) })).json();
    console.log(`Specbook: ${redact(result.url)}`);
    const route = `/ci/runs/${encodeURIComponent(result.batch.id)}`;
    while (!result.complete) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for Specbook results");
        result = await (await request(`${route}?wait=true`)).json();
    }
    let summary = "";
    for (const [format, file] of [["junit", process.env.SPECBOOK_JUNIT_PATH ?? "specbook-junit.xml"], ["markdown", process.env.SPECBOOK_SUMMARY_PATH ?? "specbook-summary.md"]]) {
        const body = redact(await (await request(`${route}?format=${format}`)).text());
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, body, "utf8");
        if (format === "markdown") summary = body;
    }
    console.log(`Specbook: ${result.status}; ${result.qualityGate.failures} failure(s), ${result.qualityGate.flaky} flaky, ${result.qualityGate.knownBugs} known bug(s)`);
    if (!result.qualityGate.passed) process.exitCode = 1;
    await publishComment(comment, api, project, summary);
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(redact(message));
    process.exitCode = 1;
});
