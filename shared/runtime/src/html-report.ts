import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { executionPlan, type ExecutionStepKind, type HumanSpec } from "./types.ts";
import { readEvidenceManifest } from "./evidence.ts";
import { analyzeSpecSource, sameStepTitle } from "./validate.ts";
import { readReplay, type ReplayEvent } from "./replay.ts";
import { packReplayEvents } from "./replay-assets.ts";
import { REPORT_REPLAY_SCRIPT } from "./report-replay.ts";

const MAX_IMAGE_BYTES = 5_000_000;
const MAX_VIDEO_BYTES = 8_000_000;
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

export interface ReportItem {
    runId: string;
    title: string;
    status: string;
    durationMs: number | null;
    failReason: string | null;
    pending?: boolean;
    knownBug?: boolean;
    flaky?: boolean;
    awaitingDeploy?: boolean;
}

type Item = ReportItem;
type StepState = "passed" | "failed" | "skipped";
type Tone = "failed" | "known" | "flaky" | "waiting" | "running" | "passed";

const TONES: { tone: Tone; label: string; tally: (n: number) => string }[] = [
    { tone: "failed", label: "Failed", tally: (n) => `${n} failed` },
    { tone: "known", label: "Known bugs", tally: (n) => `${n} known bug${n === 1 ? "" : "s"}` },
    { tone: "flaky", label: "Flaky", tally: (n) => `${n} flaky` },
    { tone: "waiting", label: "Waiting for deploy", tally: (n) => `${n} waiting for deploy` },
    { tone: "running", label: "Running", tally: (n) => `${n} running` },
    { tone: "passed", label: "Passed", tally: (n) => `${n} passed` },
];


export interface ReportSection {
    item: Item;
    tone: Tone;
    feature: string;
    path: string | null;
    expectedResult: string;
    // number is the step() position in spec.ts; ordinal numbers only the Spec's steps.
    steps: { number: number; ordinal: number | null; kind: ExecutionStepKind; label: string; state: StepState; image: string | null }[];
    video: string | null;
    replay?: string | null;
    replayUnavailable?: string;
}

// Zoom with a class instead of the :target anchor, so closing doesn't scroll the page; the anchors remain the no-script fallback.
const ZOOM_SCRIPT = `(() => {
  let open = null;
  let top = 0;
  const close = () => {
    if (!open) return;
    open.classList.remove("is-zoomed");
    open = null;
    window.scrollTo({ top, behavior: "instant" });
  };
  document.addEventListener("click", (event) => {
    if (open && event.target.closest("figure.is-zoomed .close, figure.is-zoomed .zoom")) { event.preventDefault(); close(); return; }
    const zoom = event.target.closest("figure .zoom");
    if (!zoom || open) return;
    event.preventDefault();
    top = window.scrollY;
    open = zoom.closest("figure");
    open.classList.add("is-zoomed");
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
})();`;

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

function offlineReplay(value: unknown): unknown {
    if (typeof value === "string") return value.replace(/@import\s+(?:url\([^)]*\)|["'][^"']*["'])[^;]*;?/gi, "")
        .replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (_match, _quote, url: string) => /^(?:data:|#)/i.test(url.trim()) ? `url("${url.trim().replace(/"/g, "%22")}")` : 'url("data:,")');
    if (Array.isArray(value)) return value.map(offlineReplay);
    if (!value || typeof value !== "object") return value;
    const entry = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(entry)) {
        // Mutation events carry a list of { id, attributes } changes; nodes carry the attribute map itself.
        if (key === "attributes" && item && typeof item === "object" && !Array.isArray(item)) {
            const attributes: Record<string, unknown> = {};
            for (const [name, attribute] of Object.entries(item)) {
                if (["src", "poster", "background", "xlink:href", "srcset", "srcdoc", "action", "formaction"].includes(name)) {
                    if (name !== "srcdoc" && name !== "srcset" && typeof attribute === "string" && /^data:(?:image|font|audio|video)\//i.test(attribute)) attributes[name] = attribute;
                } else if (name === "href") {
                    if (typeof attribute === "string" && attribute.startsWith("#")) attributes[name] = attribute;
                } else if (!name.toLowerCase().startsWith("on") && name !== "http-equiv") attributes[name] = offlineReplay(attribute);
            }
            result[key] = attributes;
        } else result[key] = offlineReplay(item);
    }
    return result;
}

