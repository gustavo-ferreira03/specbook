/**
 * Runtime half of the "specbook" test module. It runs inside the Playwright worker
 * that executes pushed or LLM-written Spec code, so it imports nothing from the
 * backend: everything it needs arrives through SPECBOOK_RUNTIME and the secret
 * environment variables of the run.
 *
 * The static validator (core/runner/validate.ts) is the primary defense. This module
 * is the second line: the objects a Spec can reach expose only allowlisted methods,
 * never return raw Playwright objects (a Response, a Frame, a BrowserContext...), keep
 * navigation on the project origin, and type a secret only into the main frame of a
 * page whose origin the credential profile allows.
 */

export interface SecretOriginPolicy {
    /** Origins allowed when a secret has no profile-specific entry (the project origin). */
    defaultOrigins: string[];
    /** Allowed origins per secret env name (e.g. SPECBOOK_SECRET_ADMIN_PASSWORD). */
    byRef: Record<string, string[]>;
}

export interface SpecbookRuntime {
    baseURL: string;
    secretOrigins: SecretOriginPolicy;
}

export const RUNTIME_ENV = "SPECBOOK_RUNTIME";
export const STEP_ATTACHMENT_PREFIX = "specbook-step-";
export const FAILED_STEP_ANNOTATION = "specbook-failed-step";
export const SECRET_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

const SECRET_ORIGIN_ERROR = "Refusing to type a secret: the current page origin is not allowed for this credential.";

function envSegment(name: string): string {
    return name.toUpperCase().replace(/-/g, "_");
}

/** Environment variable that carries a credential field's value during a run. */
export function secretEnvName(profileName: string, fieldKey: string): string {
    return `SPECBOOK_SECRET_${envSegment(profileName)}_${envSegment(fieldKey)}`;
}

export function parseRuntime(raw: string | undefined): SpecbookRuntime {
    if (!raw) throw new Error(`${RUNTIME_ENV} is not set; Specs only run through Specbook`);
    const value = JSON.parse(raw) as Partial<SpecbookRuntime>;
    if (typeof value.baseURL !== "string") throw new Error(`${RUNTIME_ENV} has no baseURL`);
    new URL(value.baseURL);
    const policy = value.secretOrigins;
    return {
        baseURL: value.baseURL,
        secretOrigins: {
            defaultOrigins: Array.isArray(policy?.defaultOrigins) ? policy.defaultOrigins.map(String) : [],
            byRef: policy?.byRef && typeof policy.byRef === "object" ? policy.byRef : {},
        },
    };
}

// ---- code generation -------------------------------------------------------------

/**
 * Removes the `constructor` link from every kind of function, so a Spec that reached
 * any function value still cannot turn a string into code with
 * `fn.constructor("...")`. The global Function/eval stay available to Playwright
 * itself; Spec code cannot name them (the validator allows no free identifiers).
 * Node's --disallow-code-generation-from-strings would be stronger, but Playwright
 * needs eval to load modules and to run locators.
 */
export function hardenFunctionConstructors(): void {
    const blocked = () => {
        throw new Error("Code generation is not available to Specs");
    };
    const prototypes = [
        Function.prototype,
        Object.getPrototypeOf(async function () {}),
        Object.getPrototypeOf(function* () {}),
        Object.getPrototypeOf(async function* () {}),
    ];
    for (const prototype of prototypes) {
        Object.defineProperty(prototype, "constructor", { value: blocked, writable: false, configurable: false, enumerable: false });
    }
}

// ---- secrets -------------------------------------------------------------------

const secretRefs = new WeakMap<object, { envName: string; label: string }>();

/** Opaque handle returned by secret(): it carries no value, only which field to type. */
export function createSecret(profile: unknown, field: unknown): object {
    if (typeof profile !== "string" || typeof field !== "string" || !SECRET_NAME_PATTERN.test(profile) || !SECRET_NAME_PATTERN.test(field)) {
        throw new Error('secret() takes a profile name and a field key, like secret("admin", "password")');
    }
    const label = `[secret ${profile}.${field}]`;
    const token = Object.freeze(Object.assign(Object.create(null), { toString: () => label, toJSON: () => label }));
    secretRefs.set(token, { envName: secretEnvName(profile, field), label });
    return token;
}

export function isSecret(value: unknown): boolean {
    return typeof value === "object" && value !== null && secretRefs.has(value);
}

