import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { localNetworkPolicy } from "@specbook/runtime/network/targets";
import { runPlaywrightSuite } from "@specbook/runtime/playwright";
import type { SuiteSpec, SuiteSpecResult } from "@specbook/runtime/playwright";
import { serializeSpecYaml } from "@specbook/runtime/yaml";

import { ensureChromium } from "./browsers";
import { resolveRunSecrets } from "./credentials";
import { generateReport } from "./report";
import { requiredValue } from "./values";
import { loadConfig, listSpecs, safeWorkspacePath } from "./workspace";

export interface LocalRunResult extends SuiteSpecResult {
  path: string;
  title: string;
  feature: string;
  evidencePath: string;
  hashes?: { specTs: string; specYaml: string };
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

export const runLocal = async function runLocal(
  workspace: string,
  selector?: string,
  options: { signal?: AbortSignal; baseUrl?: string } = {}
): Promise<LocalRun> {
  options.signal?.throwIfAborted();
  const config = await loadConfig(workspace);
  const baseUrl = options.baseUrl ?? config.baseUrl;
  const specs = await listSpecs(workspace, selector);
  if (!specs.length) {
    throw new Error("No Specs found; use specbook spec new or specbook chat");
  }
  const policy = await localNetworkPolicy(baseUrl);
  const secrets = await resolveRunSecrets(
    specs.flatMap((spec) => spec.analysis.secretRefs),
    baseUrl
  );
  await ensureChromium(options.signal);
  options.signal?.throwIfAborted();
  const startedAt = new Date().toISOString();
  const id = `${startedAt.replaceAll(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
  const directory = await safeWorkspacePath(workspace, `runs/${id}`, true);
  await fs.mkdir(directory, { recursive: true });
  const selected: SuiteSpec[] = [];
  for (const [index, spec] of specs.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- Keep dependent retries, browser actions, and state changes in their original order and bound concurrent resource use.
    const outputDir = await safeWorkspacePath(
      workspace,
      `runs/${id}/${spec.path}`,
      true
    );
    // oxlint-disable-next-line no-await-in-loop -- Keep dependent retries, browser actions, and state changes in their original order and bound concurrent resource use.
    await fs.mkdir(outputDir, { recursive: true });
    const safeSpec = JSON.parse(
      secrets.scrub(
        JSON.stringify({
          title: spec.title,
          description: spec.description,
          humanSpec: spec.humanSpec,
        })
      )
    );
    // oxlint-disable-next-line no-await-in-loop -- Keep dependent retries, browser actions, and state changes in their original order and bound concurrent resource use.
    await fs.writeFile(
      path.join(outputDir, "spec.yml"),
      serializeSpecYaml(safeSpec)
    );
    // oxlint-disable-next-line no-await-in-loop -- Keep dependent retries, browser actions, and state changes in their original order and bound concurrent resource use.
    await fs.writeFile(
      path.join(outputDir, "spec.ts"),
      secrets.scrub(spec.source)
    );
    selected.push({
      key: `spec-${index}`,
      source: spec.source,
      analysis: spec.analysis,
      humanSpec: spec.humanSpec,
      outputDir,
    });
  }
  const outcome = await runPlaywrightSuite({
    directory,
    baseUrl,
    specs: selected,
    timeoutMs: specs.length * 100_000 + 30_000,
    networkPolicy: policy,
    signal: options.signal,
    ...secrets,
  });
  const results = specs.map((spec, index) => ({
    ...requiredValue(outcome.results.get(selected[index].key)),
    path: spec.path,
    title: secrets.scrub(spec.title),
    feature: secrets.scrub(spec.feature),
    evidencePath: path.join(directory, spec.path),
    hashes: {
      specTs: createHash("sha256").update(spec.source).digest("hex"),
      specYaml: createHash("sha256").update(spec.yaml).digest("hex"),
    },
  }));
  const status = (() => {
    if (results.every((result) => result.status === "passed")) {
      return "passed";
    }
    if (results.some((result) => result.status === "error")) {
      return "error";
    }
    return "failed";
  })();
  const run: LocalRun = {
    id,
    directory,
    startedAt,
    baseUrl,
    status,
    durationMs: Date.now() - Date.parse(startedAt),
    results,
    report: path.join(directory, "report.html"),
  };
  await fs.writeFile(
    path.join(directory, "run.json"),
    `${secrets.scrub(JSON.stringify(run, null, 2))}\n`
  );
  await generateReport(workspace, id);
  return run;
};