async function replayData(directory: string): Promise<string | null> {
    const events = await readReplay(directory);
    const recording = events ? packReplayEvents(offlineReplay(events) as ReplayEvent[]) : null;
    return recording ? gzipSync(JSON.stringify(recording)).toString("base64") : null;
}

function assertionWait(reason: string | null): { ms: number; summary: string } | null {
    if (!reason?.includes("expect(locator).toHaveCount(expected) failed")) return null;
    const expected = reason.match(/^Expected:\s*(\d+)\s*$/m)?.[1];
    const received = reason.match(/^Received:\s*(\d+)\s*$/m)?.[1];
    const timeout = reason.match(/^Timeout:\s*(\d+)ms\s*$/m)?.[1];
    if (expected === undefined || received === undefined || timeout === undefined) return null;
    const ms = Number(timeout);
    if (!Number.isSafeInteger(ms) || ms < 1) return null;
    return { ms, summary: `Waited ${duration(ms)} for ${expected} element${expected === "1" ? "" : "s"}; saw ${received}` };
}

function toneOf(item: Item): Tone {
    if (item.pending) return "running";
    if (item.awaitingDeploy) return "waiting";
    if (["failed", "error"].includes(item.status)) return item.knownBug ? "known" : "failed";
    return item.flaky ? "flaky" : "passed";
}

export async function prepareReportSection(options: {
    item: ReportItem;
    directory: string | null;
    feature?: string;
    path?: string | null;
    humanSpec?: HumanSpec | null;
}): Promise<ReportSection> {
    const { item, directory, humanSpec: human } = options;
    const manifest = directory ? await readEvidenceManifest(directory) : { steps: [], video: null, failedStep: null };
    const shots = new Map(manifest.steps.map((step) => [step.number, step]));
    const planned = human ? executionPlan(human) : [];
    const source = directory ? await fs.readFile(path.join(directory, "spec.ts"), "utf8").catch(() => null) : null;
    const analysis = source ? analyzeSpecSource(source) : null;
    const executed = analysis?.ok ? analysis.analysis.steps.map((title, index) => ({ number: index + 1, title }))
        : manifest.steps.length ? manifest.steps.map((step) => ({ number: step.number, title: step.label }))
        : planned.map((entry, index) => ({ number: index + 1, title: entry.title }));
    const failedIndex = manifest.failedStep ? executed.findIndex((entry) => sameStepTitle(entry.title, manifest.failedStep!)) : -1;
    const failed = ["failed", "error"].includes(item.status);
    const steps = await Promise.all(executed.map(async ({ number, title }, index) => {
        const shot = shots.get(number);
        const label = shot?.label.trim() || title;
        const state: StepState = !failed ? "passed"
            : failedIndex >= 0 ? (index < failedIndex ? "passed" : index === failedIndex ? "failed" : "skipped")
            : shot ? "passed" : "skipped";
        const matching = executed.length === planned.length ? planned[index] : planned.find((entry) => sameStepTitle(entry.title, label));
        return { number, ordinal: matching?.ordinal ?? (matching ? null : number), kind: matching?.kind ?? "step", label, state, image: directory && shot ? await image(directory, shot.file) : null };
    }));
    return { item, tone: toneOf(item), feature: options.feature || "Other Specs", path: options.path ?? null, expectedResult: human?.expectedResult ?? "", steps,
        video: directory && manifest.video ? await embed(directory, manifest.video, "video/webm", MAX_VIDEO_BYTES) : null,
        replay: directory && manifest.replay ? await replayData(directory) : null,
        ...(manifest.replayUnavailable ? { replayUnavailable: manifest.replayUnavailable } : {}) };
}

const publicAsset = (file: string) => fs.readFile(new URL(`./assets/${file}`, import.meta.url), "utf8")
    .catch(() => fs.readFile(new URL(`../dist/assets/${file}`, import.meta.url), "utf8").catch(() => ""));

async function favicon(): Promise<string> {
    const svg = await publicAsset("specbook-icon.svg");
    return svg ? `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}">` : "";
}

