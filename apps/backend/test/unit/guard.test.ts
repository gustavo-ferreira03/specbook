import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createGuard, createSecret, isSafeRelativePath, isSecret, parseRuntime, unwrap, type RawPage } from "../../src/core/runner/specbook/guard";

const BASE = "https://app.example.com/shop/";
const runtime = {
    baseURL: BASE,
    secretOrigins: {
        defaultOrigins: ["https://app.example.com"],
        byRef: { SPECBOOK_SECRET_ADMIN_PASSWORD: ["https://app.example.com", "https://login.example.com"] },
    },
};

interface Call {
    target: string;
    method: string;
    args: unknown[];
}

function fakePage(options: { url?: string; frameOfElement?: "main" | "child"; activeIframe?: boolean } = {}) {
    const calls: Call[] = [];
    const mainFrame = { name: "main" };
    const childFrame = { name: "child" };
    let currentUrl = options.url ?? "https://app.example.com/shop/login";
    const locator = (description: string): Record<string, unknown> => {
        const record = (method: string) => (...args: unknown[]) => {
            calls.push({ target: description, method, args });
            if (["getByRole", "getByLabel", "getByText", "locator", "first", "last", "nth", "filter", "and", "or"].includes(method)) {
                return locator(`${description}.${method}`);
            }
            return Promise.resolve("raw-result");
        };
        return new Proxy({}, {
            get(_target, property: string) {
                if (property === "elementHandle") {
                    return async () => ({
                        ownerFrame: async () => (options.frameOfElement === "child" ? childFrame : mainFrame),
                        dispose: async () => undefined,
                    });
                }
                return record(property);
            },
        });
    };
    const page: RawPage = {
        url: () => currentUrl,
        mainFrame: () => mainFrame,
        keyboard: {
            press: async (...args: unknown[]) => calls.push({ target: "keyboard", method: "press", args }),
            type: async (...args: unknown[]) => calls.push({ target: "keyboard", method: "type", args }),
        },
        evaluate: async () => options.activeIframe ?? false,
        goto: async (...args: unknown[]) => {
            calls.push({ target: "page", method: "goto", args });
            currentUrl = String(args[0]);
            return { request: () => "raw-response" };
        },
        reload: async (...args: unknown[]) => calls.push({ target: "page", method: "reload", args }),
        getByRole: (...args: unknown[]) => {
            calls.push({ target: "page", method: "getByRole", args });
            return locator("role");
        },
        getByLabel: (...args: unknown[]) => {
            calls.push({ target: "page", method: "getByLabel", args });
            return locator("label");
        },
        locator: (...args: unknown[]) => {
            calls.push({ target: "page", method: "locator", args });
            return locator("css");
        },
        context: () => "raw-context",
    };
    return { page, calls, setUrl: (url: string) => (currentUrl = url) };
}

