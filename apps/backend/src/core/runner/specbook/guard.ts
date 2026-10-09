import { CodedError } from "../../errors";
import { LOCATOR_FACTORIES, LOCATOR_REFINERS, RUNTIME_LOCATOR_ACTIONS as LOCATOR_ACTIONS } from "./allowlist";
import type { ApiRequestEvidence } from "../evidence";
export type { ApiRequestEvidence } from "../evidence";

export interface SecretOriginPolicy {
    defaultOrigins: string[];
    byRef: Record<string, string[]>;
}

export interface SpecbookRuntime {
    navigationOrigins?: string[];
    baseURL: string;
    secretOrigins: SecretOriginPolicy;
}

export const RUNTIME_ENV = "SPECBOOK_RUNTIME";
export const STEP_ATTACHMENT_PREFIX = "specbook-step-";
export const API_STEP_ATTACHMENT_PREFIX = "specbook-api-step-";
export const FAILED_STEP_ANNOTATION = "specbook-failed-step";
export const SECRET_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

const SECRET_ORIGIN_ERROR = "Refusing to type a secret: the current page origin is not allowed for this credential.";

function envSegment(name: string): string {
    return name.toUpperCase().replace(/-/g, "_");
}

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
        navigationOrigins: value.navigationOrigins?.map(String),
        secretOrigins: {
            defaultOrigins: Array.isArray(policy?.defaultOrigins) ? policy.defaultOrigins.map(String) : [],
            byRef: policy?.byRef && typeof policy.byRef === "object" ? policy.byRef : {},
        },
    };
}

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