async function fonts(): Promise<string> {
    const face = async (family: string, file: string, weight: string) => {
        const font = await fs.readFile(new URL(`./assets/${file}`, import.meta.url)).catch(() => null);
        return font ? `@font-face{font-family:"${family}";font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${font.toString("base64")}) format("woff2")}` : "";
    };
    return (await face("Recursive", "recursive-latin.woff2", "400 700")) + (await face("Geist", "geist-bold-latin.woff2", "700"));
}

async function logo(): Promise<string> {
    const svg = await publicAsset("specbook-logo.svg");
    return svg ? `<img class="logo" alt="" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}">` : "";
}

const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const CROSS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const BUG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 2l1.9 1.9M16 2l-1.9 1.9M9 7.1V6a3 3 0 0 1 6 0v1.1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6zM12 20v-9M6 13H2M22 13h-4M6.5 8.5 4 7M17.5 8.5 20 7M6 17l-2.5 1.5M18 17l2.5 1.5"/></svg>';
const ALL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
const RETRY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
const CLOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

const ICONS: Record<Tone, string> = { failed: CROSS, known: BUG, flaky: RETRY, waiting: CLOCK, running: RETRY, passed: CHECK };
const RANK: Record<Tone, number> = { failed: 0, known: 1, flaky: 2, waiting: 3, running: 4, passed: 5 };

function filter(tone: Tone | "all", label: string, value: number, checked: boolean): string {
    const id = `filter-${tone}`;
    return `<input type="radio" name="filter" id="${id}" class="filter-input"${checked ? " checked" : ""}${value === 0 ? " disabled" : ""}><label for="${id}" class="count is-${tone}${value === 0 ? " zero" : ""}"><span class="icon">${tone === "all" ? ALL : ICONS[tone]}</span><span><b>${value}</b><small>${label}</small></span></label>`;
}

function stateLabel(item: Item, tone: Tone): string {
    if (tone === "failed") return item.status === "error" ? "Error" : "Failed";
    return { known: "Known bug", flaky: "Passed on retry", waiting: "Waiting for deploy", running: "Running", passed: "Passed" }[tone] ?? "";
}

function renderSteps(steps: ReportSection["steps"], replay: boolean): string {
    return `<ol class="steps">${steps.map((step) => `<li class="${step.state}">${step.ordinal === null ? '<span class="dot"></span>' : `<span class="num">${step.ordinal}</span>`}${replay && step.state !== "skipped" ? `<button type="button" class="label step-seek" data-replay-step="${step.number}" aria-label="Replay: ${escape(step.label)}">${escape(step.label)}</button>` : `<span class="label">${escape(step.label)}</span>`}<span class="mark">${step.state === "passed" ? CHECK : step.state === "failed" ? CROSS : ""}</span></li>`).join("")}</ol>`;
}

