import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CodedError, errorCodeOf } from "@specbook/runtime/errors";
import { httpTarget, resolveTarget } from "@specbook/runtime/network/targets";
import { runPlaywrightSuite, type SuiteSpec } from "@specbook/runtime/playwright";
import { analyzeSpecSource, stepTitlesError, type SecretRef } from "@specbook/runtime/validate";
import { parseSpecYaml } from "@specbook/runtime/yaml";
import {
    runnerArtifactPathSchema, runnerClaimResponseSchema, runnerCompleteRequestSchema,
    runnerHeartbeatResponseSchema, type RunnerClaim, type RunnerCompletion,
    RUNNER_CLI_VERSION, RUNNER_PROTOCOL_VERSION,
} from "@specbook/runtime/runner-protocol";
import { listProfiles, resolveRunSecrets, scrub } from "./credentials";
import { ensureChromium } from "./browsers";
import { normalizeServerUrl, redactTokens, rememberToken, RemoteError } from "./remote";
import { remoteFetch } from "./network";

type Lease = NonNullable<RunnerClaim["lease"]>;
export interface RunnerOptions { url: string; token: string; concurrency?: number; once?: boolean; drainAfter?: number; signal?: AbortSignal }
export type RunnerEvent =
    | { event: "connected"; url: string; runner: RunnerClaim["runner"]; concurrency: number }
    | { event: "claimed"; jobId: string; batchId: string; specs: number }
    | { event: "completed"; jobId: string; batchId: string; results: { runId: string; status: string; failReason: string | null }[] }
    | { event: "retrying"; reason: string; retryInMs: number }
    | { event: "stopped"; url: string; completedJobs: number; failedJobs: number };

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, milliseconds);
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
    });
}

async function requiredProfiles(refs: SecretRef[]): Promise<void> {
    const profiles = await listProfiles();
    const missing = new Map<string, Set<string>>();
    for (const ref of refs) {
        if (profiles.find((profile) => profile.name === ref.profile)?.fields.includes(ref.field)) continue;
        if (!missing.has(ref.profile)) missing.set(ref.profile, new Set());
        missing.get(ref.profile)!.add(ref.field);
    }
    if (missing.size) throw new CodedError("credentials", [...missing].map(([profile, fields]) =>
        `Local credential profile "${profile}" is missing required fields: ${[...fields].join(", ")}. Run specbook credentials add ${profile}.`,
    ).join(" "));
}

async function artifacts(directory: string, scrubText: (text: string) => string): Promise<RunnerCompletion["results"][number]["artifacts"]> {
    const files = ["spec.ts", "spec.yml", "evidence.json"];
    for (const file of await fs.readdir(path.join(directory, "evidence")).catch(() => [] as string[])) files.push(`evidence/${file}`);
    const result: RunnerCompletion["results"][number]["artifacts"] = [];
    for (const file of files) {
        if (!runnerArtifactPathSchema.safeParse(file).success) continue;
        const full = path.join(directory, file);
        const stat = await fs.lstat(full).catch(() => null);
        if (!stat?.isFile() || stat.isSymbolicLink()) continue;
        if (stat.size > 32 * 1024 * 1024) throw new CodedError("infrastructure", "Runner evidence file exceeds 32 MB");
        const data = await fs.readFile(full);
        result.push({ path: file, content: /\.(ts|yml|json)$/.test(file) ? Buffer.from(scrubText(data.toString("utf8"))).toString("base64") : data.toString("base64") });
    }
    return result;
}

