import fs from "node:fs/promises";
import path from "node:path";
import { prepareReportSection, renderHtmlReport } from "@specbook/runtime/html-report";
import { parseSpecYaml } from "@specbook/runtime/yaml";
import { featuresRepository } from "../../infra/repositories/features";
import { projectsRepository } from "../../infra/repositories/projects";
import { specsRepository } from "../../infra/repositories/specs";
import { realRunDirectory } from "../runner/artifacts";
import { ciResult, type CiResult } from "./results";
import type { RunBatch } from "../runner/batch";

export async function htmlReport(result: CiResult, options: { single?: boolean } = {}): Promise<string> {
    const batch = result.batch;
    const features = new Map((await featuresRepository.listFeatures(batch.projectId)).map((feature) => [feature.id, feature.title]));
    const sections = await Promise.all(result.results.map(async (item) => {
        const spec = await specsRepository.getSpec(item.specId);
        const directory = await realRunDirectory(item.runId);
        const humanSpec = directory
            ? await fs.readFile(path.join(directory, "spec.yml"), "utf8").then((source) => parseSpecYaml(source).humanSpec).catch(() => null)
            : null;
        return prepareReportSection({ item, directory, humanSpec,
            feature: (spec?.featureId && features.get(spec.featureId)) || "Other Specs",
            path: spec?.path ? `${spec.path}/spec.yml` : null });
    }));
    return renderHtmlReport({ project: (await projectsRepository.getProject(batch.projectId))?.name ?? "",
        startedAt: batch.startedAt, durationMs: batch.durationMs, environment: batch.environment,
        ci: batch.ci, qualityGate: result.qualityGate, sections }, options);
}

export async function runReport(run: { id: string; specId: string; status: string; startedAt: string; durationMs: number | null; failReason: string | null; awaitingDeploy?: boolean; environment?: RunBatch["environment"] | null }, spec: { title: string; projectId: string }): Promise<string> {
    const batch = { id: run.id, label: "Spec run", projectId: spec.projectId, status: run.status, startedAt: run.startedAt, durationMs: run.durationMs, environment: run.environment ?? undefined,
        specs: [{ specId: run.specId, runId: run.id, title: spec.title, status: run.status, durationMs: run.durationMs, failReason: run.failReason, awaitingDeploy: run.awaitingDeploy }] } as unknown as RunBatch;
    return htmlReport(await ciResult(batch), { single: true });
}

export async function batchReport(batch: RunBatch): Promise<string> {
    return htmlReport(await ciResult(batch));
}
