import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runPlaywrightSuite, type SuiteSpec, type SuiteSpecResult } from "@specbook/runtime/playwright";
import { localNetworkPolicy } from "@specbook/runtime/network/targets";
import { serializeSpecYaml } from "@specbook/runtime/yaml";
import { ensureChromium } from "./browsers";
import { loadConfig, listSpecs, safeWorkspacePath } from "./workspace";
import { resolveRunSecrets } from "./credentials";
import { generateReport } from "./report";

export interface LocalRunResult extends SuiteSpecResult {
    path: string;
    title: string;
    feature: string;
    evidencePath: string;
}
export interface LocalRun {
    id: string;
    directory: string;
    startedAt: string;
    baseUrl: string;
    status: "passed" | "failed" | "error";
    durationMs: number;
    results: LocalRunResult[];
    report: string;
}

export async function runLocal(workspace: string, selector?: string, options: { signal?: AbortSignal } = {}): Promise<LocalRun> {
    const config = await loadConfig(workspace);
    const specs = await listSpecs(workspace, selector);
    if (!specs.length) throw new Error("No Specs found; use specbook spec new or specbook create");
    const policy = await localNetworkPolicy(config.baseUrl);
    const secrets = await resolveRunSecrets(specs.flatMap((spec) => spec.analysis.secretRefs), config.baseUrl);
    await ensureChromium();
    options.signal?.throwIfAborted();
    const startedAt = new Date().toISOString();
    const id = `${startedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const directory = await safeWorkspacePath(workspace, `runs/${id}`, true);
    await fs.mkdir(directory, { recursive: true });
    const selected: SuiteSpec[] = [];
    for (const [index, spec] of specs.entries()) {
        const outputDir = await safeWorkspacePath(workspace, `runs/${id}/${spec.path}`, true);
        await fs.mkdir(outputDir, { recursive: true });
        const safeSpec = JSON.parse(secrets.scrub(JSON.stringify({ title: spec.title, description: spec.description, humanSpec: spec.humanSpec })));
        await fs.writeFile(path.join(outputDir, "spec.yml"), serializeSpecYaml(safeSpec));
        await fs.writeFile(path.join(outputDir, "spec.ts"), secrets.scrub(spec.source));
        selected.push({ key: `spec-${index}`, source: spec.source, analysis: spec.analysis, outputDir });
    }
    const outcome = await runPlaywrightSuite({
        directory, baseUrl: config.baseUrl, specs: selected,
        timeoutMs: specs.length * 100_000 + 30_000,
        networkPolicy: policy, signal: options.signal, ...secrets,
    });
    const results = specs.map((spec, index) => ({
        ...outcome.results.get(selected[index].key)!, path: spec.path, title: secrets.scrub(spec.title), feature: secrets.scrub(spec.feature),
        evidencePath: path.join(directory, spec.path),
    }));
    const status = results.every((result) => result.status === "passed") ? "passed" : results.some((result) => result.status === "error") ? "error" : "failed";
    const run: LocalRun = { id, directory, startedAt, baseUrl: config.baseUrl, status, durationMs: Date.now() - Date.parse(startedAt), results, report: path.join(directory, "report.html") };
    await fs.writeFile(path.join(directory, "run.json"), secrets.scrub(JSON.stringify(run, null, 2)) + "\n");
    await generateReport(workspace, id);
    return run;
}