// ---- minimal structural types of the Playwright objects we wrap --------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFn = (...args: any[]) => any;
export interface RawLocator {
    [method: string]: any;
}
export interface RawPage {
    url(): string;
    mainFrame(): unknown;
    keyboard: { press: AnyFn; type: AnyFn };
    evaluate: AnyFn;
    [method: string]: any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

type WrapperKind = "page" | "locator" | "keyboard";
const originals = new WeakMap<object, { kind: WrapperKind; original: object }>();

/** The real Playwright object behind a wrapper, for expect() and fixture internals. */
export function unwrap<T = unknown>(value: unknown, kinds: WrapperKind[] = ["page", "locator", "keyboard"]): T | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const entry = originals.get(value);
    return entry && kinds.includes(entry.kind) ? (entry.original as T) : undefined;
}

function frozen(kind: WrapperKind, methods: Record<string, unknown>, original: object): object {
    const wrapper = Object.freeze(Object.assign(Object.create(null), methods));
    originals.set(wrapper, { kind, original });
    return wrapper;
}

const LOCATOR_FACTORIES = [
    "getByRole",
    "getByLabel",
    "getByText",
    "getByPlaceholder",
    "getByTestId",
    "getByAltText",
    "getByTitle",
    "locator",
] as const;
const LOCATOR_REFINERS = ["first", "last", "nth"] as const;
const LOCATOR_ACTIONS = [
    "click",
    "dblclick",
    "press",
    "check",
    "uncheck",
    "setChecked",
    "selectOption",
    "hover",
    "focus",
    "blur",
    "clear",
    "scrollIntoViewIfNeeded",
    "waitFor",
] as const;

export interface GuardOptions {
    runtime: SpecbookRuntime;
    /** Reads a secret value by env name (process.env in the worker). */
    readSecret: (envName: string) => string | undefined;
}

function isPlainValue(value: unknown): boolean {
    return value === null || ["string", "number", "boolean", "undefined"].includes(typeof value) || value instanceof RegExp;
}

/** Copies a literal argument, replacing wrapped locators by the real ones and rejecting anything else. */
function sanitize(value: unknown, depth = 0): unknown {
    if (isPlainValue(value)) return value;
    if (depth > 3) throw new Error("Argument is nested too deeply");
    const locator = unwrap(value, ["locator"]);
    if (locator) return locator;
    if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
    if (typeof value === "object" && value !== null && !isSecret(value)) {
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) throw new Error("Only plain object literals may be passed as options");
        const copy: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
            if (key === "__proto__" || key === "constructor" || key === "prototype") throw new Error(`Option "${key}" is not allowed`);
            copy[key] = sanitize(item, depth + 1);
        }
        return copy;
    }
    throw new Error("Only literal values, locators and secret() can be passed to Specbook page methods");
}

function sanitizeAll(args: unknown[]): unknown[] {
    return args.map((arg) => sanitize(arg));
}

function assertSelector(selector: unknown): void {
    if (typeof selector !== "string") throw new Error("locator() takes a selector string");
    if (selector.includes("internal:")) throw new Error('Selectors may not use Playwright "internal:" engines');
}

/** A path below the base URL: starts with one "/", no backslashes or control characters. */
export function isSafeRelativePath(value: unknown): value is string {
    return typeof value === "string" && /^\/(?!\/)[^\\\u0000-\u001f]*$/.test(value);
}

