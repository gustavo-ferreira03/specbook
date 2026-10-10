import fs from "node:fs/promises";
import path from "node:path";
import { specsRepository } from "../../infra/repositories/specs";
import { backendRoot } from "../paths";
import { parseSpecYaml } from "../repo/yaml";
import { realRunDirectory } from "../runner/artifacts";
import { readEvidenceManifest } from "../runner/evidence";
import { ciResult, type CiResult } from "./results";
import type { RunBatch } from "../runner/batch";

const MAX_IMAGE_BYTES = 5_000_000;
const MAX_VIDEO_BYTES = 8_000_000;
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

type Item = CiResult["results"][number];
type StepState = "passed" | "failed" | "skipped";

interface SpecSection {
    item: Item;
    path: string | null;
    preconditions: string[];
    expectedResult: string;
    steps: { number: number; label: string; state: StepState; image: string | null }[];
    video: string | null;
}

function escape(value: string): string {
    return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function duration(ms: number | null | undefined): string {
    if (ms == null) return "";
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

async function embed(directory: string, file: string, type: string | undefined, maxBytes: number): Promise<string | null> {
    if (!type) return null;
    const source = path.join(directory, file);
    if (!source.startsWith(directory + path.sep)) return null;
    const stat = await fs.stat(source).catch(() => null);
    if (!stat?.isFile() || stat.size > maxBytes) return null;
    return `data:${type};base64,${(await fs.readFile(source)).toString("base64")}`;
}

const image = (directory: string, file: string) => embed(directory, file, IMAGE_TYPES[path.extname(file).toLowerCase()], MAX_IMAGE_BYTES);

async function section(item: Item): Promise<SpecSection> {
    const spec = await specsRepository.getSpec(item.specId);
    const directory = await realRunDirectory(item.runId);
    const human = directory
        ? await fs.readFile(path.join(directory, "spec.yml"), "utf8").then((source) => parseSpecYaml(source).humanSpec).catch(() => null)
        : null;
    const manifest = directory ? await readEvidenceManifest(directory) : { steps: [], video: null, failedStep: null };
    const shots = new Map(manifest.steps.map((step) => [step.number, step]));
    const labels = human?.steps.length ? human.steps : manifest.steps.map((step) => step.label);
    const failedIndex = manifest.failedStep ? labels.findIndex((label) => label.trim() === manifest.failedStep!.trim()) : -1;
    const failed = ["failed", "error"].includes(item.status);
    const steps = await Promise.all(labels.map(async (label, index) => {
        const shot = shots.get(index + 1);
        const state: StepState = !failed ? "passed"
            : failedIndex >= 0 ? (index < failedIndex ? "passed" : index === failedIndex ? "failed" : "skipped")
            : shot ? "passed" : "skipped";
        return { number: index + 1, label: shot?.label.trim() || label, state, image: directory && shot ? await image(directory, shot.file) : null };
    }));
    return { item, path: spec?.path ? `${spec.path}/spec.yml` : null, preconditions: human?.preconditions ?? [], expectedResult: human?.expectedResult ?? "", steps,
        video: directory && manifest.video ? await embed(directory, manifest.video, "video/webm", MAX_VIDEO_BYTES) : null };
}

async function logo(): Promise<string> {
    const svg = await fs.readFile(path.join(backendRoot, "..", "frontend", "public", "specbook-logo.svg"), "utf8").catch(() => "");
    return svg ? `<img class="logo" alt="" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}">` : "";
}

const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const CROSS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const BUG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 2l1.9 1.9M16 2l-1.9 1.9M9 7.1V6a3 3 0 0 1 6 0v1.1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6zM12 20v-9M6 13H2M22 13h-4M6.5 8.5 4 7M17.5 8.5 20 7M6 17l-2.5 1.5M18 17l2.5 1.5"/></svg>';
const RETRY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';

function count(tone: string, label: string, value: number, icon: string): string {
    return `<div class="count is-${tone}${value === 0 ? " zero" : ""}"><span class="icon">${icon}</span><span><b>${value}</b><small>${label}</small></span></div>`;
}

function statusOf(item: Item): { tone: "passed" | "failed" | "running"; label: string } {
    if (item.pending) return { tone: "running", label: "Running" };
    if (["failed", "error"].includes(item.status)) return { tone: "failed", label: item.knownBug ? "Failed · known bug" : item.status === "error" ? "Error" : "Failed" };
    return { tone: "passed", label: "Passed" };
}

function renderSection({ item, path: file, preconditions, expectedResult, steps, video }: SpecSection, open = false): string {
    const status = statusOf(item);
    const shots = steps.filter((step) => step.image);
    return `<details id="run-${escape(item.runId)}" class="spec ${status.tone}"${open || status.tone === "failed" ? " open" : ""}>
<summary>
  <span class="seal">${status.tone === "failed" ? CROSS : CHECK}</span>
  <span class="heading"><span class="title">${escape(item.title)}</span>${file ? `<span class="path">${escape(file)}</span>` : ""}</span>
  ${item.flaky ? `<span class="flaky">${RETRY}Flaky</span>` : ""}
  <span class="state">${escape(status.label)}</span>
  <span class="time">${escape(duration(item.durationMs))}</span>
</summary>
<div class="body">
  ${preconditions.length ? `<h3>Preconditions</h3><ul class="bullets">${preconditions.map((entry) => `<li>${escape(entry)}</li>`).join("")}</ul>` : ""}
  ${steps.length ? `<h3>Steps</h3><ol class="steps">${steps.map((step) => `<li class="${step.state}"><span class="num">${step.number}</span><span class="label">${escape(step.label)}</span><span class="mark">${step.state === "passed" ? CHECK : step.state === "failed" ? CROSS : ""}</span></li>`).join("")}</ol>` : ""}
  ${expectedResult ? `<div class="expected"><h3>Expected result</h3><p>${escape(expectedResult)}</p></div>` : ""}
  ${item.failReason && status.tone === "failed" ? `<div class="failure"><h3>What failed</h3><pre>${escape(item.failReason)}</pre></div>` : ""}
  ${shots.length ? `<h3>Screenshots</h3><div class="shots">${shots.map((step) => {
      const id = `shot-${item.runId}-${step.number}`;
      return `<figure id="${escape(id)}"><a class="zoom" href="#${escape(id)}"><img src="${step.image}" alt="Step ${step.number}: ${escape(step.label)}"></a><a class="close" href="#run-${escape(item.runId)}" aria-label="Close"></a><figcaption><b>Step ${step.number}</b> ${escape(step.label)}</figcaption></figure>`;
  }).join("")}</div>` : ""}
  ${video ? `<h3>Recording</h3><video class="recording" controls preload="metadata" src="${video}"></video>` : ""}
</div>
</details>`;
}

const STYLE = `
:root{--ink:#2b2b2b;--muted:#6b6b6b;--subtle:#8f8f8f;--line:#ebebeb;--strong:#d6d6d6;--surface:#fff;--soft:#fafafa;--primary:#262626;--success:#1f7a4d;--success-soft:#e9f6ef;--danger:#bd5149;--danger-soft:#fff0ed;--warning:#f2b705;--dot:#c9c9c9}
*{box-sizing:border-box}
body{margin:0;background:var(--surface);color:var(--ink);font:15px/1.55 Geist,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
code,pre,.path,.time,.mono{font-family:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-ligatures:none}
a{color:inherit}
header{background-image:radial-gradient(circle,var(--dot) 1.1px,transparent 1.5px);background-size:24px 24px;border-bottom:1px solid var(--line)}
.wrap{max-width:960px;margin:0 auto;padding:0 24px}
.top{padding-top:28px;padding-bottom:32px;background:linear-gradient(to right,var(--surface) 45%,transparent)}
.brand{display:flex;align-items:center;gap:6px;font-weight:700;font-size:18px;letter-spacing:-.04em}
.logo{width:26px;height:26px}
.kicker{margin:22px 0 4px;color:var(--muted);font-size:13px}
h1{margin:0;font-size:32px;line-height:1.15;letter-spacing:-.02em}
.meta{margin-top:10px;color:var(--muted);font-size:13px;display:flex;flex-wrap:wrap;gap:6px 14px}
.meta b{color:var(--ink);font-weight:600}
.verdict.passed{color:var(--success)}.verdict.failed{color:var(--danger)}
.counts{display:flex;flex-wrap:wrap;gap:14px;margin:0 0 28px}
.count{--c:var(--muted);display:flex;align-items:center;gap:12px;min-width:150px;padding:10px 16px 10px 12px;background:var(--surface);border:2px solid var(--c);border-radius:12px;box-shadow:3px 3px 0 var(--c)}
.count.is-passed{--c:var(--success)}.count.is-failed{--c:var(--danger)}.count.is-flaky{--c:var(--warning)}.count.is-known{--c:var(--muted)}
.count .icon{flex:none;width:34px;height:34px;border-radius:9px;background:var(--c);display:flex;align-items:center;justify-content:center}
.count .icon svg{width:18px;height:18px;fill:none;stroke:#fff;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round}
.count b{display:block;font-size:26px;line-height:1;letter-spacing:-0.03em;color:var(--ink);font-variant-numeric:tabular-nums}
.count small{display:block;margin-top:3px;font-size:12.5px;color:var(--muted)}
.count.zero{--c:var(--strong);border-width:1px;padding:11px 17px 11px 13px;box-shadow:none}
.count.zero .icon{background:var(--soft)}.count.zero .icon svg{stroke:var(--subtle)}.count.zero b{color:var(--subtle)}
main.wrap{padding-top:32px;padding-bottom:24px}
.spec{border:1px solid var(--strong);border-radius:12px;background:var(--surface);margin:0 8px 22px 0;box-shadow:4px 4px 0 -1px var(--surface),4px 4px 0 0 var(--strong),8px 8px 0 -1px var(--surface),8px 8px 0 0 var(--strong)}
.spec>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:14px;padding:16px 18px}
.spec>summary::-webkit-details-marker{display:none}
.seal{flex:none;display:flex;width:36px;height:36px;border-radius:8px;align-items:center;justify-content:center;color:#fff}
.passed .seal{background:var(--success)}.failed .seal{background:var(--danger)}.running .seal{background:var(--subtle)}
.seal svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
.heading{flex:1;min-width:0;display:flex;flex-direction:column}
.title{font-weight:600}
.path{font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.state{font-size:13px;font-weight:600}
.passed .state{color:var(--success)}.failed .state{color:var(--danger)}.running .state{color:var(--muted)}
.time{font-size:12px;color:var(--subtle);min-width:48px;text-align:right}
.flaky{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;border:2px solid var(--warning);border-radius:999px;padding:1px 9px;box-shadow:2px 2px 0 var(--warning)}
.flaky svg{width:12px;height:12px;fill:none;stroke:var(--warning);stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}
.body{border-top:1px solid var(--line);padding:6px 18px 18px}
h3{font-size:13px;margin:18px 0 8px}
.bullets{margin:0;padding-left:18px}
.steps{list-style:none;margin:0;padding:0}
.steps li{display:flex;align-items:flex-start;gap:12px;padding:5px 0}
.num{flex:none;width:24px;height:24px;border:1px solid var(--strong);border-radius:6px;display:flex;align-items:center;justify-content:center;font:600 12px "Geist Mono",ui-monospace,monospace;color:var(--muted)}
.label{flex:1;padding-top:1px}
.mark svg{width:15px;height:15px;fill:none;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round;margin-top:4px}
.steps .passed .mark svg{stroke:var(--success)}.steps .failed .mark svg{stroke:var(--danger)}
.steps .failed .num{border-color:var(--danger);color:var(--danger)}
.steps .skipped{color:var(--subtle)}
.expected{border-top:1px solid var(--line);margin-top:16px}
.expected p{margin:0;font-weight:500}
.failure{border:1px solid var(--danger);background:var(--danger-soft);border-radius:10px;padding:2px 14px 12px;margin-top:16px}
.failure h3{color:var(--danger)}
.failure pre{margin:0;white-space:pre-wrap;word-break:break-word;font-size:12px;max-height:280px;overflow:auto}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px}
figure{margin:0}
figure img{width:100%;border:1px solid var(--strong);border-radius:8px;display:block}
figcaption{font-size:12px;color:var(--muted);margin-top:6px}
.zoom{display:block;cursor:zoom-in}
.close{display:none}
figure:target{position:fixed;inset:0;z-index:10;margin:0;padding:24px;background:rgb(20 20 20/.88);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px}
figure:target .zoom{cursor:default;position:relative;z-index:1}
figure:target img{width:auto;max-width:min(1400px,100%);max-height:calc(100vh - 80px);border-color:#444}
figure:target figcaption{color:#e6e6e6;position:relative;z-index:1}
figure:target figcaption b{color:#fff}
figure:target .close{display:block;position:absolute;inset:0;cursor:zoom-out}
.recording{width:100%;max-width:720px;border:1px solid var(--strong);border-radius:8px;display:block;background:#000}
footer.wrap{color:var(--subtle);font-size:12px;padding-bottom:40px}
`;

export async function htmlReport(result: CiResult, options: { single?: boolean } = {}): Promise<string> {
    const sections = await Promise.all(result.results.map(section));
    const order = (entry: SpecSection) => (["failed", "error"].includes(entry.item.status) ? 0 : entry.item.flaky ? 1 : 2);
    sections.sort((a, b) => order(a) - order(b));
    const total = result.results.length;
    const passed = result.results.filter((item) => item.status === "passed").length;
    const failed = result.results.filter((item) => ["failed", "error"].includes(item.status)).length;
    const batch = result.batch;
    const ci = batch.ci;
    const elapsed = batch.durationMs;
    const verdict = result.qualityGate.passed ? "passed" : "failed";
    const meta = [
        `<span class="verdict ${verdict}"><b>${verdict === "passed" ? "Quality gate passed" : `Quality gate failed · ${result.qualityGate.failures} failure${result.qualityGate.failures === 1 ? "" : "s"}`}</b></span>`,
        batch.environment?.name ? `<span>Environment <b>${escape(batch.environment.name)}</b></span>` : "",
        `<span>${escape(new Date(batch.startedAt).toUTCString())}</span>`,
        elapsed != null ? `<span class="mono">${escape(duration(elapsed))}</span>` : "",
        ci?.commitSha ? `<span class="mono">${escape(ci.commitSha.slice(0, 7))}</span>` : "",
        ci?.ref ? `<span class="mono">${escape(ci.ref)}</span>` : "",
        ci?.buildUrl ? `<a href="${escape(ci.buildUrl)}">Build</a>` : "",
    ].filter(Boolean).join("");
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Specbook · ${escape(batch.label)}</title><style>${STYLE}</style></head>
<body>
<header><div class="wrap top">
  <div class="brand">${await logo()}specbook</div>
  <p class="kicker mono">${escape(batch.label)}</p>
  <h1>${options.single && result.results[0] ? escape(result.results[0].title) : `${passed} of ${total} Spec${total === 1 ? "" : "s"} passed`}</h1>
  <div class="meta">${meta}</div>
</div></header>
<main class="wrap">
  ${options.single ? "" : `<div class="counts">
    ${count("passed", "Passed", passed, CHECK)}
    ${count("failed", "Failed", failed, CROSS)}
    ${count("flaky", "Flaky", result.qualityGate.flaky, RETRY)}
    ${count("known", "Known bugs", result.qualityGate.knownBugs, BUG)}
  </div>`}
  ${sections.map((entry) => renderSection(entry, options.single)).join("\n")}
</main>
<footer class="wrap">Generated by Specbook.</footer>
</body></html>`;
}

export async function runReport(run: { id: string; specId: string; status: string; startedAt: string; durationMs: number | null; failReason: string | null; environment?: RunBatch["environment"] | null }, spec: { title: string; projectId: string }): Promise<string> {
    const batch = { id: run.id, label: "Spec run", projectId: spec.projectId, status: run.status, startedAt: run.startedAt, durationMs: run.durationMs, environment: run.environment ?? undefined,
        specs: [{ specId: run.specId, runId: run.id, title: spec.title, status: run.status, durationMs: run.durationMs, failReason: run.failReason }] } as unknown as RunBatch;
    return htmlReport(await ciResult(batch), { single: true });
}

export async function batchReport(batch: RunBatch): Promise<string> {
    return htmlReport(await ciResult(batch));
}
