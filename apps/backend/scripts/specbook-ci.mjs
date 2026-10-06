#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

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
    const api = required("SPECBOOK_API_URL").replace(/\/$/, "");
    const project = required("SPECBOOK_PROJECT_ID");
    const token = required("SPECBOOK_CI_TOKEN");
    const url = new URL(api);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("SPECBOOK_API_URL must be an HTTP(S) URL without credentials");
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
                    throw new Error(`Specbook returned HTTP ${response.status}: ${body.replaceAll(token, "[REDACTED]").slice(0, 1000)}`);
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
        ...(process.env.SPECBOOK_FEATURE_ID ? { featureId: process.env.SPECBOOK_FEATURE_ID } : {}),
        ...(process.env.SPECBOOK_SPEC_IDS ? { specIds: process.env.SPECBOOK_SPEC_IDS.split(",").map((id) => id.trim()).filter(Boolean) } : {}),
        ...(process.env.SPECBOOK_BASE_URL ? { baseUrl: process.env.SPECBOOK_BASE_URL } : {}),
        ...(process.env.SPECBOOK_COMMIT_SHA ? { commitSha: process.env.SPECBOOK_COMMIT_SHA } : {}),
        ...(process.env.SPECBOOK_REF ? { ref: process.env.SPECBOOK_REF } : {}),
        ...(process.env.SPECBOOK_BUILD_URL ? { buildUrl: process.env.SPECBOOK_BUILD_URL } : {}),
        qualityGate: { failOnFlaky: flag("SPECBOOK_FAIL_ON_FLAKY"), failOnKnownBugs: flag("SPECBOOK_FAIL_ON_KNOWN_BUGS") },
    };
    let result = await (await request(`/ci/projects/${encodeURIComponent(project)}/runs`, { method: "POST", body: JSON.stringify(input) })).json();
    console.log(`Specbook: ${result.url}`);
    const route = `/ci/runs/${encodeURIComponent(result.batch.id)}`;
    while (!result.complete) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for Specbook results");
        result = await (await request(`${route}?wait=true`)).json();
    }
    for (const [format, file] of [["junit", process.env.SPECBOOK_JUNIT_PATH ?? "specbook-junit.xml"], ["markdown", process.env.SPECBOOK_SUMMARY_PATH ?? "specbook-summary.md"]]) {
        const body = await (await request(`${route}?format=${format}`)).text();
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, body, "utf8");
    }
    console.log(`Specbook: ${result.status}; ${result.qualityGate.failures} failure(s), ${result.qualityGate.flaky} flaky, ${result.qualityGate.knownBugs} known bug(s)`);
    if (!result.qualityGate.passed) process.exitCode = 1;
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(process.env.SPECBOOK_CI_TOKEN ? message.replaceAll(process.env.SPECBOOK_CI_TOKEN, "[REDACTED]") : message);
    process.exitCode = 1;
});