function renderSection({ item, tone, path: file, expectedResult, steps, video, replay, replayUnavailable }: ReportSection, open = false, showPath = false): string {
    const failing = tone === "failed" || tone === "known" || tone === "waiting";
    const shots = steps.filter((step) => step.image);
    const preconditions = steps.filter((step) => step.kind === "precondition");
    const actions = steps.filter((step) => step.kind === "step");
    const proof = steps.find((step) => step.kind === "expected");
    const postconditions = steps.filter((step) => step.kind === "postcondition");
    const wait = failing ? assertionWait(item.failReason) : null;
    const shotId = (step: ReportSection["steps"][number]) => `shot-${item.runId}-${step.number}`;
    return `<details id="run-${escape(item.runId)}" class="spec is-${tone}"${open || tone === "failed" ? " open" : ""}>
<summary>
  <span class="seal">${ICONS[tone]}</span>
  <span class="heading"><span class="title">${escape(item.title)}</span>${showPath && file ? `<span class="path">${escape(file)}</span>` : ""}</span>
  <span class="state">${escape(stateLabel(item, tone))}</span>
  <span class="time">${escape(duration(item.durationMs))}</span>
</summary>
<div class="body">
  ${preconditions.length ? `<h3>Preconditions</h3>${renderSteps(preconditions, Boolean(replay))}` : ""}
  ${actions.length ? `<h3>Steps</h3>${renderSteps(actions, Boolean(replay))}` : ""}
  ${expectedResult ? `<div class="expected ${proof?.state ?? ""}"><h3>Expected result</h3><p>${proof ? `<span class="mark">${proof.state === "passed" ? CHECK : proof.state === "failed" ? CROSS : ""}</span>` : ""}${replay && proof && proof.state !== "skipped" ? `<button type="button" class="step-seek" data-replay-step="${proof.number}" aria-label="Replay expected result">${escape(expectedResult)}</button>` : escape(expectedResult)}</p>${proof?.image && !replay ? `<a class="proof" href="#${escape(shotId(proof))}"><img src="${proof.image}" alt="Expected result: ${escape(expectedResult)}"></a>` : ""}</div>` : ""}
  ${postconditions.length ? `<h3>Postconditions</h3>${renderSteps(postconditions, Boolean(replay))}` : ""}
  ${item.failReason && failing ? `<div class="failure"><h3>What failed</h3>${wait ? `<p class="failure-wait">${escape(wait.summary)}</p>` : ""}<pre>${escape(item.failReason)}</pre></div>` : ""}
  ${replay ? `<div class="visuals"><section class="replay" aria-label="Session replay"${wait ? ` data-wait-ms="${wait.ms}"` : ""}><h3>Replay</h3><p class="replay-status">Loading replay…</p><div class="replay-player"></div><script class="replay-data" type="application/octet-stream">${replay}</script></section><section class="screenshot-section">` : ""}
  ${shots.length ? `<h3>Screenshots</h3><div class="shots">${shots.map((step) => {
      const id = shotId(step);
      const name = step.kind === "expected" ? "Expected result" : step.kind === "precondition" ? "Precondition" : step.kind === "postcondition" ? "Postcondition" : `Step ${step.ordinal}`;
      return `<figure id="${escape(id)}"${step.kind === "expected" ? ' class="is-proof"' : ""}><a class="zoom" href="#${escape(id)}"${replay ? ` data-replay-step="${step.number}" aria-label="Enlarge screenshot and replay ${escape(name)}: ${escape(step.label)}"` : ""}><img src="${step.image}" alt="${name}: ${escape(step.label)}"></a><a class="close" href="#run-${escape(item.runId)}" aria-label="Close"></a><figcaption><b>${name}</b> ${escape(step.label)}</figcaption></figure>`;
  }).join("")}</div>` : ""}
  ${replay ? "</section></div>" : replayUnavailable ? `<p class="replay-note">${escape(replayUnavailable)}</p>` : ""}
  ${video ? `<h3>Recording</h3><video class="recording" controls preload="metadata" src="${video}"></video>` : ""}
</div>
</details>`;
}

