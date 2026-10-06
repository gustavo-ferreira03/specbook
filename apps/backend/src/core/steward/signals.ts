import crypto from "node:crypto";
import { credentialsRepository } from "../../infra/repositories/credentials";
import type { Project } from "../../infra/repositories/projects";
import { specsRepository } from "../../infra/repositories/specs";
import { stewardRepository, type Intent, type ProjectSignal } from "../../infra/repositories/steward";
import type { RunBatchTrigger } from "../runner/batch";

export interface ProjectObservation {
    specs?: Record<string, string>;
    specGenerations?: Record<string, number>;
    credentials?: string;
    deployment?: { baseUrl: string; fingerprint: string | null; nextCheckAt: number; failures: number; generation?: number };
}
export const fingerprint = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function runSignalForIntent(intent: Intent | undefined, intents: Intent[], signals: ProjectSignal[]): ProjectSignal | undefined {
    const visited = new Set<string>();
    while (intent && !visited.has(intent.id)) {
        visited.add(intent.id);
        const signal = signals.find((signal) => intent?.key === `signal:${signal.id}`);
        if (signal) return signal;
        const parentId = /^resume-run:([^:]+):/.exec(intent.key)?.[1];
        intent = parentId ? intents.find((row) => row.id === parentId) : undefined;
    }
    return undefined;
}

export function runTriggerForIntent(intent: Intent | undefined, intents: Intent[], signals: ProjectSignal[]): RunBatchTrigger {
    const signal = runSignalForIntent(intent, intents, signals);
    if (signal?.kind === "deployment" || signal?.kind === "deployment_changed") return "deploy";
    if (signal?.kind === "spec_changed") return "spec_change";
    if (signal?.kind === "schedule") return "schedule";
    return "manual";
}

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
    const observation: ProjectObservation = { deployment: previous.deployment };
    const [specs, credentials] = await Promise.all([
        specsRepository.listSpecs(project.id).then((specs) => specs.filter((spec) => spec.lifecycle === "active")), credentialsRepository.listProfiles(project.id),
    ]);
    const signal = (kind: string, key: string, title: string, body: string, payload: Record<string, unknown> = {}) =>
        stewardRepository.signal({ projectId: project.id, kind, key, title, body, payload });
    const hashes: Record<string, string> = {};
    const generations: Record<string, number> = {};
    for (const spec of specs) {
        const hash = fingerprint([spec.sourceHash, spec.markdownHash, spec.invalidReason]);
        hashes[spec.id] = hash;
        const changed = previous.specs !== undefined && previous.specs[spec.id] !== hash;
        const generation = (previous.specGenerations?.[spec.id] ?? 0) + (changed ? 1 : 0);
        generations[spec.id] = generation;
        // A Spec that cannot run is something to repair. The key is tied to this exact version, so each broken
        // version is handled once, and a repair that changes the files yields a new signal only if it is still broken.
        if (spec.status === "invalid" && spec.lifecycle !== "draft") {
            await signal("invalid_spec", `invalid:${spec.id}:${hash}`, `“${spec.title}” cannot run`, spec.invalidReason ?? "The Spec files could not be read.", { specIds: [spec.id], sourceHash: spec.sourceHash, markdownHash: spec.markdownHash });
        }
        if (spec.status !== "invalid" && changed) {
            await signal("spec_changed", `changed:${spec.id}:${generation}:${fingerprint([previous.specs?.[spec.id] ?? null, hash])}`, `“${spec.title}” changed`, "Verify the changed implementation against the app.", { specIds: [spec.id], sourceHash: spec.sourceHash, markdownHash: spec.markdownHash, generation });
        }
    }
    observation.specs = hashes;
    observation.specGenerations = generations;
    observation.credentials = fingerprint(credentials.map((profile) => [profile.id, profile.updatedAt]));
    if (credentials.length && previous.credentials !== observation.credentials) await signal("credentials_changed", `credentials:${observation.credentials}`, "Credentials are available", "Resume investigations that asked for access.");
    if (!previous.deployment || previous.deployment.baseUrl !== project.baseUrl || previous.deployment.nextCheckAt <= at) {
        const old = previous.deployment;
        const next = await deploymentFingerprint(project.baseUrl).catch(() => null);
        if (next !== null) {
            const changed = old !== undefined && old.fingerprint !== null && (old.fingerprint !== next || old.baseUrl !== project.baseUrl);
            const generation = (old?.generation ?? 0) + (changed ? 1 : 0);
            observation.deployment = { baseUrl: project.baseUrl, fingerprint: next, nextCheckAt: at + 300_000, failures: 0, generation };
            if (changed) await signal("deployment_changed", `deploy:${generation}:${fingerprint([old?.baseUrl, old?.fingerprint, project.baseUrl, next])}`, "The application changed", "The app's build assets or response fingerprint changed. Run the existing Specs against this deployment.", { baseUrl: project.baseUrl, fingerprint: next, generation });
        } else {
            const failures = (old?.failures ?? 0) + 1;
            const generation = (old?.generation ?? 0) + (failures === 1 ? 1 : 0);
            observation.deployment = { baseUrl: project.baseUrl, fingerprint: old?.fingerprint ?? null, nextCheckAt: at + Math.min(3600_000, 300_000 * 2 ** Math.min(failures - 1, 4)), failures, generation };
        }
    }
    return observation;
}