async function execute(lease: Lease, signal: AbortSignal): Promise<RunnerCompletion> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "specbook-runner-"));
    const started = Date.now();
    const results: RunnerCompletion["results"] = [];
    const selected: SuiteSpec[] = [];
    let processFailure: string | null = null;
    const scrubText = (text: string) => redactTokens(text);
    let safeText = scrubText;
    try {
        // Capture the local scrubber before validation so even preparation failures are safe.
        const secrets = await resolveRunSecrets([], lease.work.baseUrl);
        safeText = (text) => scrubText(secrets.scrub(text));
        for (const spec of lease.work.specs) {
            const outputDir = path.join(directory, spec.runId);
            await fs.mkdir(outputDir, { mode: 0o700 });
            await fs.writeFile(path.join(outputDir, "spec.ts"), safeText(spec.files["spec.ts"]), { mode: 0o600 });
            await fs.writeFile(path.join(outputDir, "spec.yml"), safeText(spec.files["spec.yml"]), { mode: 0o600 });
            const analyzed = analyzeSpecSource(spec.files["spec.ts"]);
            if (!analyzed.ok) throw new CodedError("invalid_spec", `Spec "${spec.title}" is invalid: ${analyzed.error}`);
            const titlesError = stepTitlesError(analyzed.analysis.steps, parseSpecYaml(spec.files["spec.yml"]).humanSpec);
            if (titlesError) throw new CodedError("invalid_spec", `Spec "${spec.title}" is invalid: ${titlesError}`);
            selected.push({ key: spec.runId, source: spec.files["spec.ts"], analysis: analyzed.analysis, outputDir });
        }
        const refs = selected.flatMap((spec) => spec.analysis.secretRefs);
        await requiredProfiles(refs);
        const resolved = await resolveRunSecrets(refs, lease.work.baseUrl);
        const target = httpTarget(lease.work.baseUrl);
        if (!lease.work.networkPolicy.origins.includes(target.origin)) throw new CodedError("environment", "The run base URL is outside the environment's network policy");
        await resolveTarget(target, lease.work.networkPolicy.allowPrivate);
        await ensureChromium(signal);
        signal.throwIfAborted();
        const outcome = await runPlaywrightSuite({
            directory, baseUrl: lease.work.baseUrl, specs: selected, timeoutMs: lease.work.timeoutMs,
            networkPolicy: lease.work.networkPolicy, signal, ...resolved, scrub: safeText,
        });
        processFailure = outcome.processFailure;
        for (const spec of selected) {
            const result = outcome.results.get(spec.key)!;
            results.push({ ...result, runId: spec.key, failReason: result.failReason === null ? null : safeText(result.failReason).slice(0, 2000),
                failedStep: result.failedStep === null ? null : safeText(result.failedStep).slice(0, 500), artifacts: await artifacts(spec.outputDir, safeText) });
        }
    } catch (error) {
        if (signal.aborted) throw signal.reason;
        let reason = error instanceof Error ? error.message : String(error);
        try { reason = redactTokens(await scrub(reason)); } catch { reason = "Could not read local credentials securely; check SPECBOOK_HOME and file permissions"; }
        processFailure = reason.slice(0, 2000);
        results.length = 0;
        for (const spec of lease.work.specs) {
            const outputDir = path.join(directory, spec.runId);
            await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
            await fs.writeFile(path.join(outputDir, "evidence.json"), JSON.stringify({ steps: [], video: null, failedStep: null }), { mode: 0o600 });
            results.push({ runId: spec.runId, status: "error", durationMs: Date.now() - started, failReason: processFailure,
                failedStep: null, errorCode: errorCodeOf(error) ?? "infrastructure", artifacts: await artifacts(outputDir, safeText).catch(() => []) });
        }
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
    return runnerCompleteRequestSchema.parse({ leaseId: lease.leaseId, durationMs: Date.now() - started,
        processFailure: processFailure === null ? null : safeText(processFailure).slice(0, 2000), results });
}