const STYLE = `
:root{--ink:#2b2b2b;--muted:#6b6b6b;--subtle:#8f8f8f;--line:#ebebeb;--strong:#d6d6d6;--surface:#fff;--soft:#fafafa;--primary:#262626;--success:#1f7a4d;--success-soft:#e9f6ef;--danger:#bd5149;--danger-soft:#fff0ed;--warning:#f2b705;--dot:#c9c9c9}
*{box-sizing:border-box}
body{margin:0;background:var(--surface);color:var(--ink);font:15px/1.55 Recursive,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;font-variation-settings:"CASL" .35}
code,pre,.path,.time,.mono{font-family:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-ligatures:none}
a{color:inherit}
header{background-image:radial-gradient(circle,var(--dot) 1.1px,transparent 1.5px);background-size:24px 24px;border-bottom:1px solid var(--line)}
.wrap{max-width:960px;margin:0 auto;padding:0 24px}
.top{padding-top:28px;padding-bottom:32px;background:linear-gradient(to right,var(--surface) 45%,transparent)}
.brand{display:flex;align-items:center;gap:6px;font-family:Geist,ui-sans-serif,system-ui,sans-serif;font-weight:700;font-size:18px;letter-spacing:-.04em}
.logo{width:26px;height:26px}
.kicker{margin:22px 0 4px;color:var(--muted);font-size:13px}
h1{margin:0;font-size:32px;line-height:1.15;letter-spacing:-.02em}
.meta{margin-top:10px;color:var(--muted);font-size:13px;display:flex;flex-wrap:wrap;gap:6px 14px}
.meta b{color:var(--ink);font-weight:600}
.verdict.passed{color:var(--success)}.verdict.failed{color:var(--danger)}
main.wrap{padding-top:32px;padding-bottom:24px}
.filters{display:flex;flex-wrap:wrap;gap:12px;margin:0 0 36px}
.filter-input{position:absolute;opacity:0;pointer-events:none}
.count{--c:var(--muted);display:flex;align-items:center;gap:12px;min-width:140px;padding:10px 16px 10px 12px;background:var(--surface);border:2px solid var(--c);border-radius:12px;cursor:pointer;user-select:none;transition:transform .12s ease,box-shadow .12s ease}
.count.is-all{--c:var(--primary)}.count.is-passed{--c:var(--success)}.count.is-failed{--c:var(--danger)}.count.is-flaky{--c:var(--warning)}.count.is-known{--c:var(--muted)}.count.is-running{--c:var(--subtle)}.count.is-waiting{--c:var(--muted)}
.count .icon{flex:none;width:34px;height:34px;border-radius:9px;background:var(--c);display:flex;align-items:center;justify-content:center}
.count .icon svg{width:18px;height:18px;fill:none;stroke:#fff;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round}
.count b{display:block;font-size:26px;line-height:1;letter-spacing:-0.03em;color:var(--ink);font-variant-numeric:tabular-nums}
.count small{display:block;margin-top:3px;font-size:12.5px;color:var(--muted)}
.count:hover{transform:translate(-1px,-1px);box-shadow:2px 2px 0 var(--c)}
main:has(#filter-all:checked) label[for=filter-all],main:has(#filter-failed:checked) label[for=filter-failed],main:has(#filter-known:checked) label[for=filter-known],main:has(#filter-flaky:checked) label[for=filter-flaky],main:has(#filter-running:checked) label[for=filter-running],main:has(#filter-waiting:checked) label[for=filter-waiting],main:has(#filter-passed:checked) label[for=filter-passed]{transform:translate(-2px,-2px);box-shadow:4px 4px 0 var(--c)}
.filter-input:focus-visible+.count{outline:2px solid var(--c);outline-offset:3px}
.count.zero{--c:var(--strong);border-width:1px;padding:11px 17px 11px 13px;cursor:default}
.count.zero:hover{transform:none;box-shadow:none}
.count.zero .icon{background:var(--soft)}.count.zero .icon svg{stroke:var(--subtle)}.count.zero b{color:var(--subtle)}
main:has(#filter-failed:checked) .spec:not(.is-failed),main:has(#filter-failed:checked) .feature:not(.has-failed){display:none}
main:has(#filter-known:checked) .spec:not(.is-known),main:has(#filter-known:checked) .feature:not(.has-known){display:none}
main:has(#filter-flaky:checked) .spec:not(.is-flaky),main:has(#filter-flaky:checked) .feature:not(.has-flaky){display:none}
main:has(#filter-running:checked) .spec:not(.is-running),main:has(#filter-running:checked) .feature:not(.has-running){display:none}
main:has(#filter-waiting:checked) .spec:not(.is-waiting),main:has(#filter-waiting:checked) .feature:not(.has-waiting){display:none}
main:has(#filter-passed:checked) .spec:not(.is-passed),main:has(#filter-passed:checked) .feature:not(.has-passed){display:none}
.feature{margin:0 8px 34px 0}
.feature-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;margin:0 0 12px}
.feature-head h2{margin:0;font-size:19px;letter-spacing:-.02em}
.feature-count{font-size:13px;color:var(--muted)}
.tallies{margin-left:auto;display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12.5px;color:var(--muted)}
.tally{display:inline-flex;align-items:center;gap:6px}.tally i{width:8px;height:8px;border-radius:2px;background:var(--c)}
.tally.is-passed{--c:var(--success)}.tally.is-failed{--c:var(--danger)}.tally.is-flaky{--c:var(--warning)}.tally.is-known{--c:var(--muted)}.tally.is-running{--c:var(--subtle)}.tally.is-waiting{--c:var(--muted)}
.feature-sheet{border:1px solid var(--strong);border-radius:12px;background:var(--surface);box-shadow:4px 4px 0 -1px var(--surface),4px 4px 0 0 var(--strong),8px 8px 0 -1px var(--surface),8px 8px 0 0 var(--strong);overflow:hidden}
.spec+.spec{border-top:1px solid var(--line)}
.spec>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:14px;padding:14px 18px}
.spec>summary:hover{background:var(--soft)}
.spec>summary::-webkit-details-marker{display:none}
.seal{flex:none;display:flex;width:32px;height:32px;border-radius:8px;align-items:center;justify-content:center;color:#fff}
.is-passed .seal{background:var(--success)}.is-failed .seal{background:var(--danger)}.is-flaky .seal{background:var(--warning)}.is-known .seal{background:var(--muted)}.is-running .seal{background:var(--subtle)}.is-waiting .seal{background:var(--muted)}
.seal svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:2.8;stroke-linecap:round;stroke-linejoin:round}
.heading{flex:1;min-width:0;display:flex;flex-direction:column}
.title{font-weight:600}
.path{font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.state{font-size:13px;font-weight:600}
.is-passed .state{color:var(--success)}.is-failed .state{color:var(--danger)}.is-flaky .state{color:#8a6a00}.is-waiting .state,.is-known .state,.is-running .state{color:var(--muted)}
.time{font-size:12px;color:var(--subtle);min-width:48px;text-align:right}
.body{border-top:1px solid var(--line);padding:6px 18px 18px;background:var(--surface)}
h3{font-size:13px;margin:18px 0 8px}
.bullets{margin:0;padding-left:18px}
.steps{list-style:none;margin:0;padding:0}
.steps li{display:flex;align-items:flex-start;gap:12px;padding:5px 0}
.num{flex:none;width:24px;height:24px;border:1px solid var(--strong);border-radius:6px;display:flex;align-items:center;justify-content:center;font:600 12px "Geist Mono",ui-monospace,monospace;color:var(--muted)}
.label{flex:1;padding-top:1px}

.mark svg{width:15px;height:15px;fill:none;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round;margin-top:4px}
.steps .passed .mark svg{stroke:var(--success)}.steps .failed .mark svg{stroke:var(--danger)}
.steps .failed .num{border-color:var(--danger);color:var(--danger)}
.dot{flex:none;width:24px;height:24px;display:flex;align-items:center;justify-content:center}
.dot::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--subtle)}
.steps .failed .dot::before{background:var(--danger)}
.steps .skipped{color:var(--subtle)}
.expected{border-top:1px solid var(--line);margin-top:16px}
.expected p{margin:0;font-weight:500;display:flex;gap:8px;align-items:flex-start}
.expected .mark svg{margin-top:5px}.expected.passed .mark svg{stroke:var(--success)}.expected.failed .mark svg{stroke:var(--danger)}
.proof{display:block;margin-top:12px;max-width:560px}
.proof img{display:block;width:100%;border:1px solid var(--strong);border-radius:8px}
.failure{border:1px solid var(--danger);background:var(--danger-soft);border-radius:10px;padding:2px 14px 12px;margin-top:16px}
.failure h3{color:var(--danger)}
.failure-wait{margin:0 0 8px;font-size:13px;font-weight:500}
.failure pre{margin:0;white-space:pre-wrap;word-break:break-word;font-size:12px;max-height:280px;overflow:auto}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px}
figure{margin:0}
figure img{width:100%;border:1px solid var(--strong);border-radius:8px;display:block}
figcaption{font-size:12px;color:var(--muted);margin-top:6px}
.zoom,.proof{display:block;cursor:pointer}
.zoom img,.proof img{transition:border-color .12s ease}
.zoom:hover img,.proof:hover img{border-color:var(--muted)}
.close{display:none}
figure:target,figure.is-zoomed{position:fixed;inset:0;z-index:10;margin:0;padding:24px;background:rgb(20 20 20/.88);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px}
figure:target .zoom,figure.is-zoomed .zoom{cursor:default;position:relative;z-index:1}
figure:target img,figure.is-zoomed img{width:auto;max-width:min(1400px,100%);max-height:calc(100vh - 80px);border-color:#444}
figure:target figcaption,figure.is-zoomed figcaption{color:#e6e6e6;position:relative;z-index:1}
figure:target figcaption b,figure.is-zoomed figcaption b{color:#fff}
figure:target .close,figure.is-zoomed .close{display:block;position:absolute;inset:0;cursor:pointer}
.recording{width:100%;max-width:720px;border:1px solid var(--strong);border-radius:8px;display:block;background:#000}
.step-seek{font:inherit;text-align:left;line-height:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer;border-radius:3px}
.step-seek:hover{text-decoration:underline;text-underline-offset:3px}.step-seek:focus-visible,.zoom:focus-visible{outline:2px solid var(--primary);outline-offset:3px}
.step-seek.is-current{font-weight:600}.zoom.is-current img{border:2px solid var(--primary)}
.visuals{display:flex;flex-direction:column;gap:18px}
.replay,.screenshot-section{min-width:0}.screenshot-section .shots{display:flex;overflow-x:auto;padding:2px 2px 8px;scroll-snap-type:x proximity}.screenshot-section .shots figure{flex:0 0 220px;scroll-snap-align:start}
.replay-player{width:100%;min-height:180px}.replay-status,.replay-note{font-size:12px;color:var(--muted)}
.replay .rr-player{float:none;border:1px solid var(--strong);border-radius:8px;box-shadow:none;overflow:hidden;font-family:inherit}
.replay .rr-controller{font-family:inherit;background:var(--surface)}.replay .rr-player .rr-timeline{width:100%;padding:0 10px}
.replay .rr-player .rr-timeline__time{font-size:12px;width:62px;color:var(--muted);font-variant-numeric:tabular-nums}
.replay .rr-progress{touch-action:none;cursor:pointer}.replay .rr-progress__handler{background:var(--primary);cursor:grab}.replay .rr-progress.is-dragging,.replay .rr-progress.is-dragging .rr-progress__handler{cursor:grabbing}.replay .rr-progress__step{background:var(--strong)}
.replay{position:relative}.replay-tip{position:absolute;z-index:5;transform:translateX(-50%);max-width:280px;padding:4px 8px;border-radius:6px;background:var(--primary);color:#fff;font-size:12px;font-weight:500;line-height:1.5;pointer-events:none;white-space:normal}.replay-tip b{font-weight:700}.replay-tip span{display:block;font-size:11px;opacity:.8}.replay-tip .replay-tip-failed{color:#ffb3ad;opacity:1}.replay-tip::after{content:"";position:absolute;left:50%;top:100%;transform:translateX(-50%);border:5px solid transparent;border-top-color:var(--primary)}
.replay-wait{position:absolute;top:-4px;bottom:-4px;background:var(--danger-soft);border-inline:1px solid var(--danger);pointer-events:none}.replay .rr-progress__handler{z-index:1}
.replay .rr-player .rr-controller__btns{font-size:12px;gap:2px}.replay .rr-player .rr-controller__btns button{width:28px;height:28px;font:inherit}
.replay .rr-player .rr-controller__btns button.active{background:var(--primary)}.replay .rr-player .rr-controller__btns button:hover{background:var(--soft);color:var(--ink)}
.replay .rr-controller__btns button:focus-visible,.replay .rr-progress:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
.replay .switch label::before{background:var(--strong)}.replay .switch input:checked+label::before{background:var(--primary)}
.replay .rr-player .switch .label{flex:none;padding:0;margin:0 6px}
@media(max-width:760px){.visuals{grid-template-columns:1fr}.screenshot-section .shots figure{flex-basis:170px}.wrap{padding-left:16px;padding-right:16px}.body{padding-left:12px;padding-right:12px}}
footer.wrap{color:var(--subtle);font-size:12px;padding-bottom:40px}
`;