const secretRefs = new WeakMap<object, { envName: string; label: string }>();

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

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFn = (...args: any[]) => any;
export interface RawLocator {
    [method: string]: any;
}
export interface RawPage {
    url(): string;
    mainFrame(): unknown;
    keyboard: { press: AnyFn; type: AnyFn };
    mouse: { move: AnyFn; down: AnyFn; up: AnyFn; click: AnyFn; dblclick: AnyFn; wheel: AnyFn };
    evaluate: AnyFn;
    [method: string]: any;
}
export interface RawApiResponse {
    status(): number;
    headers(): Record<string, string>;
    body(): Promise<Uint8Array>;
    json(): Promise<unknown>;
    dispose(): Promise<void>;
}
export interface RawRequest {
    fetch(url: string, options: Record<string, unknown>): Promise<RawApiResponse>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

type WrapperKind = "page" | "locator" | "keyboard" | "mouse" | "apiResponse" | "request";
const originals = new WeakMap<object, { kind: WrapperKind; original: object }>();

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

export interface GuardOptions {
    runtime: SpecbookRuntime;
    readSecret: (envName: string) => string | undefined;
}

function isPlainValue(value: unknown): boolean {
    return value === null || ["string", "number", "boolean", "undefined"].includes(typeof value) || value instanceof RegExp;
}

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

export function isSafeRelativePath(value: unknown): value is string {
    return typeof value === "string" && /^\/(?!\/)[^\\\u0000-\u001f]*$/.test(value);
}

export function createGuard(options: GuardOptions) {
    const { runtime } = options;
    const baseOrigin = new URL(runtime.baseURL).origin;
    const basePath = new URL(runtime.baseURL).pathname.replace(/\/+$/, "");
    const apiOrigins = runtime.navigationOrigins ?? [baseOrigin];

    function allowedOriginsFor(envName: string): string[] {
        return runtime.secretOrigins.byRef[envName] ?? [];
    }

    function secretValue(token: object): { value: string; envName: string } {
        const ref = secretRefs.get(token);
        if (!ref) throw new Error("Not a Specbook secret");
        const value = options.readSecret(ref.envName);
        if (value === undefined) throw new CodedError("credentials", `${ref.label} is not configured for this run`);
        return { value, envName: ref.envName };
    }

    function assertPageOrigin(page: RawPage, envName: string): void {
        let origin: string;
        try {
            origin = new URL(page.url()).origin;
        } catch {
            throw new CodedError("credential_origin", SECRET_ORIGIN_ERROR);
        }
        if (!allowedOriginsFor(envName).includes(origin)) throw new CodedError("credential_origin", SECRET_ORIGIN_ERROR);
    }

    async function textArgument(page: RawPage, value: unknown, target: RawLocator | null): Promise<string> {
        if (typeof value === "string") return value;
        if (!isSecret(value)) throw new Error("Text must be a string literal or secret(...)");
        const { value: secret, envName } = secretValue(value as object);
        assertPageOrigin(page, envName);
        if (target) {
            const handle = await target.elementHandle();
            try {
                if (!handle || (await handle.ownerFrame()) !== page.mainFrame()) {
                    throw new CodedError("credential_origin", "Refusing to type a secret into an element outside the page's main frame.");
                }
            } finally {
                await handle?.dispose().catch(() => undefined);
            }
        } else {
            const intoFrame = await page.evaluate(() => {
                const active = (globalThis as unknown as { document?: { activeElement?: { tagName?: string } | null } }).document?.activeElement;
                return active?.tagName === "IFRAME" || active?.tagName === "FRAME";
            });
            if (intoFrame) throw new CodedError("credential_origin", "Refusing to type a secret into an element outside the page's main frame.");
        }
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
        methods.dragTo = async (target: unknown, dragOptions?: unknown) => {
            const real = unwrap(target, ["locator"]);
            if (!real) throw new Error("dragTo() takes a locator");
            await locator.dragTo(real, sanitize(dragOptions));
        };
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
            const url = new URL(`${baseOrigin}${basePath}${target}`);
            if (url.origin !== baseOrigin) throw new Error("page.goto() must stay on the project origin.");
            try { await page.goto(url.href, sanitize(gotoOptions)); }
            catch (cause) { throw new CodedError("environment", cause instanceof Error ? cause.message : String(cause), { cause }); }
        };
        for (const name of ["reload", "goBack", "goForward"] as const) {
            methods[name] = async (navigationOptions?: unknown) => {
                try { await page[name](sanitize(navigationOptions)); }
                catch (cause) { throw new CodedError("environment", cause instanceof Error ? cause.message : String(cause), { cause }); }
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
        const coordinates = (method: string, ...values: unknown[]) => {
            if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) throw new Error(`mouse.${method}() takes literal numbers`);
        };
        methods.mouse = frozen(
            "mouse",
            {
                move: async (x: unknown, y: unknown, moveOptions?: unknown) => {
                    coordinates("move", x, y);
                    await page.mouse.move(x, y, sanitize(moveOptions));
                },
                click: async (x: unknown, y: unknown, clickOptions?: unknown) => {
                    coordinates("click", x, y);
                    await page.mouse.click(x, y, sanitize(clickOptions));
                },
                dblclick: async (x: unknown, y: unknown, clickOptions?: unknown) => {
                    coordinates("dblclick", x, y);
                    await page.mouse.dblclick(x, y, sanitize(clickOptions));
                },
                down: async (buttonOptions?: unknown) => {
                    await page.mouse.down(sanitize(buttonOptions));
                },
                up: async (buttonOptions?: unknown) => {
                    await page.mouse.up(sanitize(buttonOptions));
                },
                wheel: async (deltaX: unknown, deltaY: unknown) => {
                    coordinates("wheel", deltaX, deltaY);
                    await page.mouse.wheel(deltaX, deltaY);
                },
            },
            page.mouse,
        );
        return frozen("page", methods, page);
    }

    function wrapRequest(request: RawRequest, capture: (evidence: ApiRequestEvidence) => void): object {
        const sensitive = /authorization|cookie|token|api[-_]key|password|secret/i;
        const configuredSecrets = Object.keys(runtime.secretOrigins.byRef).map(options.readSecret).filter((value): value is string => Boolean(value));
        const redact = (value: string) => {
            for (const secret of configuredSecrets) {
                for (const variant of new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)])) {
                    value = value.split(variant).join("••••");
                }
            }
            return value;
        };
        const excerpt = (value: unknown) => redact(typeof value === "string" ? value : JSON.stringify(value)).slice(0, 4000);
        const safeHeaders = (headers: Record<string, string>) => Object.fromEntries(Object.entries(headers).slice(0, 50).map(([key, value]) => [key, sensitive.test(key) ? "••••" : redact(value).slice(0, 1000)]));
        const safeUrl = (url: URL) => {
            const safe = new URL(url);
            for (const key of safe.searchParams.keys()) if (sensitive.test(key)) safe.searchParams.set(key, "••••");
            return redact(safe.href).slice(0, 2000);
        };
        const checkOrigin = (url: URL, refs: Set<string>) => {
            if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !apiOrigins.includes(url.origin)) throw new Error("API request origin is not allowed for this run.");
            for (const ref of refs) if (!allowedOriginsFor(ref).includes(url.origin)) throw new CodedError("credential_origin", "Refusing to send a secret: the API origin is not allowed for this credential.");
        };
        const resolveValue = (value: unknown, refs: Set<string>, depth = 0): unknown => {
            if (depth > 6) throw new Error("API values are nested too deeply");
            if (isSecret(value)) {
                const secret = secretValue(value as object);
                refs.add(secret.envName);
                return secret.value;
            }
            if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
            if (Array.isArray(value)) return value.map((item) => resolveValue(item, refs, depth + 1));
            if (typeof value !== "object" || value === null || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("API bodies must be literal JSON values or secret(...)");
            const copy: Record<string, unknown> = {};
            for (const [key, item] of Object.entries(value)) {
                if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error(`API key "${key}" is not allowed`);
                copy[key] = resolveValue(item, refs, depth + 1);
            }
            return copy;
        };
        const methods: Record<string, unknown> = {};
        for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
            methods[method.toLowerCase()] = async (target: unknown, input: unknown = {}) => {
                if (typeof target !== "string" || /[\\\u0000-\u001f]/.test(target)) throw new Error("API requests need a literal path or HTTP(S) URL");
                let url = isSafeRelativePath(target) ? new URL(`${baseOrigin}${basePath}${target}`) : new URL(target);
                const refs = new Set<string>();
                const requestOptions = resolveValue(input, refs) as Record<string, unknown>;
                if (!requestOptions || Array.isArray(requestOptions) || typeof requestOptions !== "object") throw new Error("API options must be a literal object");
                for (const key of Object.keys(requestOptions)) if (!["headers", "data", "timeout"].includes(key)) throw new Error(`API option "${key}" is not allowed`);
                const headers = requestOptions.headers ?? {};
                if (!headers || typeof headers !== "object" || Array.isArray(headers) || Object.values(headers).some((value) => typeof value !== "string")) throw new Error("API headers must contain string values");
                const timeout = requestOptions.timeout ?? 15_000;
                if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 1 || timeout > 30_000) throw new Error("API timeout must be between 1 and 30000 milliseconds");
                let currentMethod = method;
                let data = requestOptions.data;
                checkOrigin(url, refs);
                for (let redirects = 0; redirects <= 5; redirects += 1) {
                    checkOrigin(url, refs);
                    const evidence: ApiRequestEvidence = {
                        method: currentMethod, url: safeUrl(url), status: null, requestHeaders: safeHeaders(headers as Record<string, string>),
                        ...(data === undefined ? {} : { requestBody: excerpt(data) }),
                    };
                    let response: RawApiResponse;
                    try {
                        response = await request.fetch(url.href, { method: currentMethod, headers, ...(data === undefined ? {} : { data }), timeout, maxRedirects: 0, maxRetries: 0, failOnStatusCode: false });
                        evidence.status = response.status();
                        evidence.responseHeaders = safeHeaders(response.headers());
                        const body = await response.body();
                        evidence.responseBody = body.byteLength > 64_000 ? "[Response body exceeds 64 KB]" : excerpt(new TextDecoder().decode(body));
                    } catch (error) {
                        evidence.error = redact(error instanceof Error ? error.message : String(error)).slice(0, 2000);
                        capture(evidence);
                        throw error;
                    }
                    capture(evidence);
                    const location = response.headers().location;
                    if ([301, 302, 303, 307, 308].includes(response.status()) && location) {
                        await response.dispose();
                        if (redirects === 5) throw new Error("API request exceeded five redirects");
                        url = new URL(location, url);
                        if (evidence.status === 303 || ([301, 302].includes(evidence.status!) && currentMethod === "POST")) {
                            currentMethod = "GET";
                            data = undefined;
                        }
                        continue;
                    }
                    return frozen("apiResponse", {
                        status: () => response.status(),
                        headers: () => Object.freeze({ ...response.headers() }),
                        json: () => response.json(),
                    }, response);
                }
                throw new Error("API request exceeded five redirects");
            };
        }
        return frozen("request", methods, request);
    }

    return { wrapPage, wrapLocator, wrapRequest };
}
