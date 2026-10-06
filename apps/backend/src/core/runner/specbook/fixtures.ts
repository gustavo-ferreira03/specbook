/**
 * The "specbook" module imported by every spec.ts. The runner rewrites the import to
 * point at this file (or at its bundle, dist/specbook-fixtures.mjs, in production).
 * It only runs inside the Playwright worker of a Spec run.
 */
import { expect as baseExpect, test as base } from "@playwright/test";
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

export const test = base.extend<{ step: StepFn; secret: SecretFn }>({
    page: async ({ page }, use) => {
        await use(guard.wrapPage(page as unknown as RawPage) as never);
    },
    step: async ({ page }, use, testInfo) => {
        const real = unwrap<RawPage>(page, ["page"]);
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
