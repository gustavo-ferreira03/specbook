import { specErrorCode } from "../errors.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { expect as baseExpect, test as base, type ConsoleMessage, type Page, type Request, type Response } from "@playwright/test";
import type { RunDiagnostic } from "../evidence.ts";
import { MAX_REPLAY_EVENTS, MAX_REPLAY_RAW_BYTES, REPLAY_ATTACHMENT, REPLAY_LIMIT_NOTE, REPLAY_UNAVAILABLE_ATTACHMENT, readRecorderSource, type ReplayEvent } from "../replay.ts";
import type { ExecutionStepKind } from "../types.ts";
import { captureStepScreenshot } from "./screenshot.ts";
import { withEvidenceTimeout } from "./evidence-timeout.ts";
import {
    createGuard,
    createSecret,
    API_STEP_ATTACHMENT_PREFIX,
    FAILED_STEP_ANNOTATION,
    hardenFunctionConstructors,
    parseRuntime,
    RUNTIME_ENV,
    settleStrict,
    STEP_ATTACHMENT_PREFIX,
    unwrap,
    type RawPage,
    type ApiRequestEvidence,
} from "./guard.ts";

type StepFn = (title: string, body: () => Promise<void>) => Promise<void>;
type SecretFn = (profile: string, field: string) => object;
type CleanupFn = (body: () => Promise<void>) => Promise<void>;
type EvidenceState = { page?: Page; apiRequests: ApiRequestEvidence[]; replay?: ReplayCapture };

hardenFunctionConstructors();

const runtime = parseRuntime(process.env[RUNTIME_ENV]);
const CLEANUP_BUDGET_MS = 5000;
const guard = createGuard({ runtime, readSecret: (name) => process.env[name] });

const secretValues = [...new Set(Object.entries(process.env)
    .filter(([name, value]) => name.startsWith("SPECBOOK_SECRET_") && value)
    .map(([, value]) => value!))];

const secretVariants = [...new Set(secretValues.flatMap((value) => {
    const escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1), escaped,
        escaped.replace(/"/g, "&quot;").replace(/'/g, "&#39;"), escaped.replace(/"/g, "&quot;").replace(/'/g, "&#x27;")];
}))].sort((left, right) => right.length - left.length);

function scrubReplay(text: string): string {
    return secretVariants.reduce((safe, value) => value ? safe.split(value).join("[REDACTED]") : safe, text);
}

class ReplayCapture {
    private events: string[] = [];
    private bytes = 2;
    private stopped = false;
    unavailable: string | undefined;

    receive(event: ReplayEvent): void {
        if (this.stopped || this.unavailable) return;
        try {
            const value = JSON.stringify(event, (_key, value) => {
                if (typeof value === "string") return scrubReplay(value);
                if (value && typeof value === "object" && !Array.isArray(value)) {
                    return Object.fromEntries(Object.entries(value).map(([key, item]) => [scrubReplay(key), item]));
                }
                return value;
            });
            const size = Buffer.byteLength(value) + 1;
            if (this.bytes + size > MAX_REPLAY_RAW_BYTES || this.events.length >= MAX_REPLAY_EVENTS) {
                this.unavailable = REPLAY_LIMIT_NOTE;
                this.events = [];
                return;
            }
            this.bytes += size;
            this.events.push(value);
        } catch {
            this.unavailable = "Replay could not be recorded.";
            this.events = [];
        }
    }

    marker(number: number, title: string, kind: ExecutionStepKind, phase: "start" | "end", outcome: "running" | "passed" | "failed"): void {
        this.receive({ type: 5, timestamp: Date.now(), data: { tag: "specbook-step", payload: { number, title, kind, phase, outcome } } });
    }

    stop(): void { this.stopped = true; }

    serialized(): string { return `[${this.events.join(",")}]`; }
}

async function startReplay(page: Page, replay: ReplayCapture): Promise<void> {
    const binding = "__specbookReplayEvent";
    await page.exposeBinding(binding, ({ frame }, event: ReplayEvent) => {
        if (frame === page.mainFrame()) replay.receive(event);
    });
    const content = `${await readRecorderSource()}\n;(${function () {
        if (window !== window.top) return;
        const target = globalThis as unknown as {
            rrweb: { record: (options: Record<string, unknown>) => (() => void) | undefined };
            __specbookReplayEvent: (event: unknown) => Promise<void>;
            __specbookStopReplay?: () => Promise<void>;
        };
        const pending = new Set<Promise<void>>();
        const stop = target.rrweb.record({
            emit: (event: unknown) => {
                const delivered = target.__specbookReplayEvent(event).catch(() => undefined);
                pending.add(delivered);
                void delivered.finally(() => pending.delete(delivered));
            },
            maskAllInputs: true,
            blockClass: "__specbookSecret",
            blockSelector: "[data-specbook-secret]",
            maskTextClass: "__specbookSecret",
            recordCrossOriginIframes: false,
            recordCanvas: false,
            inlineStylesheet: true,
            inlineImages: true,
            dataURLOptions: { type: "image/webp", quality: 0.8 },
            collectFonts: false,
        });
        target.__specbookStopReplay = async () => {
            stop?.();
            await Promise.all(pending);
        };
    }.toString()})();`;
    await page.addInitScript({ content });
    await page.evaluate(content);
}

