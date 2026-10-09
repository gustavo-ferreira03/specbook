import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { getActiveTabUrl, type BrowserMcp } from "../browser/mcp";
import { DESTRUCTIVE_CLICK_PATTERN } from "./discovery-policy";

const scanPageSchema = z.object({}).strict();
const require = createRequire(import.meta.url);
let axeSource: Promise<string> | undefined;

interface ExplorationToolOptions {
    baseUrl: string;
    mcp: BrowserMcp | null;
    scrub: (value: string) => Promise<string>;
    recordEvidence?: (json: string) => Promise<string | undefined>;
}

function resultText(result: Record<string, unknown>): string {
    return (Array.isArray(result.content) ? result.content : [])
        .filter((item): item is { type: "text"; text: string } => item?.type === "text" && typeof item.text === "string")
        .map((item) => item.text).join("\n");
}

function evaluationResult(result: Record<string, unknown>): unknown {
    const text = resultText(result);
    if (result.isError || text.startsWith("### Error")) throw new Error(text.slice(0, 1000));
    const section = text.match(/(?:^|\n)### Result\n([\s\S]*?)(?=\n### |$)/)?.[1] ?? text;
    try { return JSON.parse(section.trim()); }
    catch { throw new Error("The browser did not return a page scan result"); }
}

function redactUrls(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redactUrls);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactUrls(item)]));
    if (typeof value !== "string") return value;
    return value.replace(/https?:\/\/[^\s"'<>]+/g, (value) => {
        try {
            const url = new URL(value);
            url.username = "";
            url.password = "";
            for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "[redacted]");
            url.hash = "";
            return url.toString();
        } catch { return "[invalid URL]"; }
    });
}

export async function scanPage(options: ExplorationToolOptions, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (!options.mcp) throw new Error("The agent browser is unavailable. Ask for help through the Inbox if it cannot be started.");
    const mcp = options.mcp;
    const start = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(start.protocol)) throw new Error("Page scans require an HTTP or HTTPS project URL");
    const origin = start.origin;
    const checkOrigin = async () => {
        signal?.throwIfAborted();
        const active = await getActiveTabUrl(mcp, signal);
        signal?.throwIfAborted();
        if (!active || new URL(active).origin !== origin) throw new Error(`Navigate within the project origin ${origin} before scanning.`);
    };
    await mcp.ensureBrowser(signal);
    await checkOrigin();
    axeSource ??= fs.readFile(require.resolve("axe-core/axe.min.js"), "utf8");
    const code = `async () => {
        const origin = ${JSON.stringify(origin)};
        if (location.origin !== origin) throw new Error("Page left the project origin");
        const destructive = new RegExp(${JSON.stringify(DESTRUCTIVE_CLICK_PATTERN.source)}, "i");
        const links = [];
        const seen = new Set();
        let skippedLinks = 0;
        for (const anchor of Array.from(document.querySelectorAll("a[href]")).slice(0, 200)) {
            try {
                const url = new URL(anchor.href, location.href);
                url.hash = "";
                const label = (anchor.textContent || "").trim().slice(0, 160);
                let decoded = url.pathname + url.search;
                for (let n = 0; n < 2; n++) decoded = decodeURIComponent(decoded.replaceAll("+", " "));
                if (url.href.length > 2048 || url.origin !== origin || !/^https?:$/.test(url.protocol) || url.username || url.password || destructive.test(decoded + " " + label) || seen.has(url.href) || links.length >= 20) { skippedLinks++; continue; }
                seen.add(url.href);
                links.push({ url: url.href, label });
            } catch { skippedLinks++; }
        }
        let accessibility;
        let accessibilityTimeout;
        try {
            ${await axeSource}
            const result = await Promise.race([
                window.axe.run(document, { iframes: false, preload: false, resultTypes: ["violations"] }),
                new Promise((_, reject) => { accessibilityTimeout = setTimeout(() => reject(new Error("Accessibility scan timed out")), 8000); })
            ]);
            accessibility = { violations: result.violations.slice(0, 15).map(v => ({
                id: v.id, impact: v.impact, description: v.description, help: v.help, helpUrl: v.helpUrl,
                nodes: v.nodes.slice(0, 3).map(n => ({ target: n.target.map(t => String(t).slice(0, 300)), failureSummary: (n.failureSummary || "").slice(0, 600) }))
            })), total: result.violations.length };
        } catch (error) { accessibility = { error: String(error).slice(0, 300) }; }
        finally { clearTimeout(accessibilityTimeout); }
        if (location.origin !== origin) throw new Error("Page left the project origin");
        const checks = await Promise.all(links.map(async link => {
            try {
                const response = await fetch(link.url, { method: "HEAD", credentials: "same-origin", redirect: "manual", signal: AbortSignal.timeout(2000) });
                return { ...link, status: response.status, result: response.status === 405 || response.status === 501 ? "head_unsupported" : response.type === "opaqueredirect" || response.status >= 300 && response.status < 400 ? "redirect_not_followed" : response.status >= 400 ? "broken" : "ok" };
            } catch { return { ...link, result: "unreachable" }; }
        }));
        if (location.origin !== origin) throw new Error("Page left the project origin");
        return { url: location.href, title: document.title.slice(0, 200), accessibility, links: checks, skippedLinks };
    }`;
    signal?.throwIfAborted();
    const scan = evaluationResult(await mcp.client.callTool({ name: "browser_evaluate", arguments: { function: code } }, undefined, { signal }));
    await checkOrigin();
    const [consoleResult, networkResult] = await Promise.allSettled([
        mcp.client.callTool({ name: "browser_console_messages", arguments: { level: "error" } }, undefined, { signal }),
        mcp.client.callTool({ name: "browser_network_requests", arguments: {} }, undefined, { signal }),
    ]);
    signal?.throwIfAborted();
    for (const result of [consoleResult, networkResult]) {
        if (result.status === "rejected" && result.reason instanceof Error && result.reason.name === "AbortError") throw result.reason;
    }
    await checkOrigin();
    const consoleErrors = consoleResult.status === "fulfilled"
        ? resultText(consoleResult.value).split("\n").filter((line) => /\[ERROR\]|\[PAGEERROR\]|^Error:/.test(line)).slice(0, 30).map((line) => line.slice(0, 500))
        : ["Console diagnostics unavailable"];
    const networkFailures = networkResult.status === "fulfilled"
        ? resultText(networkResult.value).split("\n").filter((line) => /=> \[(?:[45]\d\d|FAILED)\]/.test(line)).slice(0, 30).map((line) => line.slice(0, 500))
        : ["Network diagnostics unavailable"];
    const json = await options.scrub(JSON.stringify(redactUrls({ capturedAt: new Date().toISOString(), scan, consoleErrors, networkFailures,
        limitations: "Rendered main document only. Up to 20 safe same-origin links checked with HEAD; redirects and destructive links are skipped. HEAD unsupported is not a broken link. Confirm a finding before reporting it." })));
    signal?.throwIfAborted();
    const evidenceUrl = await options.recordEvidence?.(json);
    signal?.throwIfAborted();
    return JSON.stringify({ evidenceUrl, evidence: JSON.parse(json) });
}

