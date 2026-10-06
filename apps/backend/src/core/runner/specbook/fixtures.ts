/**
 * The "specbook" module imported by every spec.ts. The runner rewrites the import to
 * point at this file (or at its bundle, dist/specbook-fixtures.mjs, in production).
 * It only runs inside the Playwright worker of a Spec run.
 */
import fs from "node:fs/promises";
import { expect as baseExpect, test as base, type ConsoleMessage, type Page, type Request, type Response } from "@playwright/test";
import type { RunDiagnostic } from "../evidence.ts";
import {
    createGuard,
    createSecret,
    FAILED_STEP_ANNOTATION,
    hardenFunctionConstructors,
    parseRuntime,
    RUNTIME_ENV,
    STEP_ATTACHMENT_PREFIX,
    unwrap,
    type RawPage,
} from "./guard.ts";

type StepFn = (title: string, body: () => Promise<void>) => Promise<void>;
type SecretFn = (profile: string, field: string) => object;

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

export const test = base.extend<{ step: StepFn; secret: SecretFn }>({
    page: async ({ page }, use, testInfo) => {
        const navigation = runtime.navigationOrigins ? await page.context().newCDPSession(page) : null;
        if (navigation) {
            navigation.on("Fetch.requestPaused", (event) => {
                const allowed = runtime.navigationOrigins!.includes(new URL(event.request.url).origin);
                void navigation.send(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", {
                    requestId: event.requestId, ...(allowed ? {} : { errorReason: "BlockedByClient" }),
                }).catch(() => undefined);
            });
            // Playwright routes only the first URL of an HTTP redirect chain.
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
    step: async ({ page }, use, testInfo) => {
        const real = unwrap<Page>(page, ["page"]);
        if (!real) throw new Error("Specbook page is not available");
        let count = 0;
        let active = false;
        await use(async (title, body) => {
            if (typeof title !== "string" || !title.trim()) throw new Error("step() needs a title");
            if (typeof body !== "function") throw new Error("step() needs an async function");
            if (active) throw new Error("Steps cannot be nested");
            active = true;
            count += 1;
            const number = String(count).padStart(2, "0");
            try {
                await base.step(title, async () => {
                    await body();
                });
            } catch (error) {
                testInfo.annotations.push({ type: FAILED_STEP_ANNOTATION, description: title });
                try {
                    const snapshot = await real.locator("body").ariaSnapshot({ timeout: 2000 });
                    const file = testInfo.outputPath("specbook-error-context.txt");
                    await fs.writeFile(file, snapshot.slice(0, 32_000), "utf8");
                    await testInfo.attach("specbook-error-context", { path: file, contentType: "text/plain" });
                } catch {}
                throw error;
            } finally {
                active = false;
                // Evidence: the page as it looks after the step (or where it failed).
                const file = testInfo.outputPath(`${STEP_ATTACHMENT_PREFIX}${number}.png`);
                try {
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

/** Playwright's expect, restricted to the Specbook page and its locators. */
export function expect(target: unknown, ...rest: unknown[]) {
    if (rest.length > 0) throw new Error("expect() takes only the page or a locator");
    const real = unwrap(target, ["page", "locator"]);
    if (!real) throw new Error("expect() takes only the page or a locator");
    return baseExpect(real as never);
}