export async function runRunner(options: RunnerOptions, emit: (event: RunnerEvent) => Promise<void>): Promise<void> {
    rememberToken(options.token);
    if (!options.token || /\s/.test(options.token) || options.token.length > 4096) throw new Error("Provide one runner token through SPECBOOK_RUNNER_TOKEN or the hidden prompt");
    const concurrency = options.concurrency ?? 1;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error("Use --concurrency between 1 and 32");
    if (options.once && options.drainAfter !== undefined) throw new Error("Use --once or --drain-after, not both");
    const limit = options.once ? 1 : options.drainAfter;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error("Use a positive integer for --drain-after");
    let api = normalizeServerUrl(options.url);
    const stop = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
    let connected = false;
    let completedJobs = 0;
    let failedJobs = 0;
    let retryNotice = 0;
    const instanceId = randomUUID();
    let startedJobs = 0;
    let claimingJobs = 0;
    const send = async (route: string, body: unknown, requestSignal: AbortSignal, fallback = false): Promise<Response> => {
        const fetchAt = async (url: string) => {
            try {
                return await remoteFetch(`${url}${route}`, { method: "POST", redirect: "error", headers: {
                    Authorization: `Bearer ${options.token}`, "Content-Type": "application/json",
                }, body: JSON.stringify(body), signal: AbortSignal.any([requestSignal, AbortSignal.timeout(35_000)]) });
            } catch {
                if (requestSignal.aborted) throw requestSignal.reason;
                throw new Error("Could not reach Specbook; check the server URL and connection");
            }
        };
        let response = await fetchAt(api);
        if (fallback && !api.endsWith("/api") && (response.status === 404 || response.ok && response.headers.get("content-type")?.includes("text/html"))) {
            await response.body?.cancel();
            response = await fetchAt(`${api}/api`);
            if (response.ok) api = `${api}/api`;
        }
        if (!response.ok) {
            let error: unknown;
            try { error = await response.json(); } catch { /* Proxy errors may not be JSON. */ }
            const parsed = z.object({ error: z.string().max(2000) }).safeParse(error);
            const reason = response.status === 426 && parsed.success ? redactTokens(parsed.data.error)
                : response.status === 401 || response.status === 403 ? "Runner token is invalid or revoked or cannot access this project"
                : response.status === 409 ? "Runner lease is no longer active" : `Specbook returned HTTP ${response.status}`;
            throw new RemoteError(reason, response.status);
        }
        return response;
    };
    const jsonResponse = async <T>(response: Response, schema: z.ZodType<T>): Promise<T> => {
        let parsed: unknown;
        try { parsed = await response.json(); } catch { throw new Error("Specbook returned an invalid runner response"); }
        const result = schema.safeParse(parsed);
        if (!result.success) throw new Error("Specbook returned an unexpected runner response; check that CLI and server versions match");
        return result.data;
    };
    const retry = async (error: unknown, currentSignal: AbortSignal) => {
        if (error instanceof RemoteError && error.status >= 400 && error.status < 500) throw error;
        if (Date.now() - retryNotice >= 5000) {
            retryNotice = Date.now();
            await emit({ event: "retrying", reason: error instanceof Error ? error.message : "Runner request failed", retryInMs: 2000 });
        }
        await delay(2000, currentSignal);
    };
    const work = async (lease: Lease) => {
        const cancelled = new AbortController();
        const heartbeatStop = new AbortController();
        const jobSignal = AbortSignal.any([signal, cancelled.signal]);
        const heartbeatSignal = AbortSignal.any([jobSignal, heartbeatStop.signal]);
        let expires = Date.parse(lease.leaseExpiresAt);
        let heartbeatError: unknown;
        let completed = false;
        const heartbeat = (async () => {
            let wait = lease.heartbeatMs;
            while (!heartbeatSignal.aborted) {
                await delay(Math.min(wait, Math.max(1, expires - Date.now())), heartbeatSignal);
                if (heartbeatSignal.aborted) return;
                try {
                    const response = await jsonResponse(await send(`/runner/jobs/${lease.jobId}/heartbeat`, {
                        leaseId: lease.leaseId, instanceId, version: RUNNER_CLI_VERSION, protocolVersion: RUNNER_PROTOCOL_VERSION, concurrency,
                    }, heartbeatSignal), runnerHeartbeatResponseSchema);
                    expires = Date.parse(response.leaseExpiresAt);
                    wait = lease.heartbeatMs;
                } catch (error) {
                    if (heartbeatSignal.aborted) return;
                    if (error instanceof RemoteError && error.status < 500 || Date.now() >= expires) {
                        heartbeatError = error;
                        cancelled.abort(new Error("Runner lease was lost; the server will re-queue this job"));
                        return;
                    }
                    wait = Math.min(1000, lease.heartbeatMs);
                }
            }
        })();
        try {
            await emit({ event: "claimed", jobId: lease.jobId, batchId: lease.work.batchId, specs: lease.work.specs.length });
            const completion = await execute(lease, jobSignal);
            while (!jobSignal.aborted) {
                try {
                    const response = await send(`/runner/jobs/${lease.jobId}/complete`, completion, jobSignal);
                    await response.body?.cancel();
                    completed = true;
                    completedJobs++;
                    if (completion.results.some((result) => result.status !== "passed")) failedJobs++;
                    await emit({ event: "completed", jobId: lease.jobId, batchId: lease.work.batchId,
                        results: completion.results.map(({ runId, status, failReason }) => ({ runId, status, failReason })) });
                    break;
                } catch (error) { if (jobSignal.aborted) break; await retry(error, jobSignal); }
            }
        } catch (error) {
            if (!jobSignal.aborted) throw error;
        } finally {
            heartbeatStop.abort();
            await heartbeat;
            if (!completed) {
                const response = await send(`/runner/jobs/${lease.jobId}/release`, { leaseId: lease.leaseId }, AbortSignal.timeout(5000)).catch(() => null);
                await response?.body?.cancel();
            }
        }
        if (heartbeatError instanceof RemoteError && [401, 403].includes(heartbeatError.status)) throw heartbeatError;
        if (heartbeatError && !signal.aborted) await emit({ event: "retrying", reason: "Runner lease was lost; waiting for re-queued work", retryInMs: 0 });
    };
    const worker = async () => {
        while (!signal.aborted) {
            if (limit !== undefined && startedJobs >= limit) break;
            // Reserve a slot before polling so concurrent workers cannot exceed the drain limit.
            if (limit !== undefined && startedJobs + claimingJobs >= limit) { await delay(100, signal); continue; }
            claimingJobs++;
            let claimed: RunnerClaim;
            try {
                claimed = await jsonResponse(await send("/runner/claim", {
                    instanceId, version: RUNNER_CLI_VERSION, protocolVersion: RUNNER_PROTOCOL_VERSION, concurrency,
                }, signal, !connected), runnerClaimResponseSchema);
                if (claimed.lease) startedJobs++;
            } catch (error) {
                if (signal.aborted) break;
                await retry(error, signal);
                continue;
            } finally { claimingJobs--; }
            try {
                if (!connected) {
                    connected = true;
                    await emit({ event: "connected", url: api, runner: claimed.runner, concurrency });
                }
                if (signal.aborted) {
                    if (claimed.lease) await send(`/runner/jobs/${claimed.lease.jobId}/release`, { leaseId: claimed.lease.leaseId }, AbortSignal.timeout(5000)).then((response) => response.body?.cancel()).catch(() => undefined);
                    break;
                }
                if (claimed.lease) await work(claimed.lease);
                else await delay(100, signal);
            } catch (error) { if (signal.aborted) break; await retry(error, signal); }
        }
    };
    const workers = Array.from({ length: concurrency }, () => worker().catch((error) => { stop.abort(error); throw error; }));
    const settled = await Promise.allSettled(workers);
    const disconnected = await send("/runner/disconnect", { instanceId }, AbortSignal.timeout(5000)).catch(() => null);
    await disconnected?.body?.cancel();
    const failed = settled.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    await emit({ event: "stopped", url: api, completedJobs, failedJobs });
}