async function stopReplay(page: Page, replay: ReplayCapture): Promise<void> {
    await withEvidenceTimeout(() => page.evaluate(() => (globalThis as unknown as { __specbookStopReplay?: () => Promise<void> }).__specbookStopReplay?.()), 1000).catch(() => undefined);
    replay.stop();
}

function diagnosticUrl(value: string): string | undefined {
    try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
        return `${url.origin}${url.pathname}`.slice(0, 2000);
    } catch {
        return undefined;
    }
}

export const test = base.extend<{ step: StepFn; secret: SecretFn; cleanup: CleanupFn; _specbookEvidence: EvidenceState }>({
    _specbookEvidence: async ({}, use) => { await use({ apiRequests: [] }); },
    request: async ({ request, _specbookEvidence }, use) => {
        await use(guard.wrapRequest(request, (evidence) => {
            if (_specbookEvidence.apiRequests.length < 30) _specbookEvidence.apiRequests.push(evidence);
        }) as never);
    },
    page: async ({ page, _specbookEvidence }, use, testInfo) => {
        _specbookEvidence.page = page;
        const replay = _specbookEvidence.replay = new ReplayCapture();
        try { await startReplay(page, replay); }
        catch { replay.unavailable = "Replay could not be recorded."; }
        const navigation = runtime.navigationOrigins ? await page.context().newCDPSession(page) : null;
        if (navigation) {
            navigation.on("Fetch.requestPaused", (event) => {
                const allowed = runtime.navigationOrigins!.includes(new URL(event.request.url).origin);
                void navigation.send(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", {
                    requestId: event.requestId, ...(allowed ? {} : { errorReason: "BlockedByClient" }),
                }).catch(() => undefined);
            });
            await navigation.send("Fetch.enable", { patterns: [{ resourceType: "Document", requestStage: "Request" }] });
        }
        const diagnostics: RunDiagnostic[] = [];
        const capture = (item: RunDiagnostic) => {
            if (diagnostics.length < 100) diagnostics.push({ ...item, message: item.message.slice(0, 2000) });
        };
        const onConsole = (message: ConsoleMessage) => {
            if (message.type() === "error") capture({ kind: "console", message: message.text(), url: diagnosticUrl(message.location().url) });
        };
        const onPageError = (error: Error) => capture({ kind: "pageerror", message: error.message });
        const onRequestFailed = (request: Request) => capture({
            kind: "requestfailed", message: request.failure()?.errorText ?? "Request failed",
            url: diagnosticUrl(request.url()), method: request.method(),
        });
        const onResponse = (response: Response) => {
            if (response.status() >= 400) capture({
                kind: "response", message: response.statusText(), status: response.status(),
                url: diagnosticUrl(response.url()), method: response.request().method(),
            });
        };
        page.on("console", onConsole);
        page.on("pageerror", onPageError);
        page.on("requestfailed", onRequestFailed);
        page.on("response", onResponse);
        try {
            await use(guard.wrapPage(page as unknown as RawPage) as never);
        } finally {
            await stopReplay(page, replay);
            if (replay.unavailable) {
                const file = testInfo.outputPath("specbook-replay-unavailable.txt");
                await fs.writeFile(file, replay.unavailable, "utf8");
                await testInfo.attach(REPLAY_UNAVAILABLE_ATTACHMENT, { path: file, contentType: "text/plain" });
            } else {
                const file = testInfo.outputPath("specbook-replay.json");
                await fs.writeFile(file, replay.serialized(), "utf8");
                await testInfo.attach(REPLAY_ATTACHMENT, { path: file, contentType: "application/json" });
            }
            if (navigation) await withEvidenceTimeout(() => navigation.detach(), 1000).catch(() => undefined);
            page.off("console", onConsole);
            page.off("pageerror", onPageError);
            page.off("requestfailed", onRequestFailed);
            page.off("response", onResponse);
            if (diagnostics.length > 0) {
                const file = testInfo.outputPath("specbook-diagnostics.json");
                await fs.writeFile(file, JSON.stringify(diagnostics), "utf8");
                await testInfo.attach("specbook-diagnostics", { path: file, contentType: "application/json" });
            }
        }
    },
    step: async ({ _specbookEvidence }, use, testInfo) => {
        let count = 0;
        let active = false;
        await use(async (title, body) => {
            if (typeof title !== "string" || !title.trim()) throw new Error("step() needs a title");
            if (typeof body !== "function") throw new Error("step() needs an async function");
            if (active) throw new Error("Steps cannot be nested");
            active = true;
            count += 1;
            const number = String(count).padStart(2, "0");
            _specbookEvidence.apiRequests = [];
            const real = _specbookEvidence.page;
            const replay = _specbookEvidence.replay;
            const kind = runtime.executionPlans?.[path.basename(testInfo.file)]?.[count - 1]?.kind ?? "step";
            let outcome: "passed" | "failed" = "passed";
            replay?.marker(count, title, kind, "start", "running");
            try {
                await base.step(title, async () => {
                    await body();
                });
            } catch (error) {
                outcome = "failed";
                testInfo.annotations.push({ type: FAILED_STEP_ANNOTATION, description: title });
                testInfo.annotations.push({ type: "specbook-error-code", description: specErrorCode(error) });
                try {
                    if (!real) throw new Error("This step has no browser page");
                    const snapshot = await real.locator("body").ariaSnapshot({ timeout: 2000 });
                    const file = testInfo.outputPath("specbook-error-context.txt");
                    await fs.writeFile(file, snapshot.slice(0, 32_000), "utf8");
                    await testInfo.attach("specbook-error-context", { path: file, contentType: "text/plain" });
                } catch {}
                throw error;
            } finally {
                active = false;
                const requests = _specbookEvidence.apiRequests;
                if (requests.length > 0) {
                    const file = testInfo.outputPath(`${API_STEP_ATTACHMENT_PREFIX}${number}.json`);
                    await fs.writeFile(file, JSON.stringify(requests), "utf8");
                    await testInfo.attach(`${API_STEP_ATTACHMENT_PREFIX}${number}`, { path: file, contentType: "application/json" });
                }
                const file = testInfo.outputPath(`${STEP_ATTACHMENT_PREFIX}${number}`);
                try {
                    if (!real) throw new Error("This step has no browser page");
                    const image = await captureStepScreenshot(real, file, secretValues);
                    await testInfo.attach(`${STEP_ATTACHMENT_PREFIX}${number}`, { path: image.file, contentType: image.contentType });
                } catch {}
                if (real && replay && !replay.unavailable) {
                    // A loaded image can arrive after its first DOM snapshot.
                    await withEvidenceTimeout(() => real.evaluate(() => (globalThis as unknown as { rrweb?: { record: { takeFullSnapshot: () => void } } }).rrweb?.record.takeFullSnapshot()), 1000).catch(() => undefined);
                }
                replay?.marker(count, title, kind, "end", outcome);
            }
        });
    },
    secret: async ({}, use) => {
        await use((profile, field) => createSecret(profile, field));
    },
    // Hidden teardown that resets data the Spec created: it runs after the test even when a step failed,
    // records no evidence and never changes the result. Depending on page and request keeps both open until it ends.
    cleanup: async ({ page: _page, request: _request, _specbookEvidence }, use, testInfo) => {
        let registered: (() => Promise<void>) | undefined;
        await use(async (body) => {
            if (typeof body !== "function") throw new Error("cleanup() needs an async function");
            registered = body;
        });
        if (!registered) return;
        if (_specbookEvidence.page && _specbookEvidence.replay) await stopReplay(_specbookEvidence.page, _specbookEvidence.replay);
        testInfo.setTimeout(testInfo.timeout + CLEANUP_BUDGET_MS + 1000);
        let timer: NodeJS.Timeout | undefined;
        try {
            await Promise.race([
                Promise.resolve().then(registered).catch(() => undefined),
                new Promise<void>((resolve) => { timer = setTimeout(resolve, CLEANUP_BUDGET_MS); }),
            ]);
        } finally { clearTimeout(timer); }
    },
});

function settlingMatchers<T extends object>(matchers: T): T {
    return new Proxy(matchers, {
        get(target, key, receiver) {
            const value = Reflect.get(target, key, receiver);
            if (key === "not" && value && typeof value === "object") return settlingMatchers(value as object);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => settleStrict(() => Promise.resolve((value as (...a: unknown[]) => unknown).apply(target, args)));
        },
    });
}

export function expect(target: unknown, ...rest: unknown[]) {
    if (rest.length > 0) throw new Error("expect() takes one page, locator or API response value");
    const locator = unwrap(target, ["locator"]);
    if (locator) return settlingMatchers(baseExpect(locator as never));
    const real = unwrap(target, ["page", "apiResponse"]);
    if (real) return baseExpect(real as never);
    if (target === null || ["string", "number", "boolean"].includes(typeof target) || Array.isArray(target) || (typeof target === "object" && target !== null && [Object.prototype, null].includes(Object.getPrototypeOf(target)))) {
        return baseExpect(target as never);
    }
    throw new Error("expect() takes the page, a locator or an API response value");
}
