import fs from "node:fs/promises";
import path from "node:path";
import { specsRepository } from "../../infra/repositories/specs";
import { backendRoot } from "../paths";
import { parseSpecYaml } from "../repo/yaml";
import { realRunDirectory } from "../runner/artifacts";
import { readEvidenceManifest } from "../runner/evidence";
import type { CiResult } from "./results";

const MAX_IMAGE_BYTES = 600_000;
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

type Item = CiResult["results"][number];
type StepState = "passed" | "failed" | "skipped";

interface SpecSection {
    item: Item;
    path: string | null;
    preconditions: string[];
    expectedResult: string;
    steps: { number: number; label: string; state: StepState; image: string | null }[];
}

function escape(value: string): string {
    return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function duration(ms: number | null | undefined): string {
    if (ms == null) return "";
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

async function image(directory: string, file: string): Promise<string | null> {
    const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
    if (!type) return null;
    const source = path.join(directory, file);
    if (!source.startsWith(directory + path.sep)) return null;
    const stat = await fs.stat(source).catch(() => null);
    if (!stat?.isFile() || stat.size > MAX_IMAGE_BYTES) return null;
    return `data:${type};base64,${(await fs.readFile(source)).toString("base64")}`;
}

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
    return { item, path: spec?.path ? `${spec.path}/spec.yml` : null, preconditions: human?.preconditions ?? [], expectedResult: human?.expectedResult ?? "", steps };
}

async function logo(): Promise<string> {
    const svg = await fs.readFile(path.join(backendRoot, "..", "frontend", "public", "specbook-logo.svg"), "utf8").catch(() => "");
    return svg ? `<img class="logo" alt="" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}">` : "";
}

const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const CROSS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const RETRY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';

function statusOf(item: Item): { tone: "passed" | "failed" | "running"; label: string } {
    if (item.pending) return { tone: "running", label: "Running" };
    if (["failed", "error"].includes(item.status)) return { tone: "failed", label: item.knownBug ? "Failed · known bug" : item.status === "error" ? "Error" : "Failed" };
    return { tone: "passed", label: "Passed" };
}

function renderSection({ item, path: file, preconditions, expectedResult, steps }: SpecSection): string {
    const status = statusOf(item);
    const shots = steps.filter((step) => step.image);
    return `<details class="spec ${status.tone}"${status.tone === "failed" ? " open" : ""}>
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
  ${shots.length ? `<h3>Screenshots</h3><div class="shots">${shots.map((step) => `<figure><a href="${step.image}" target="_blank" rel="noopener"><img src="${step.image}" alt="Step ${step.number}: ${escape(step.label)}" loading="lazy"></a><figcaption><b>Step ${step.number}</b> ${escape(step.label)}</figcaption></figure>`).join("")}</div>` : ""}
  <a class="open" href="${escape(item.url)}">Open this run in Specbook</a>
</div>
</details>`;
}

const STYLE = `
:root{--ink:#2b2b2b;--muted:#6b6b6b;--subtle:#8f8f8f;--line:#ebebeb;--strong:#d6d6d6;--surface:#fff;--soft:#fafafa;--primary:#262626;--success:#1f7a4d;--success-soft:#e9f6ef;--danger:#bd5149;--danger-soft:#fff0ed;--warning:#f2b705;--dot:#c9c9c9}
@media (prefers-color-scheme:dark){:root{--ink:#eeeeee;--muted:#bdbdbd;--subtle:#9a9a9a;--line:#333;--strong:#444;--surface:#1f1f1f;--soft:#262626;--primary:#dedede;--success:#5fd39a;--success-soft:#1d3a2b;--danger:#f08a7a;--danger-soft:#3d2421;--dot:#3a3a3a}}
*{box-sizing:border-box}
body{margin:0;background:var(--surface);color:var(--ink);font:15px/1.55 Geist,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
code,pre,.path,.time,.mono{font-family:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-ligatures:none}
a{color:inherit}
header{background-image:radial-gradient(circle,var(--dot) 1.1px,transparent 1.5px);background-size:24px 24px;border-bottom:1px solid var(--line)}
.wrap{max-width:960px;margin:0 auto;padding:0 24px}
.top{padding-top:28px;padding-bottom:32px;background:linear-gradient(to right,var(--surface) 45%,transparent)}
.brand{display:flex;align-items:center;gap:6px;font-weight:700;font-size:18px;letter-spacing:-.04em}
.logo{width:26px;height:26px}
@media (prefers-color-scheme:dark){.logo{filter:invert(1)}}
.kicker{margin:22px 0 4px;color:var(--muted);font-size:13px}
h1{margin:0;font-size:32px;line-height:1.15;letter-spacing:-.02em}
.meta{margin-top:10px;color:var(--muted);font-size:13px;display:flex;flex-wrap:wrap;gap:6px 14px}
.meta b{color:var(--ink);font-weight:600}
.verdict.passed{color:var(--success)}.verdict.failed{color:var(--danger)}
.counts{display:flex;flex-wrap:wrap;gap:10px;margin:26px 0 8px}
.count{border:1px solid var(--strong);border-radius:10px;padding:8px 14px;font-size:13px;color:var(--muted)}
.count b{display:block;font-size:20px;color:var(--ink);font-variant-numeric:tabular-nums}
main{padding:20px 0 64px}
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
.open{display:inline-block;margin-top:18px;font-size:13px;font-weight:600;border:2px solid var(--primary);border-radius:8px;padding:6px 12px;text-decoration:none;box-shadow:2px 2px 0 var(--primary)}
footer{color:var(--subtle);font-size:12px;padding:0 0 40px}
`;

export async function htmlReport(result: CiResult): Promise<string> {
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
        `<a href="${escape(result.url)}">Open in Specbook</a>`,
    ].filter(Boolean).join("");
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Specbook · ${escape(batch.label)}</title><style>${STYLE}</style></head>
<body>
<header><div class="wrap top">
  <div class="brand">${await logo()}specbook</div>
  <p class="kicker mono">${escape(batch.label)}</p>
  <h1>${passed} of ${total} Spec${total === 1 ? "" : "s"} passed</h1>
  <div class="meta">${meta}</div>
</div></header>
<main class="wrap">
  <div class="counts">
    <div class="count"><b>${passed}</b>Passed</div>
    <div class="count"><b>${failed}</b>Failed</div>
    <div class="count"><b>${result.qualityGate.flaky}</b>Flaky</div>
    <div class="count"><b>${result.qualityGate.knownBugs}</b>Known bugs</div>
  </div>
  ${sections.map(renderSection).join("\n")}
</main>
<footer class="wrap">Generated by Specbook from the files each Spec ran with.</footer>
</body></html>`;
}
