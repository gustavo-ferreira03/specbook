import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { analyzeSpecSource, secretEnvRefs, stepTitlesError, validateSpecSource } from "../../src/core/runner/validate";
import { VALID_SPEC } from "../helpers/storage";

const LOGIN_SPEC = `import { test, expect } from "specbook";

// Comments are fine.
test("Sign in with valid credentials", async ({ page, step, secret }) => {
    const email = page.getByLabel("Email");
    await step("Open the sign-in page", async () => {
        await page.goto("/login");
        await expect(page).toHaveURL(/\\/login$/);
    });
    await step("Enter the account email and password", async () => {
        await email.fill(secret("shopper", "email"));
        await page.getByLabel("Password").fill(secret("shopper", "password"));
        const submit = page.getByRole("button", { name: "Sign in", exact: true });
        await submit.click();
    });
    await step("See the dashboard", async () => {
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Welcome back/);
        await expect(page.locator("nav").getByText(\`Orders\`).first()).not.toBeHidden({ timeout: 10000 });
        await expect(page.getByRole("listitem").filter({ hasText: "Order", has: page.getByRole("link") })).toHaveCount(2);
        await page.keyboard.press("Escape");
    });
});
`;

/** A spec whose single step contains the given statements. */
function spec(body: string, fixtures = "page, step, secret", header = 'import { test, expect } from "specbook";'): string {
    return `${header}\ntest("T", async ({ ${fixtures} }) => {\n    await step("S", async () => {\n        ${body}\n    });\n});\n`;
}

function errorOf(source: string): string {
    const result = analyzeSpecSource(source);
    assert.equal(result.ok, false, `expected a rejection for:\n${source}`);
    return result.ok ? "" : result.error;
}

describe("analyzeSpecSource: accepted Specs", () => {
    test("accepts the helper Spec and a realistic login Spec", () => {
        assert.equal(analyzeSpecSource(VALID_SPEC).ok, true);
        const result = analyzeSpecSource(LOGIN_SPEC);
        assert.ok(result.ok, result.ok ? "" : result.error);
        assert.equal(result.analysis.testTitle, "Sign in with valid credentials");
        assert.deepEqual(result.analysis.steps, ["Open the sign-in page", "Enter the account email and password", "See the dashboard"]);
        assert.deepEqual(result.analysis.secretRefs.map((ref) => ref.envName), ["SPECBOOK_SECRET_SHOPPER_EMAIL", "SPECBOOK_SECRET_SHOPPER_PASSWORD"]);
        assert.equal(LOGIN_SPEC.slice(result.analysis.importSource.start, result.analysis.importSource.end), '"specbook"');
    });

    test("accepts every allowlisted action and matcher", () => {
        const statements = [
            'await page.goto("/a?b=1#c", { waitUntil: "networkidle" });',
            "await page.reload();",
            "await page.goBack();",
            "await page.goForward();",
            'await page.waitForURL("**/done");',
            'await page.waitForLoadState("domcontentloaded");',
            'await page.getByPlaceholder("Search").pressSequentially("chair", { delay: 10 });',
            'await page.getByTestId("x").dblclick();',
            'await page.getByAltText("Logo").hover();',
            'await page.getByTitle("Help").focus();',
            'await page.locator("#a").blur();',
            'await page.locator("#a").clear();',
            'await page.getByLabel("Agree").check();',
            'await page.getByLabel("Agree").uncheck();',
            'await page.getByLabel("Agree").setChecked(true);',
            'await page.getByLabel("Size").selectOption(["S", "M"]);',
            'await page.getByLabel("Size").selectOption({ label: "Large" });',
            'await page.locator("#a").scrollIntoViewIfNeeded();',
            'await page.locator("#a").waitFor({ state: "visible" });',
            'await page.locator("#a").press("Enter");',
            'await page.getByText("a").and(page.getByRole("button")).or(page.locator("b")).nth(-1).last().click();',
            'await page.locator("li", { has: page.getByRole("link"), hasText: "x" }).click();',
            'await page.keyboard.type("hello");',
            "await expect(page).toHaveTitle(/Shop/);",
            'await expect(page.locator("input")).toHaveValues(["a", "b"]);',
            'await expect(page.locator("input")).toHaveAttribute("type", "email");',
            'await expect(page.locator("a")).toHaveClass(/active/);',
            'await expect(page.locator("a")).toHaveAccessibleName("Home");',
            'await expect(page.locator("a")).toBeEmpty();',
            'await expect(page.locator("a")).toBeEnabled();',
            'await expect(page.locator("a")).toBeDisabled();',
            'await expect(page.locator("a")).toBeChecked({ checked: false });',
            'await expect(page.locator("a")).toBeEditable();',
            'await expect(page.locator("a")).toBeFocused();',
            'await expect(page.locator("a")).toContainText(["x"]);',
            'await expect(page.locator("a")).toHaveValue(/x/);',
        ];
        for (const statement of statements) {
            const result = analyzeSpecSource(spec(statement));
            assert.ok(result.ok, `${statement}: ${result.ok ? "" : result.error}`);
        }
    });
});

