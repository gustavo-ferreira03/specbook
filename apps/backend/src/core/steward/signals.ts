import crypto from "node:crypto";
import { credentialsRepository } from "../../infra/repositories/credentials";
import { jobsRepository } from "../../infra/repositories/jobs";
import { projectContextsRepository } from "../../infra/repositories/project-contexts";
import type { Project } from "../../infra/repositories/projects";
import { runsRepository } from "../../infra/repositories/runs";
import { specsRepository } from "../../infra/repositories/specs";
import { stewardRepository } from "../../infra/repositories/steward";

export interface ProjectObservation {
    specs?: Record<string, string>;
    context?: string;
    credentials?: string;
    deployment?: { baseUrl: string; fingerprint: string | null; nextCheckAt: number; failures: number };
}
export const fingerprint = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function deploymentFingerprint(url: string): Promise<string> {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { Accept: "text/html" }, redirect: "error" });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
    const reader = response.body?.getReader();
    let html = "";
    if (reader) {
        const decoder = new TextDecoder();
        try {
            while (html.length < 256_000) {
                const part = await reader.read();
                if (part.done) break;
                html += decoder.decode(part.value, { stream: true });
            }
        } finally { await reader.cancel(); }
    }
    const assets = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g)].map((match) => match[1]).sort();
    return fingerprint(assets.length ? assets : response.headers.get("etag") ?? response.headers.get("last-modified") ?? html);
}

export async function collectProjectSignals(project: Project, previous: ProjectObservation, at = Date.now()): Promise<ProjectObservation> {
    const observation = { ...previous };
    const [specs, context, credentials, jobs] = await Promise.all([
        specsRepository.listSpecs(project.id), projectContextsRepository.getLatestConfirmedProjectContext(project.id),
        credentialsRepository.listProfiles(project.id), jobsRepository.list(project.id),
    ]);
    const signal = (kind: string, key: string, title: string, body: string, payload: Record<string, unknown> = {}) =>
        stewardRepository.signal({ projectId: project.id, kind, key, title, body, payload });
    if (!specs.length) await signal("empty_project", "empty_project", "This project has no Specs yet", "Explore the app and propose a first useful behavior check.");
    const hashes: Record<string, string> = {};
    const latest = await runsRepository.latestRuns(specs.map((spec) => spec.id));
    for (const spec of specs) {
        const hash = fingerprint([spec.sourceHash, spec.markdownHash, spec.invalidReason]);
        hashes[spec.id] = hash;
        if (spec.status === "invalid") {
            await signal("invalid_spec", `invalid:${spec.id}:${hash}`, `“${spec.title}” cannot run`, spec.invalidReason ?? "Its implementation needs repair.", { specIds: [spec.id] });
        } else if (previous.specs && previous.specs[spec.id] !== hash) {
            await signal("spec_changed", `changed:${spec.id}:${at}:${hash}`, `“${spec.title}” changed`, "Verify the changed implementation against the app.", { specIds: [spec.id] });
        } else {
            const run = latest.get(spec.id);
            if (!run || at - Date.parse(run.startedAt) > 7 * 86400_000) {
                await signal("stale_spec", `stale:${spec.id}:${run?.id ?? hash}`, `“${spec.title}” needs verification`, "It has not run in the past seven days.", { specIds: [spec.id] });
            }
        }
    }
    observation.specs = hashes;
    observation.context = context ? fingerprint(context.context) : "";
    if (observation.context && observation.context !== previous.context) await signal("context_changed", `context:${observation.context}`, "Project knowledge changed", "Compare the confirmed areas, roles and rules with existing coverage.");
    observation.credentials = fingerprint(credentials.map((profile) => [profile.id, profile.updatedAt]));
    if (credentials.length && previous.credentials !== observation.credentials) await signal("credentials_changed", `credentials:${observation.credentials}`, "Credentials are available", "Resume investigations that asked for access.");
    for (const job of jobs.filter((job) => ["completed", "budget_exceeded", "cancelled"].includes(job.status))) {
        await signal("job_completed", `job:${job.id}:${job.status}`, job.goal, `Investigation ${job.status.replaceAll("_", " ")}.`, { jobId: job.id });
    }
    if (!previous.deployment || previous.deployment.baseUrl !== project.baseUrl || previous.deployment.nextCheckAt <= at) {
        const old = previous.deployment;
        try {
            const next = await deploymentFingerprint(project.baseUrl);
            observation.deployment = { baseUrl: project.baseUrl, fingerprint: next, nextCheckAt: at + 300_000, failures: 0 };
            if (old?.fingerprint && (old.fingerprint !== next || old.baseUrl !== project.baseUrl)) await signal("deployment_changed", `deploy:${at}:${next}`, "The application changed", "The app's build assets or response fingerprint changed. Verify the existing Specs and review coverage.");
        } catch {
            const failures = (old?.failures ?? 0) + 1;
            observation.deployment = { baseUrl: project.baseUrl, fingerprint: old?.fingerprint ?? null, nextCheckAt: at + Math.min(3600_000, 300_000 * 2 ** Math.min(failures - 1, 4)), failures };
            if (failures === 2) await signal("app_unavailable", `unavailable:${at}`, "The application could not be reached", "Two lightweight checks failed. Investigate availability or ask for access.");
        }
    }
    return observation;
}
