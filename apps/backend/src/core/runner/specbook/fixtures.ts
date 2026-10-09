import fs from "node:fs/promises";
import { expect as baseExpect, test as base, type ConsoleMessage, type Page, type Request, type Response } from "@playwright/test";
import type { RunDiagnostic } from "../evidence.ts";
import {
    createGuard,
    createSecret,
    API_STEP_ATTACHMENT_PREFIX,
    FAILED_STEP_ANNOTATION,
    hardenFunctionConstructors,
    parseRuntime,
    RUNTIME_ENV,
    STEP_ATTACHMENT_PREFIX,
    unwrap,
    type RawPage,
    type ApiRequestEvidence,
} from "./guard.ts";

type StepFn = (title: string, body: () => Promise<void>) => Promise<void>;
type SecretFn = (profile: string, field: string) => object;
type EvidenceState = { page?: Page; apiRequests: ApiRequestEvidence[] };

hardenFunctionConstructors();

const runtime = parseRuntime(process.env[RUNTIME_ENV]);
const guard = createGuard({ runtime, readSecret: (name) => process.env[name] });

function diagnosticUrl(value: string): string | undefined {
    try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
        return `${url.origin}${url.pathname}`.slice(0, 2000);
    } catch {
        return undefined;
    }
}

export const test = base.extend<{ step: StepFn; secret: SecretFn; _specbookEvidence: EvidenceState }>({
    _specbookEvidence: async ({}, use) => { await use({ apiRequests: [] }); },
    request: async ({ request, _specbookEvidence }, use) => {
        await use(guard.wrapRequest(request, (evidence) => {
            if (_specbookEvidence.apiRequests.length < 30) _specbookEvidence.apiRequests.push(evidence);
        }) as never);
    },
    page: async ({ page, _specbookEvidence }, use, testInfo) => {
        _specbookEvidence.page = page;
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
            await navigation?.detach().catch(() => undefined);
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
            try {
                await base.step(title, async () => {
                    await body();
                });
            } catch (error) {
                testInfo.annotations.push({ type: FAILED_STEP_ANNOTATION, description: title });
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
                const file = testInfo.outputPath(`${STEP_ATTACHMENT_PREFIX}${number}.png`);
                try {
                    if (!real) throw new Error("This step has no browser page");
                    await real.screenshot({ path: file, timeout: 5000 });
                    await testInfo.attach(`${STEP_ATTACHMENT_PREFIX}${number}`, { path: file, contentType: "image/png" });
                } catch {}
            }
        });
    },
    secret: async ({}, use) => {
        await use((profile, field) => createSecret(profile, field));
    },
});

export function expect(target: unknown, ...rest: unknown[]) {
    if (rest.length > 0) throw new Error("expect() takes one page, locator or API response value");
    const real = unwrap(target, ["page", "locator", "apiResponse"]);
    if (real) return baseExpect(real as never);
    if (target === null || ["string", "number", "boolean"].includes(typeof target) || Array.isArray(target) || (typeof target === "object" && target !== null && [Object.prototype, null].includes(Object.getPrototypeOf(target)))) {
        return baseExpect(target as never);
    }
    throw new Error("expect() takes the page, a locator or an API response value");
}
