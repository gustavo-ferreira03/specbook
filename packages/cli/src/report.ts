import fs from "node:fs/promises";
import path from "node:path";
import { prepareReportSection, renderHtmlReport } from "@specbook/runtime/html-report";
import { parseSpecYaml } from "@specbook/runtime/yaml";
import { safeWorkspacePath } from "./workspace";
import type { LocalRun } from "./run";

export async function generateReport(workspace: string, selector?: string): Promise<{ run: string; report: string }> {
    const runs = await safeWorkspacePath(workspace, "runs");
    const ids = (await fs.readdir(runs, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    const id = selector ?? ids.at(-1);
    if (!id) throw new Error("No local runs found");
    if (id.includes("/") || id.includes("\\") || id === "." || id === "..") throw new Error("Use a local run ID");
    const run = JSON.parse(await fs.readFile(await safeWorkspacePath(workspace, `runs/${id}/run.json`), "utf8")) as LocalRun;
    const sections = [];
    for (const item of run.results) {
        const relative = `runs/${id}/${item.path}`;
        const evidenceDirectory = await safeWorkspacePath(workspace, relative);
        const human = parseSpecYaml(await fs.readFile(await safeWorkspacePath(workspace, `${relative}/spec.yml`), "utf8"));
        for (const entry of await fs.readdir(evidenceDirectory, { recursive: true })) await safeWorkspacePath(workspace, `${relative}/${entry}`);
        sections.push(await prepareReportSection({ item: { ...item, runId: item.path }, directory: evidenceDirectory, feature: item.feature, path: item.path, humanSpec: human.humanSpec }));
    }
    const failures = run.results.filter((item) => item.status !== "passed").length;
    const html = await renderHtmlReport({ project: path.basename(path.dirname(workspace)), startedAt: run.startedAt, durationMs: run.durationMs, qualityGate: { passed: failures === 0, failures }, sections }, { single: run.results.length === 1 });
    const report = await safeWorkspacePath(workspace, `runs/${id}/report.html`, true);
    await fs.writeFile(report, html);
    return { run: id, report };
}