const inspectElementSchema = z.object({
    target: z.string().trim().min(1).max(500).describe("Element reference from the latest browser_snapshot (like e43) or a unique CSS selector (like [data-shape-type='arrow'])"),
}).strict();

const INSPECT_ELEMENT = `(element) => {
    const clean = (node) => {
        const copy = node.cloneNode(true);
        for (const field of [copy, ...copy.querySelectorAll("*")]) {
            field.removeAttribute("value");
            if (field.matches("input, textarea, select")) field.textContent = "";
        }
        return copy;
    };
    const openingTag = (node) => clean(node.cloneNode(false)).outerHTML.replace(/<\\/[^>]+>$/, "").slice(0, 600);
    const ancestors = [];
    for (let node = element.parentElement; node && ancestors.length < 4; node = node.parentElement) ancestors.push(openingTag(node));
    const style = getComputedStyle(element);
    return JSON.stringify({
        html: clean(element).outerHTML.slice(0, 6000),
        ancestors,
        computed: { color: style.color, backgroundColor: style.backgroundColor, fill: style.fill, stroke: style.stroke },
    });
}`;

export function createExplorationTools(options: ExplorationToolOptions) {
    return [defineTool({
        name: "inspect_element", label: "inspect_element",
        description: "Read one element's HTML, its parent chain and its computed colors on the current project page. Use it before writing any assertion on an attribute, CSS selector or color, since browser_snapshot shows only the accessibility tree. Read-only; form values are removed.",
        parameters: Type.Unsafe<z.infer<typeof inspectElementSchema>>(inspectElementSchema.toJSONSchema()),
        async execute(_id, input, signal) {
            const { target } = inspectElementSchema.parse(input);
            if (!options.mcp) throw new Error("The agent browser is unavailable.");
            const active = await getActiveTabUrl(options.mcp, signal);
            if (!active || new URL(active).origin !== new URL(options.baseUrl).origin) throw new Error("Navigate within the project origin before inspecting elements.");
            const result = await options.mcp.client.callTool({ name: "browser_evaluate", arguments: { element: "Element to inspect", target, function: INSPECT_ELEMENT } }, undefined, { signal });
            const value = evaluationResult(result);
            return { content: [{ type: "text" as const, text: await options.scrub(String(redactUrls(typeof value === "string" ? value : JSON.stringify(value)))) }], details: undefined };
        },
    }), defineTool({
        name: "scan_page", label: "scan_page",
        description: "Inspect the current project page for axe accessibility violations, console errors, failed HTTP requests, and broken links. Read-only, same-origin, bounded checks. Use the evidence with precise reproduction steps in an Inbox bug report; confirm findings before reporting them.",
        parameters: Type.Unsafe<z.infer<typeof scanPageSchema>>(scanPageSchema.toJSONSchema()),
        async execute(_id, input, signal) {
            signal?.throwIfAborted();
            scanPageSchema.parse(input);
            try {
                return { content: [{ type: "text" as const, text: await scanPage(options, signal) }], details: undefined };
            } catch (error) {
                signal?.throwIfAborted();
                if (error instanceof Error && error.name === "AbortError") throw error;
                const message = await options.scrub(String(redactUrls(error instanceof Error ? error.message : String(error))));
                signal?.throwIfAborted();
                throw new Error(message);
            }
        },
    })];
}