export function createGuard(options: GuardOptions) {
    const { runtime } = options;
    const baseOrigin = new URL(runtime.baseURL).origin;
    const basePath = new URL(runtime.baseURL).pathname.replace(/\/+$/, "");

    function allowedOriginsFor(envName: string): string[] {
        return runtime.secretOrigins.byRef[envName] ?? [];
    }

    function secretValue(token: object): { value: string; envName: string } {
        const ref = secretRefs.get(token);
        if (!ref) throw new Error("Not a Specbook secret");
        const value = options.readSecret(ref.envName);
        if (value === undefined) throw new Error(`${ref.label} is not configured for this run`);
        return { value, envName: ref.envName };
    }

    function assertPageOrigin(page: RawPage, envName: string): void {
        let origin: string;
        try {
            origin = new URL(page.url()).origin;
        } catch {
            throw new Error(SECRET_ORIGIN_ERROR);
        }
        if (!allowedOriginsFor(envName).includes(origin)) throw new Error(SECRET_ORIGIN_ERROR);
    }

    /** Resolves a fill/type argument, checking origin and frame before a secret is revealed. */
    async function textArgument(page: RawPage, value: unknown, target: RawLocator | null): Promise<string> {
        if (typeof value === "string") return value;
        if (!isSecret(value)) throw new Error("Text must be a string literal or secret(...)");
        const { value: secret, envName } = secretValue(value as object);
        assertPageOrigin(page, envName);
        if (target) {
            const handle = await target.elementHandle();
            try {
                if (!handle || (await handle.ownerFrame()) !== page.mainFrame()) {
                    throw new Error("Refusing to type a secret into an element outside the page's main frame.");
                }
            } finally {
                await handle?.dispose().catch(() => undefined);
            }
        } else {
            const intoFrame = await page.evaluate(() => {
                const active = (globalThis as unknown as { document?: { activeElement?: { tagName?: string } | null } }).document?.activeElement;
                return active?.tagName === "IFRAME" || active?.tagName === "FRAME";
            });
            if (intoFrame) throw new Error("Refusing to type a secret into an element outside the page's main frame.");
        }
        // The page may have navigated while the element was located.
        assertPageOrigin(page, envName);
        return secret;
    }

    function wrapLocator(page: RawPage, locator: RawLocator): object {
        const methods: Record<string, unknown> = {};
        for (const name of LOCATOR_FACTORIES) {
            methods[name] = (...args: unknown[]) => {
                if (name === "locator") assertSelector(args[0]);
                return wrapLocator(page, locator[name](...sanitizeAll(args)));
            };
        }
        for (const name of LOCATOR_REFINERS) {
            methods[name] = (...args: unknown[]) => wrapLocator(page, locator[name](...sanitizeAll(args)));
        }
        methods.filter = (filter?: unknown) => wrapLocator(page, locator.filter(sanitize(filter)));
        for (const name of ["and", "or"] as const) {
            methods[name] = (other: unknown) => {
                const real = unwrap(other, ["locator"]);
                if (!real) throw new Error(`${name}() takes a locator`);
                return wrapLocator(page, locator[name](real));
            };
        }
        for (const name of LOCATOR_ACTIONS) {
            methods[name] = async (...args: unknown[]) => {
                await locator[name](...sanitizeAll(args));
            };
        }
        methods.fill = async (value: unknown, fillOptions?: unknown) => {
            const text = await textArgument(page, value, locator);
            await locator.fill(text, sanitize(fillOptions));
        };
        methods.pressSequentially = async (value: unknown, typeOptions?: unknown) => {
            const text = await textArgument(page, value, locator);
            await locator.pressSequentially(text, sanitize(typeOptions));
        };
        return frozen("locator", methods, locator);
    }

    function wrapPage(page: RawPage): object {
        const methods: Record<string, unknown> = {};
        for (const name of LOCATOR_FACTORIES) {
            methods[name] = (...args: unknown[]) => {
                if (name === "locator") assertSelector(args[0]);
                return wrapLocator(page, page[name](...sanitizeAll(args)));
            };
        }
        methods.goto = async (target: unknown, gotoOptions?: unknown) => {
            if (!isSafeRelativePath(target)) {
                throw new Error('page.goto() takes a path starting with "/"; the project base URL is added automatically.');
            }
            // Like ${BASE_URL}/path: the path is appended to the base URL, keeping its path prefix.
            const url = new URL(`${baseOrigin}${basePath}${target}`);
            if (url.origin !== baseOrigin) throw new Error("page.goto() must stay on the project origin.");
            await page.goto(url.href, sanitize(gotoOptions));
        };
        for (const name of ["reload", "goBack", "goForward"] as const) {
            methods[name] = async (navigationOptions?: unknown) => {
                await page[name](sanitize(navigationOptions));
            };
        }
        methods.waitForURL = async (url: unknown, waitOptions?: unknown) => {
            if (typeof url !== "string" && !(url instanceof RegExp)) throw new Error("waitForURL() takes a string or a regular expression");
            await page.waitForURL(url, sanitize(waitOptions));
        };
        methods.waitForLoadState = async (state?: unknown, waitOptions?: unknown) => {
            if (state !== undefined && typeof state !== "string") throw new Error("waitForLoadState() takes a state name");
            await page.waitForLoadState(state, sanitize(waitOptions));
        };
        const keyboard = frozen(
            "keyboard",
            {
                press: async (key: unknown, pressOptions?: unknown) => {
                    if (typeof key !== "string") throw new Error("keyboard.press() takes a key name");
                    await page.keyboard.press(key, sanitize(pressOptions));
                },
                type: async (value: unknown, typeOptions?: unknown) => {
                    const text = await textArgument(page, value, null);
                    await page.keyboard.type(text, sanitize(typeOptions));
                },
            },
            page.keyboard,
        );
        methods.keyboard = keyboard;
        return frozen("page", methods, page);
    }

    return { wrapPage, wrapLocator };
}