function guarded(options: Parameters<typeof fakePage>[0] = {}, secrets: Record<string, string> = { SPECBOOK_SECRET_ADMIN_PASSWORD: "hunter22" }) {
    const fake = fakePage(options);
    const guard = createGuard({ runtime, readSecret: (name) => secrets[name] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page = guard.wrapPage(fake.page) as any;
    return { ...fake, wrapped: page };
}

describe("specbook page proxy", () => {
    test("exposes only allowlisted methods on a frozen, prototype-less object", () => {
        const { wrapped, page } = guarded();
        assert.equal(Object.getPrototypeOf(wrapped), null);
        assert.ok(Object.isFrozen(wrapped));
        for (const name of ["evaluate", "context", "route", "request", "exposeFunction", "setContent", "mainFrame", "constructor", "__proto__"]) {
            assert.equal(wrapped[name], undefined, name);
        }
        assert.throws(() => {
            wrapped.evaluate = () => 1;
        });
        assert.equal(unwrap(wrapped), page);
        assert.equal(unwrap({}), undefined);
    });

    test("goto appends the path to the base URL and never returns the Response", async () => {
        const { wrapped, calls } = guarded();
        assert.equal(await wrapped.goto("/login?next=%2F", { waitUntil: "load" }), undefined);
        assert.deepEqual(calls.at(-1), { target: "page", method: "goto", args: ["https://app.example.com/shop/login?next=%2F", { waitUntil: "load" }] });
        for (const target of ["https://evil.example/", "//evil.example/", "/\\evil.example", "login", "", 1, "/a\u0000b"]) {
            await assert.rejects(wrapped.goto(target), /takes a path starting with/, String(target));
        }
    });

    test("locators are wrapped too and actions return nothing", async () => {
        const { wrapped, calls } = guarded();
        const button = wrapped.getByRole("button", { name: "Save" }).first();
        assert.equal(Object.getPrototypeOf(button), null);
        assert.equal(button.evaluate, undefined);
        assert.equal(button.elementHandle, undefined);
        assert.equal(await button.click({ force: true }), undefined);
        assert.deepEqual(calls.at(-1), { target: "role.first", method: "click", args: [{ force: true }] });
        const filtered = wrapped.locator("li").filter({ has: wrapped.getByLabel("x"), hasText: /a/ });
        assert.ok(filtered);
        const filterCall = calls.find((call) => call.method === "filter");
        assert.equal(typeof (filterCall?.args[0] as { has: unknown }).has, "object");
        assert.notEqual((filterCall?.args[0] as { has: unknown }).has, undefined);
        assert.throws(() => wrapped.locator("internal:control=enter-frame"), /internal:/);
        assert.throws(() => wrapped.getByRole("button").and("css"), /takes a locator/);
        assert.throws(() => wrapped.getByRole("button", { name: () => 1 }), /Only literal values/);
        assert.throws(() => wrapped.getByRole("button", new (class Options {})()), /plain object literals/);
        assert.throws(() => wrapped.getByRole("button").filter({ has: wrapped }), /Only literal values|plain object/);
    });

    test("fill types a secret only on an allowed origin, into the main frame", async () => {
        const allowed = guarded();
        await allowed.wrapped.getByLabel("Password").fill(createSecret("admin", "password"));
        assert.deepEqual(allowed.calls.at(-1), { target: "label", method: "fill", args: ["hunter22", undefined] });

        const otherAllowed = guarded({ url: "https://login.example.com/sso" });
        await otherAllowed.wrapped.getByLabel("Password").fill(createSecret("admin", "password"));

        const evil = guarded({ url: "https://evil.example/login" });
        await assert.rejects(evil.wrapped.getByLabel("Password").fill(createSecret("admin", "password")), /origin is not allowed/);
        assert.ok(!evil.calls.some((call) => call.method === "fill"));

        const framed = guarded({ frameOfElement: "child" });
        await assert.rejects(framed.wrapped.getByLabel("Password").fill(createSecret("admin", "password")), /outside the page's main frame/);
        assert.ok(!framed.calls.some((call) => call.method === "fill"));

        // A profile without an entry in the policy may type nowhere.
        const unknown = guarded({}, { SPECBOOK_SECRET_OTHER_PASSWORD: "x1x1x1" });
        await assert.rejects(unknown.wrapped.getByLabel("Password").fill(createSecret("other", "password")), /origin is not allowed/);
        const missing = guarded({}, {});
        await assert.rejects(missing.wrapped.getByLabel("Password").fill(createSecret("admin", "password")), /not configured/);
    });

    test("keyboard.type refuses a secret while focus is inside a frame", async () => {
        const plain = guarded();
        await plain.wrapped.keyboard.type(createSecret("admin", "password"));
        assert.deepEqual(plain.calls.at(-1), { target: "keyboard", method: "type", args: ["hunter22", undefined] });
        const framed = guarded({ activeIframe: true });
        await assert.rejects(framed.wrapped.keyboard.type(createSecret("admin", "password")), /main frame/);
        await assert.rejects(plain.wrapped.keyboard.type({ toString: () => "x" }), /string literal or secret/);
        assert.equal(Object.getPrototypeOf(plain.wrapped.keyboard), null);
        assert.equal(plain.wrapped.keyboard.down, undefined);
    });

    test("secret handles carry no value", () => {
        const token = createSecret("admin", "password");
        assert.ok(isSecret(token));
        assert.equal(String(token), "[secret admin.password]");
        assert.equal(JSON.stringify({ token }), '{"token":"[secret admin.password]"}');
        assert.ok(!Object.values(token).includes("hunter22"));
        assert.throws(() => createSecret("Admin", "password"), /profile name/);
        assert.throws(() => createSecret("admin", 1), /profile name/);
    });

    test("paths and runtime configuration", () => {
        assert.ok(isSafeRelativePath("/"));
        assert.ok(isSafeRelativePath("/a/b?c#d"));
        assert.ok(!isSafeRelativePath("//x"));
        assert.ok(!isSafeRelativePath("/\\x"));
        assert.ok(!isSafeRelativePath("/a\\b"));
        assert.ok(!isSafeRelativePath("http://x/"));
        assert.throws(() => parseRuntime(undefined), /only run through Specbook/);
        assert.equal(parseRuntime(JSON.stringify(runtime)).baseURL, BASE);
    });
});

describe("function constructor hardening", () => {
    test("fn.constructor cannot compile code after the specbook module hardens the worker", () => {
        const guardUrl = new URL("../../src/core/runner/specbook/guard.ts", import.meta.url).href;
        const script = `
            const { hardenFunctionConstructors } = await import(${JSON.stringify(guardUrl)});
            hardenFunctionConstructors();
            const attempts = [
                () => (0).constructor.constructor("return 1")(),
                () => [].map.constructor("return 1")(),
                () => (async () => {}).constructor("return 1"),
                () => (function* () {}).constructor("return 1"),
            ];
            const results = attempts.map((attempt) => { try { attempt(); return "ran"; } catch (error) { return error.message; } });
            console.log(JSON.stringify(results));
        `;
        const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
        const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        const lines = result.stdout.trim().split("\n");
        const outcomes = JSON.parse(lines[lines.length - 1]) as string[];
        assert.deepEqual(outcomes, Array(4).fill("Code generation is not available to Specs"));
    });
});