function renderFeature(name: string, entries: ReportSection[], single: boolean): string {
    const tones = TONES.filter(({ tone }) => entries.some((entry) => entry.tone === tone));
    const summary = tones.map(({ tone, tally }) => `<span class="tally is-${tone}"><i></i>${tally(entries.filter((entry) => entry.tone === tone).length)}</span>`).join("");
    return `<section class="feature ${tones.map(({ tone }) => `has-${tone}`).join(" ")}">
  <div class="feature-head"><h2>${escape(name)}</h2><span class="feature-count">${entries.length} Spec${entries.length === 1 ? "" : "s"}</span><span class="tallies">${summary}</span></div>
  <div class="feature-sheet">${entries.map((entry) => renderSection(entry, single, single)).join("\n")}</div>
</section>`;
}

export interface HtmlReportData {
    project?: string;
    startedAt: string;
    durationMs: number | null;
    environment?: { name: string } | null;
    ci?: { commitSha?: string; ref?: string; buildUrl?: string } | null;
    qualityGate: { passed: boolean; failures: number };
    sections: ReportSection[];
}

export async function renderHtmlReport(data: HtmlReportData, options: { single?: boolean } = {}): Promise<string> {
    const batch = data;
    const sections = data.sections;
    const hasReplay = sections.some((section) => section.replay);
    const playerScript = hasReplay ? gzipSync(await publicAsset("rrweb-player.js"), { level: 9 }).toString("base64") : "";
    const playerColors: Record<string, string> = { "#4950f680": "var(--strong)", "#4950f600": "transparent", "#4950f6": "var(--primary)", "#e0e1fe": "var(--strong)", "#11103e": "var(--muted)", "#fcfff4": "var(--surface)" };
    const playerStyle = hasReplay ? (await publicAsset("rrweb-player.css")).replace(/#(?:4950f680|4950f600|4950f6|e0e1fe|11103e|fcfff4)\b/gi, (color) => playerColors[color.toLowerCase()]) : "";
    const inlineScript = (script: string) => script.replace(/<\/script/gi, "<\\/script");
    const results = sections.map((section) => section.item);
    const byFeature = new Map<string, ReportSection[]>();
    for (const entry of sections) byFeature.set(entry.feature, [...(byFeature.get(entry.feature) ?? []), entry]);
    const groups = [...byFeature].map(([name, entries]) => ({
        name, entries: entries.sort((a, b) => RANK[a.tone] - RANK[b.tone] || a.item.title.localeCompare(b.item.title)),
        rank: Math.min(...entries.map((entry) => RANK[entry.tone])),
    })).sort((a, b) => a.rank - b.rank || Number(a.name === "Other Specs") - Number(b.name === "Other Specs") || a.name.localeCompare(b.name));
    const total = results.length;
    const passed = results.filter((item) => item.status === "passed").length;
    const tally = (tone: Tone) => sections.filter((entry) => entry.tone === tone).length;
    const ci = batch.ci;
    const elapsed = batch.durationMs;
    const verdict = data.qualityGate.passed ? "passed" : "failed";
    const project = data.project ?? "";
    const heading = options.single && results[0] ? results[0].title : `${passed} of ${total} Spec${total === 1 ? "" : "s"} passed`;
    const meta = [
        `<span class="verdict ${verdict}"><b>${verdict === "passed" ? "Quality gate passed" : `Quality gate failed · ${data.qualityGate.failures} failure${data.qualityGate.failures === 1 ? "" : "s"}`}</b></span>`,
        batch.environment?.name ? `<span>Environment <b>${escape(batch.environment.name)}</b></span>` : "",
        `<span>${escape(new Date(batch.startedAt).toUTCString())}</span>`,
        elapsed != null ? `<span class="mono">${escape(duration(elapsed))}</span>` : "",
        ci?.commitSha ? `<span class="mono">${escape(ci.commitSha.slice(0, 7))}</span>` : "",
        ci?.ref ? `<span class="mono">${escape(ci.ref)}</span>` : "",
        ci?.buildUrl ? `<a href="${escape(ci.buildUrl)}">Build</a>` : "",
    ].filter(Boolean).join("");
    const filters = options.single ? "" : `<div class="filters" role="radiogroup" aria-label="Filter Specs by status">
    ${filter("all", "All Specs", total, true)}
    ${TONES.filter(({ tone }) => !(["running", "waiting"].includes(tone)) || tally(tone) > 0).map(({ tone, label }) => filter(tone, label, tally(tone), false)).join("\n    ")}
  </div>`;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; frame-src 'self' about:; connect-src 'none'">
<title>${escape([...new Set([heading, project, "Specbook"].filter(Boolean))].join(" · "))}</title>${await favicon()}<style>${await fonts()}${playerStyle}${STYLE}</style></head>
<body>
<header><div class="wrap top">
  <div class="brand">${await logo()}specbook</div>
  ${project ? `<p class="kicker mono">${escape(project)}</p>` : ""}
  <h1>${escape(heading)}</h1>
  <div class="meta">${meta}</div>
</div></header>
<main class="wrap">
  ${filters}
  ${groups.map((group) => renderFeature(group.name, group.entries, Boolean(options.single))).join("\n")}
</main>
<footer class="wrap">Generated by Specbook.</footer>
<script>${inlineScript(ZOOM_SCRIPT)}</script>
${hasReplay ? `<script id="specbook-replay-library" type="application/octet-stream">${playerScript}</script><script>${inlineScript(REPORT_REPLAY_SCRIPT)}</script>` : ""}
</body></html>`;
}