describe("analyzeSpecSource: rejected structure", () => {
    test("rejects syntax errors with a line number", () => {
        assert.match(errorOf("import { test } from 'specbook';\ntest(("), /Line 2, column \d+: Syntax error/);
    });

    test("requires exactly the specbook import", () => {
        assert.match(errorOf(spec('await page.goto("/");', "page, step", 'import { test, expect } from "@playwright/test";')), /Imports from "@playwright\/test" are not allowed/);
        assert.match(errorOf(spec('await page.goto("/");', "page, step", 'import { test, expect as e } from "specbook";')), /Renaming imports/);
        assert.match(errorOf(spec('await page.goto("/");', "page, step", 'import { test, devices } from "specbook";')), /"devices" is not exported/);
        assert.match(errorOf(spec('await page.goto("/");', "page, step", 'import * as specbook from "specbook";')), /Import only named bindings/);
        assert.match(errorOf(spec('await page.goto("/");', "page, step", 'import type { test } from "specbook";')), /value import/);
        assert.match(errorOf(`import fs from "node:fs";\n${VALID_SPEC}`), /Imports from "node:fs" are not allowed/);
        assert.match(errorOf(`const x = 1;\n${VALID_SPEC}`), /must start with: import/);
        assert.match(errorOf(`${VALID_SPEC}\nimport fs from "node:fs";`), /only the specbook import and one test/);
        assert.match(errorOf(VALID_SPEC.replace('"specbook";', '"specbook" with { type: "json" };')), /Import attributes/);
    });

    test("allows exactly one plain test() call", () => {
        assert.match(errorOf(`${VALID_SPEC}\n${VALID_SPEC.split("\n").slice(2).join("\n")}`), /only the specbook import and one test/);
        assert.match(errorOf(VALID_SPEC.replace('test("Abrir', 'test.only("Abrir')), /Expected one test/);
        assert.match(errorOf(VALID_SPEC.replace('test("Abrir a aplicação"', "test(`${1}`")), /title must be a non-empty string literal/);
        assert.match(errorOf(VALID_SPEC.replace("async ({ page, step }) =>", "async function ({ page, step })")), /async arrow function/);
        assert.match(errorOf(VALID_SPEC.replace("async ({ page, step })", "async ({ page, step }, testInfo)")), /one destructured parameter/);
        assert.match(errorOf(VALID_SPEC.replace("{ page, step }", "{ page, step, context }")), /Fixture "context" is not available/);
        assert.match(errorOf(VALID_SPEC.replace("{ page, step }", "{ page: p, step }")), /without defaults or renaming/);
        assert.match(errorOf(VALID_SPEC.replace("{ page, step }", "{ page, step, ...rest }")), /without defaults or renaming/);
        assert.match(errorOf(VALID_SPEC.replace("{ page, step }", "{ page = 1, step }")), /without defaults or renaming/);
        assert.match(errorOf(`#!/usr/bin/env node\n${VALID_SPEC}`), /hashbang/);
        assert.match(errorOf(`"use strict";\n${VALID_SPEC}`), /Directives/);
    });

    test("requires named, non-nested steps", () => {
        const noStep = 'import { test } from "specbook";\ntest("T", async ({ page }) => {\n    await page.goto("/");\n});\n';
        assert.match(errorOf(noStep), /only await step\("Title"/);
        assert.match(errorOf(spec('await step("inner", async () => { await page.goto("/"); });')), /Steps cannot be nested/);
        assert.match(errorOf(spec("const x = 1;")), /Only locators can be stored/);
        assert.match(errorOf(VALID_SPEC.replace('step("Abrir a página"', 'step("  "')), /non-empty string literals/);
        assert.match(errorOf(VALID_SPEC.replace("async () => {", "async (x) => {")), /without parameters/);
        assert.match(errorOf(VALID_SPEC.replace("await step(", "step(")), /only await step/);
        assert.match(errorOf(spec('page.goto("/");')), /only await statements/);
        assert.match(errorOf('import { test } from "specbook";\ntest("T", async ({ page, step }) => {\n});\n'), /at least one await step/);
    });
});

describe("analyzeSpecSource: rejected expressions and escape attempts", () => {
    const cases: [string, RegExp][] = [
        ["await [].constructor.constructor(\"return process\")();", /not allowed/],
        ["await page.constructor.constructor(\"return process\")();", /not allowed/],
        ["await page.goto.constructor(\"return process\")();", /not allowed/],
        ['await page["evaluate"]("1");', /Computed property access/],
        ['await (0, eval)("1");', /not allowed/],
        ['await eval("1");', /"eval" is not available/],
        ['await page.evaluate(() => 1);', /page\.evaluate\(\) is not allowed/],
        ['await page.evaluateHandle("1");', /not allowed/],
        ['await page.addInitScript("1");', /not allowed/],
        ['await page.route("**", () => {});', /not allowed/],
        ['await page.exposeFunction("f", () => 1);', /not allowed/],
        ['await page.setContent("<b>x</b>");', /not allowed/],
        ["await page.pdf();", /not allowed/],
        ["await page.context().newPage();", /not allowed/],
        ['await page.request.get("http://169.254.169.254/");', /Property "request" is not allowed/],
        ['await page.locator("a").evaluate("1");', /Locator method evaluate\(\) is not allowed/],
        ['await page.locator("a").getAttribute("href");', /not allowed/],
        ['await page.locator("a")["click"]();', /Computed property access/],
        ['await page?.goto("/");', /not allowed/],
        ['await page.goto?.("/");', /not allowed/],
        ['await globalThis.process.exit(1);', /"globalThis" is not available/],
        ['await process.exit(1);', /"process" is not available/],
        ['await require("fs").readFileSync("/etc/passwd");', /Only page and locator methods/],
        ['await import("node:fs");', /not allowed/],
        ['await fetch("http://example.com");', /not allowed|not available/],
        ['await window.close();', /"window" is not available/],
        ['await page.goto("https://evil.example");', /path string starting with "\/"/],
        ['await page.goto("//evil.example/");', /path string starting with "\/"/],
        ['await page.goto("/\\\\evil.example");', /path string starting with "\/"/],
        ["await page.goto(`/${1}`);", /path string starting with/],
        ['await page.getByText(`${process.env.HOME}`).click();', /string or a regular expression literal/],
        ['await page.getByRole("button", { name: `${1}` }).click();', /Template literals cannot contain/],
        ['await page.getByRole("button", { ["name"]: "x" }).click();', /plain key: value pairs/],
        ['await page.getByRole("button", { __proto__: { x: 1 } }).click();', /Option "__proto__" is not allowed/],
        ['await page.getByRole("button", { constructor: "x" }).click();', /Option "constructor" is not allowed/],
        ['await page.getByRole("button", { name }).click();', /plain key: value pairs/],
        ['await page.getByRole("button", { ...x }).click();', /plain key: value pairs/],
        ['await page.getByRole("button", { get name() { return 1; } }).click();', /plain key: value pairs/],
        ['await page.getByText(String.raw`x`).click();', /string or a regular expression literal/],
        ['await page.locator("a").click(...args);', /Spread arguments/],
        ['await page.locator("internal:control=enter-frame").click();', /internal:/],
        ['await page.getByText("a").fill(page.url());', /string literal or secret/],
        ['await page.getByText("a").fill("x" + "y");', /string literal or secret/],
        ['await page.getByText("a").click({ timeout: 1 + 1 });', /not allowed here|Arguments must be literals/],
        ['await page.getByText("a").click({ timeout: undefined });', /"undefined" cannot be used/],
        ['await page.getByText("a").click({ position: { x: 1, y: { z: { w: 1 } } } });', /nested too deeply/],
        ['await page.getByText(secret("a", "b")).click();', /string or a regular expression literal/],
        ['await page.getByText("a").click({ force: secret("a", "b") });', /secret\(\.\.\.\) may only be the text argument/],
        ['await page.getByText("a").fill(secret("Admin", "password"));', /secret\(\) takes a credential profile name/],
        ['await page.getByText("a").fill(secret("admin"));', /secret\(\) takes a credential profile name/],
        ['await page.getByText("a").fill(secret(`${"a"}`, "b"));', /secret\(\) takes a credential profile name/],
        ['await expect(page.locator("a")).toHaveScreenshot();', /Matcher toHaveScreenshot\(\) is not allowed/],
        ['await expect(page).toBeVisible();', /Matcher toBeVisible\(\) is not allowed for the page/],
        ['await expect(page.locator("a"), "message").toBeVisible();', /exactly one argument/],
        ['await expect.soft(page.locator("a")).toBeVisible();', /expect\.\* helpers are not allowed/],
        ['await expect.poll(() => 1).toBe(1);', /expect\.\* helpers are not allowed/],
        ['await expect(page.locator("a")).not.not.toBeVisible();', /Only page and locator methods/],
        ['await expect(page.keyboard).toBeVisible();', /takes the page or a locator/],
        ['await expect(1).toBe(1);', /not allowed/],
        ['await page.getByText("a");', /A locator on its own does nothing/],
        ['await page.getByText("a").click()!;', /not allowed/],
        ['await (page.getByText("a") as any).click();', /not allowed/],
        ['await page.getByText<string>("a").click();', /Type arguments/],
        ['await page.keyboard.down("Shift");', /keyboard\.down\(\) is not allowed/],
        ['await page.mouse.click(1, 1);', /Property "mouse" is not allowed/],
        ['await page.locator("a").nth("1").click();', /nth\(\) takes one number/],
        ['await page.locator("a").first(1).click();', /takes no arguments/],
        ['await page.locator("a").and("b").click();', /not allowed|takes one locator/],
        ['await page.locator("a").filter({ has: "b" }).click();', /not allowed/],
        ['await page.getByText(/a/v).click();', /Unsupported regular expression flags/],
        ["await page.goto(\"/\"); await page.goto(\"/\"); x = 1;", /only await statements/],
        ["for (;;) {}", /only await statements/],
        ["while (true) {}", /only await statements/],
        ["if (1) {}", /only await statements/],
        ['await new Function("return 1")();', /not allowed/],
        ['await page.getByText("a").click().then(() => 1);', /not allowed/],
        ["await (async () => 1)();", /Functions are only allowed/],
        ['await `x`.constructor.constructor("return process")();', /not allowed/],
        ['await page.getByText(/a/).constructor.constructor("return process")();', /not allowed/],
        ['let button = page.getByText("a");', /Only const locator declarations/],
        ['const { goto } = page;', /Destructuring is not allowed/],
        ['const page2 = page;', /Only locators can be stored/],
        ['const k = page.keyboard;', /Only locators can be stored/],
        ['const page = page.getByText("a");', /"page" is reserved/],
        ['const a = page.getByText("a");\n        const a = page.getByText("b");', /already been declared/],
        ['const a = page.getByText("a");\n        await step("x", async () => { const a = page.getByText("b"); await a.click(); });', /Steps cannot be nested/],
        ['const a: any = page.getByText("a");', /Type annotations/],
        ['await undeclared.click();', /"undeclared" is not available/],
    ];
    for (const [statement, pattern] of cases) {
        test(statement, () => {
            assert.match(errorOf(spec(statement)), pattern);
        });
    }

    test("locator constants are block scoped", () => {
        const source = 'import { test } from "specbook";\ntest("T", async ({ page, step }) => {\n' +
            '    await step("A", async () => {\n        const button = page.getByRole("button");\n        await button.click();\n    });\n' +
            '    await step("B", async () => {\n        await button.click();\n    });\n});\n';
        assert.match(errorOf(source), /"button" is not available/);
    });

    test("fixtures and expect must be destructured or imported before use", () => {
        assert.match(errorOf(spec('await page.getByText("a").fill(secret("a", "b"));', "page, step")), /Destructure secret/);
        assert.match(errorOf(spec("await expect(page).toHaveTitle(\"x\");", "page, step", 'import { test } from "specbook";')), /Import expect/);
        assert.match(errorOf(spec("await page.reload();", "step")), /Destructure page/);
    });

    test("rejects oversized sources", () => {
        assert.match(errorOf(`${VALID_SPEC}//${"x".repeat(200_001)}`), /larger than/);
    });
});

describe("named steps", () => {
    test("step() titles must match spec.yml steps in order, ignoring case and spacing", () => {
        assert.equal(stepTitlesError(["Open the page", "Log in"], ["open  the page.", "Log in"]), null);
        assert.match(stepTitlesError(["Log in", "Open the page"], ["Open the page", "Log in"]) ?? "", /step 1 of spec\.ts is "Log in" but spec\.yml expects "Open the page"/);
        assert.match(stepTitlesError(["Open the page"], ["Open the page", "Log in"]) ?? "", /no step\(\) for step 2 "Log in"/);
        assert.match(stepTitlesError(["Open the page", "Extra"], ["Open the page"]) ?? "", /extra step 2 "Extra"/);
        assert.match(stepTitlesError(["Open the page"], []) ?? "", /spec\.yml lists no steps/);
    });

    test("validateSpecSource applies the rule when spec.yml is known", () => {
        assert.deepEqual(validateSpecSource(VALID_SPEC, { steps: ["Abrir a página"] }), { ok: true });
        assert.equal(validateSpecSource(VALID_SPEC, { steps: ["Outro"] }).ok, false);
        assert.deepEqual(validateSpecSource(VALID_SPEC), { ok: true });
    });

    test("secretEnvRefs lists the secrets a valid Spec types", () => {
        assert.deepEqual(secretEnvRefs(LOGIN_SPEC), ["SPECBOOK_SECRET_SHOPPER_EMAIL", "SPECBOOK_SECRET_SHOPPER_PASSWORD"]);
        assert.deepEqual(secretEnvRefs("not valid"), []);
    });
});

describe("agent instructions", () => {
    test("the spec.ts example in the standard system prompt passes the validator", async () => {
        const { readFile } = await import("node:fs/promises");
        const prompt = await readFile(new URL("../../src/core/chat/prompts/standard-system-prompt.txt", import.meta.url), "utf8");
        const lines = prompt.split("\n");
        const start = lines.findIndex((line) => line.startsWith("- Example"));
        const steps = JSON.parse(/humanSpec\.steps: (\[.*\])\)/.exec(lines[start])?.[1] ?? "[]") as string[];
        const body: string[] = [];
        for (const line of lines.slice(start + 1)) {
            if (!line.startsWith("  ")) break;
            body.push(line.slice(2));
        }
        assert.deepEqual(validateSpecSource(body.join("\n"), { steps }), { ok: true });
        assert.equal(steps.length, 3);
    });
});
