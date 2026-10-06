import { parse } from "@babel/parser";
import type * as t from "@babel/types";
import type { HumanSpec } from "../../infra/db/schema";
import { isSafeRelativePath, SECRET_NAME_PATTERN, secretEnvName } from "./specbook/guard";

/**
 * Static validation of spec.ts. The file is untrusted (pushed through Git or written
 * by the LLM) and executes in a Node process, so this is an allowlist over the AST:
 * anything that is not explicitly described below is rejected.
 *
 *   import { test, expect } from "specbook";
 *   test("Title", async ({ page, step, secret }) => {
 *       const x = page.getByRole(...);            // optional locator constants
 *       await step("Named step", async () => {
 *           await page.<action>(...);            // allowlisted Page/Locator calls
 *           await expect(<page | locator>).[not.]<matcher>(...);
 *       });
 *   });
 *
 * Arguments are literals only (plus locator constants and secret(...) as fill text).
 */

export type SpecSourceValidation = { ok: true } | { ok: false; error: string };

export interface SecretRef {
    profile: string;
    field: string;
    envName: string;
}

export interface SpecAnalysis {
    testTitle: string;
    /** Titles of the step() blocks, in order. */
    steps: string[];
    secretRefs: SecretRef[];
    /** Offsets of the "specbook" string of the import, replaced when the file runs. */
    importSource: { start: number; end: number };
}

export const SPEC_MODULE = "specbook";
const MAX_SOURCE_CHARS = 200_000;
const MAX_STEPS = 100;
const FIXTURES = new Set(["page", "step", "secret"]);
const IMPORTS = new Set(["test", "expect"]);
const RESERVED = new Set([...FIXTURES, ...IMPORTS]);
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export const LOCATOR_FACTORIES = [
    "getByRole",
    "getByLabel",
    "getByText",
    "getByPlaceholder",
    "getByTestId",
    "getByAltText",
    "getByTitle",
    "locator",
];
const LOCATOR_REFINERS = ["first", "last", "nth", "filter", "and", "or"];
export const PAGE_ACTIONS = ["goto", "reload", "goBack", "goForward", "waitForURL", "waitForLoadState"];
export const LOCATOR_ACTIONS = [
    "click",
    "dblclick",
    "fill",
    "press",
    "pressSequentially",
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
];
const KEYBOARD_ACTIONS = ["press", "type"];
const PAGE_MATCHERS = ["toHaveURL", "toHaveTitle", "toMatchAriaSnapshot"];
export const LOCATOR_MATCHERS = [
    "toBeVisible",
    "toBeHidden",
    "toBeEnabled",
    "toBeDisabled",
    "toBeChecked",
    "toBeEditable",
    "toBeFocused",
    "toHaveText",
    "toContainText",
    "toHaveValue",
    "toHaveValues",
    "toHaveAttribute",
    "toHaveCount",
    "toHaveClass",
    "toBeEmpty",
    "toHaveAccessibleName",
    "toMatchAriaSnapshot",
];
const TEXT_METHODS = new Set(["fill", "pressSequentially", "type"]);

type ChainKind = "page" | "locator" | "keyboard";

class SpecSourceError extends Error {}

function where(node: t.Node | null | undefined): string {
    const start = node?.loc?.start;
    return start ? `Line ${start.line}, column ${start.column + 1}: ` : "";
}

function fail(node: t.Node | null | undefined, message: string): never {
    throw new SpecSourceError(`${where(node)}${message}`);
}

function list(values: string[]): string {
    return values.join(", ");
}

/** A string literal or a template literal without ${...} expressions. */
function staticString(node: t.Node | null | undefined): string | null {
    if (!node) return null;
    if (node.type === "StringLiteral") return node.value;
    if (node.type === "TemplateLiteral" && node.expressions.length === 0 && node.quasis.length === 1) {
        return node.quasis[0].value.cooked ?? null;
    }
    return null;
}

function noTypeArguments(node: t.CallExpression): void {
    const typed = node as t.CallExpression & { typeArguments?: unknown; typeParameters?: unknown };
    if (typed.typeArguments || typed.typeParameters) fail(node, "Type arguments are not allowed.");
}

class Validator {
    private readonly fixtures = new Set<string>();
    private readonly imports = new Set<string>();
    private readonly scopes: Set<string>[] = [];
    readonly steps: string[] = [];
    readonly secretRefs = new Map<string, SecretRef>();
    testTitle = "";
    importSource = { start: 0, end: 0 };

    run(file: t.File): void {
        const program = file.program;
        if (program.interpreter) fail(program.interpreter, "A hashbang line is not allowed.");
        if (program.directives.length > 0) fail(program.directives[0], "Directives are not allowed.");
        const [first, second, ...rest] = program.body;
        if (!first || first.type !== "ImportDeclaration") {
            fail(first, `spec.ts must start with: import { test, expect } from "${SPEC_MODULE}";`);
        }
        this.importDeclaration(first);
        if (!second) fail(first, 'After the import, spec.ts must contain exactly one test("Title", async ({ page, step }) => { ... }) call.');
        if (rest.length > 0) {
            fail(rest[0], "spec.ts must contain only the specbook import and one test(...) call; move everything else inside step() blocks.");
        }
        this.testCall(second);
    }

    private importDeclaration(node: t.ImportDeclaration): void {
        const declaration = node as t.ImportDeclaration & { phase?: unknown; attributes?: unknown[]; assertions?: unknown[] };
        if (declaration.importKind === "type" || declaration.importKind === "typeof" || declaration.phase) {
            fail(node, `Only a value import from "${SPEC_MODULE}" is allowed.`);
        }
        if (node.source.value !== SPEC_MODULE) {
            fail(node.source, `Imports from "${node.source.value}" are not allowed; import only { test, expect } from "${SPEC_MODULE}".`);
        }
        if ((declaration.attributes?.length ?? 0) > 0 || (declaration.assertions?.length ?? 0) > 0) {
            fail(node, "Import attributes are not allowed.");
        }
        for (const specifier of node.specifiers) {
            if (specifier.type !== "ImportSpecifier" || specifier.imported.type !== "Identifier") {
                fail(specifier, `Import only named bindings: import { test, expect } from "${SPEC_MODULE}".`);
            }
            const name = specifier.imported.name;
            if (!IMPORTS.has(name)) fail(specifier, `"${name}" is not exported by "${SPEC_MODULE}"; import only test and expect.`);
            if (specifier.local.name !== name) fail(specifier, "Renaming imports is not allowed.");
            if (specifier.importKind === "type" || specifier.importKind === "typeof") fail(specifier, "Type imports are not allowed.");
            if (this.imports.has(name)) fail(specifier, `"${name}" is imported twice.`);
            this.imports.add(name);
        }
        if (!this.imports.has("test")) fail(node, `Import test from "${SPEC_MODULE}".`);
        this.importSource = { start: node.source.start ?? 0, end: node.source.end ?? 0 };
    }

    private testCall(statement: t.Statement): void {
        const call = statement.type === "ExpressionStatement" ? statement.expression : null;
        if (!call || call.type !== "CallExpression" || call.callee.type !== "Identifier" || call.callee.name !== "test") {
            fail(statement, 'Expected one test("Title", async ({ page, step }) => { ... }) call.');
        }
        noTypeArguments(call);
        if (call.arguments.length !== 2) fail(call, "test() takes a title and an async function.");
        const title = staticString(call.arguments[0]);
        if (title === null || !title.trim()) fail(call.arguments[0], "The test title must be a non-empty string literal.");
        this.testTitle = title.trim();
        const fn = call.arguments[1];
        if (fn.type !== "ArrowFunctionExpression" || !fn.async) {
            fail(fn, "The test body must be an async arrow function: async ({ page, step }) => { ... }.");
        }
        if (fn.returnType || fn.typeParameters) fail(fn, "Type annotations are not allowed.");
        if (fn.params.length !== 1 || fn.params[0].type !== "ObjectPattern") {
            fail(fn, "The test function takes one destructured parameter: ({ page, step, secret }).");
        }
        const pattern = fn.params[0];
        if (pattern.typeAnnotation || pattern.decorators?.length) fail(pattern, "Type annotations are not allowed.");
        for (const property of pattern.properties) {
            if (
                property.type !== "ObjectProperty" ||
                property.computed ||
                !property.shorthand ||
                property.key.type !== "Identifier" ||
                property.value.type !== "Identifier" ||
                property.value.name !== property.key.name
            ) {
                fail(property, "Destructure only page, step and secret, without defaults or renaming.");
            }
            const name = property.key.name;
            if (!FIXTURES.has(name)) fail(property, `Fixture "${name}" is not available; use only page, step and secret.`);
            if (this.fixtures.has(name)) fail(property, `"${name}" is destructured twice.`);
            this.fixtures.add(name);
        }
        if (fn.body.type !== "BlockStatement") fail(fn.body, "The test body must be a block: async ({ page, step }) => { ... }.");
        if (fn.body.directives.length > 0) fail(fn.body.directives[0], "Directives are not allowed.");
        this.scopes.push(new Set());
        for (const item of fn.body.body) {
            if (item.type === "VariableDeclaration") this.locatorDeclaration(item);
            else this.stepStatement(item);
        }
        this.scopes.pop();
        if (this.steps.length === 0) fail(fn, 'The test must contain at least one await step("Title", async () => { ... }) block.');
    }

    private stepStatement(statement: t.Statement): void {
        const call = statement.type === "ExpressionStatement" && statement.expression.type === "AwaitExpression"
            ? statement.expression.argument
            : null;
        if (!call || call.type !== "CallExpression" || call.callee.type !== "Identifier" || call.callee.name !== "step") {
            fail(
                statement,
                'The test body may contain only await step("Title", async () => { ... }) blocks and const locator declarations. Put every action and assertion inside a named step.',
            );
        }
        if (!this.fixtures.has("step")) fail(call, "Destructure step from the test fixtures: async ({ page, step }) => ...");
        noTypeArguments(call);
        if (call.arguments.length !== 2) fail(call, "step() takes a title and an async function.");
        const title = staticString(call.arguments[0]);
        if (title === null || !title.trim()) fail(call.arguments[0], "Step titles must be non-empty string literals.");
        const fn = call.arguments[1];
        if (fn.type !== "ArrowFunctionExpression" || !fn.async || fn.params.length !== 0) {
            fail(fn, "A step body must be an async arrow function without parameters: async () => { ... }.");
        }
        if (fn.returnType || fn.typeParameters) fail(fn, "Type annotations are not allowed.");
        if (fn.body.type !== "BlockStatement") fail(fn.body, "A step body must be a block: async () => { ... }.");
        if (fn.body.directives.length > 0) fail(fn.body.directives[0], "Directives are not allowed.");
        if (this.steps.length >= MAX_STEPS) fail(call, `A Spec may have at most ${MAX_STEPS} steps.`);
        this.steps.push(title.trim());
        this.scopes.push(new Set());
        let awaited = 0;
        for (const item of fn.body.body) {
            if (item.type === "VariableDeclaration") {
                this.locatorDeclaration(item);
                continue;
            }
            if (item.type !== "ExpressionStatement" || item.expression.type !== "AwaitExpression") {
                fail(item, "Inside a step, write only await statements (actions and expect assertions) and const locator declarations.");
            }
            this.awaited(item.expression.argument);
            awaited += 1;
        }
        this.scopes.pop();
        if (awaited === 0) fail(fn, `Step "${title.trim()}" must contain at least one action or assertion.`);
    }

    private isLocatorConstant(name: string): boolean {
        return this.scopes.some((scope) => scope.has(name));
    }

    private locatorDeclaration(node: t.VariableDeclaration): void {
        if (node.kind !== "const" || node.declare) fail(node, "Only const locator declarations are allowed.");
        if (node.declarations.length !== 1) fail(node, "Declare one locator per const statement.");
        const [declarator] = node.declarations;
        if (declarator.id.type !== "Identifier") fail(declarator.id, "Destructuring is not allowed in declarations.");
        const id = declarator.id as t.Identifier & { definite?: boolean };
        if (id.typeAnnotation || id.definite) fail(id, "Type annotations are not allowed.");
        if (RESERVED.has(id.name)) fail(id, `"${id.name}" is reserved.`);
        if (this.isLocatorConstant(id.name)) fail(id, `"${id.name}" is already declared.`);
        if (!declarator.init) fail(declarator, "A locator constant needs a value, like const button = page.getByRole(\"button\").");
        if (!["CallExpression", "Identifier", "MemberExpression"].includes(declarator.init.type) || this.chain(declarator.init) !== "locator") {
            fail(declarator.init, "Only locators can be stored in constants, like const button = page.getByRole(\"button\", { name: \"Save\" }).");
        }
        this.scopes[this.scopes.length - 1].add(id.name);
    }

    /** Type of a page/locator/keyboard expression that is not an action. */
    private chain(node: t.Node): ChainKind {
        if (node.type === "Identifier") {
            if (node.name === "page") {
                if (!this.fixtures.has("page")) fail(node, "Destructure page from the test fixtures: async ({ page, step }) => ...");
                return "page";
            }
            if (this.isLocatorConstant(node.name)) return "locator";
            fail(node, `"${node.name}" is not available. Specs can only use page, step, secret, expect and their own locator constants.`);
        }
        if (node.type === "MemberExpression") {
            if (node.computed || node.property.type !== "Identifier") fail(node, "Computed property access (x[...]) is not allowed.");
            const kind = this.chain(node.object);
            if (kind === "page" && node.property.name === "keyboard") return "keyboard";
            fail(node.property, `Property "${node.property.name}" is not allowed; call an allowed method instead.`);
        }
        if (node.type === "CallExpression") {
            noTypeArguments(node);
            const callee = node.callee;
            if (callee.type !== "MemberExpression") fail(node, "Only page and locator methods can be called here.");
            if (callee.computed || callee.property.type !== "Identifier") fail(callee, "Computed property access (x[...]) is not allowed.");
            const kind = this.chain(callee.object);
            const method = callee.property.name;
            if (kind === "page" && LOCATOR_FACTORIES.includes(method)) {
                this.locatorFactoryArgs(method, node);
                return "locator";
            }
            if (kind === "locator" && (LOCATOR_FACTORIES.includes(method) || LOCATOR_REFINERS.includes(method))) {
                if (LOCATOR_FACTORIES.includes(method)) this.locatorFactoryArgs(method, node);
                else this.refinerArgs(method, node);
                return "locator";
            }
            fail(callee.property, this.unknownMethod(kind, method));
        }
        return fail(node, this.unexpected(node));
    }

    private unexpected(node: t.Node): string {
        switch (node.type) {
            case "OptionalMemberExpression":
            case "OptionalCallExpression":
                return "Optional chaining (?.) is not allowed.";
            case "SequenceExpression":
                return "Comma expressions are not allowed.";
            case "TaggedTemplateExpression":
                return "Tagged templates are not allowed.";
            case "ArrowFunctionExpression":
            case "FunctionExpression":
                return "Functions are only allowed as the bodies of test() and step().";
            case "AssignmentExpression":
                return "Assignments are not allowed.";
            case "Import":
            case "ImportExpression":
                return "Dynamic import() is not allowed.";
            case "CallExpression":
                return "Calling the result of a call is not allowed.";
            case "NewExpression":
                return "new is not allowed.";
            case "TSNonNullExpression":
            case "TSAsExpression":
            case "TSSatisfiesExpression":
            case "TSTypeAssertion":
                return "TypeScript type expressions are not allowed.";
            default:
                return `${node.type} is not allowed here.`;
        }
    }

    private unknownMethod(kind: ChainKind, method: string): string {
        if (kind === "page") {
            return `page.${method}() is not allowed. Page methods: ${list([...PAGE_ACTIONS, ...LOCATOR_FACTORIES])}, keyboard.press(), keyboard.type().`;
        }
        if (kind === "keyboard") return `page.keyboard.${method}() is not allowed; use keyboard.press() or keyboard.type().`;
        return `Locator method ${method}() is not allowed. Locator methods: ${list([...LOCATOR_FACTORIES, ...LOCATOR_REFINERS, ...LOCATOR_ACTIONS])}.`;
    }

    private awaited(expression: t.Expression): void {
        const onlyActions = "Await only page/locator actions and expect(...) assertions.";
        if (expression.type !== "CallExpression") fail(expression, `${this.unexpected(expression)} ${onlyActions}`);
        noTypeArguments(expression);
        const callee = expression.callee;
        if (callee.type === "Identifier" && callee.name === "step") fail(expression, "Steps cannot be nested.");
        if (callee.type === "Identifier") fail(callee, `"${callee.name}" is not available. ${onlyActions}`);
        if (callee.type !== "MemberExpression") fail(callee, `${this.unexpected(callee)} ${onlyActions}`);
        if (callee.computed || callee.property.type !== "Identifier") fail(callee, "Computed property access (x[...]) is not allowed.");
        const method = callee.property.name;
        const assertion = this.assertionTarget(callee.object);
        if (assertion) {
            const allowed = assertion === "page" ? PAGE_MATCHERS : LOCATOR_MATCHERS;
            if (!allowed.includes(method)) {
                fail(callee.property, `Matcher ${method}() is not allowed for ${assertion === "page" ? "the page" : "a locator"}. Allowed: ${list(allowed)}.`);
            }
            if (method === "toMatchAriaSnapshot") {
                if (staticString(expression.arguments[0]) === null) {
                    fail(expression, "toMatchAriaSnapshot() needs an inline snapshot string literal.");
                }
                if (expression.arguments[1] && expression.arguments[1].type !== "ObjectExpression") {
                    fail(expression.arguments[1], "toMatchAriaSnapshot() takes an options object after the snapshot.");
                }
            }
            this.plainArgs(expression, 0, 2);
            return;
        }
        const kind = this.chain(callee.object);
        const allowed = kind === "page" ? PAGE_ACTIONS : kind === "keyboard" ? KEYBOARD_ACTIONS : LOCATOR_ACTIONS;
        if (!allowed.includes(method)) {
            if (kind !== "keyboard" && (LOCATOR_FACTORIES.includes(method) || LOCATOR_REFINERS.includes(method))) {
                fail(callee.property, "A locator on its own does nothing; await an action (click, fill, ...) or an expect(...) assertion.");
            }
            fail(callee.property, this.unknownMethod(kind, method));
        }
        this.actionArgs(kind, method, expression);
    }

    /** "page" / "locator" when the node is expect(target) or expect(target).not. */
    private assertionTarget(node: t.Node): "page" | "locator" | null {
        let target = node;
        if (target.type === "MemberExpression" && !target.computed && target.property.type === "Identifier" && target.property.name === "not") {
            target = target.object;
        }
        if (target.type !== "CallExpression" || target.callee.type !== "Identifier" || target.callee.name !== "expect") {
            if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && node.callee.object.type === "Identifier" && node.callee.object.name === "expect") {
                fail(node, "expect.* helpers are not allowed; use expect(page or locator).<matcher>(...).");
            }
            return null;
        }
        if (!this.imports.has("expect")) fail(target, `Import expect from "${SPEC_MODULE}".`);
        noTypeArguments(target);
        if (target.arguments.length !== 1) fail(target, "expect() takes exactly one argument: the page or a locator.");
        const kind = this.chain(target.arguments[0]);
        if (kind === "keyboard") fail(target.arguments[0], "expect() takes the page or a locator.");
        return kind;
    }

    private locatorFactoryArgs(method: string, call: t.CallExpression): void {
        const [first] = call.arguments;
        if (!first) fail(call, `${method}() needs an argument.`);
        if (method === "locator") {
            const selector = staticString(first);
            if (selector === null) fail(first, "locator() takes a selector string literal.");
            if (selector.includes("internal:")) fail(first, 'Selectors may not use Playwright "internal:" engines.');
            if (call.arguments.length > 2) fail(call, "Too many arguments (at most 2).");
            if (call.arguments[1]) this.value(call.arguments[1], { locatorKeys: true, depth: 0 });
            return;
        } else if (method === "getByRole") {
            if (staticString(first) === null) fail(first, "getByRole() takes an ARIA role string, like getByRole(\"button\", { name: \"Save\" }).");
        } else if (staticString(first) === null && first.type !== "RegExpLiteral") {
            fail(first, `${method}() takes a string or a regular expression literal.`);
        }
        this.plainArgs(call, 0, 2);
    }

    private refinerArgs(method: string, call: t.CallExpression): void {
        const args = call.arguments;
        if (method === "first" || method === "last") {
            if (args.length > 0) fail(call, `${method}() takes no arguments.`);
        } else if (method === "nth") {
            if (args.length !== 1 || !this.isNumber(args[0])) fail(call, "nth() takes one number.");
        } else if (method === "filter") {
            if (args.length > 1) fail(call, "filter() takes one options object.");
            if (args[0]) this.value(args[0], { locatorKeys: true, depth: 0 });
        } else {
            if (args.length !== 1 || this.chainIsLocator(args[0]) === false) fail(call, `${method}() takes one locator.`);
        }
    }

    private chainIsLocator(node: t.Node): boolean {
        return this.chain(node) === "locator";
    }

    private isNumber(node: t.Node): boolean {
        return node.type === "NumericLiteral" || (node.type === "UnaryExpression" && node.operator === "-" && node.argument.type === "NumericLiteral");
    }

    private actionArgs(kind: ChainKind, method: string, call: t.CallExpression): void {
        const args = call.arguments;
        if (kind === "page" && method === "goto") {
            const target = staticString(args[0]);
            if (target === null || !isSafeRelativePath(target)) {
                fail(args[0] ?? call, 'page.goto() takes a path string starting with "/", like page.goto("/login"); the project base URL is added automatically.');
            }
            this.plainArgs(call, 1, 2);
            return;
        }
        if (TEXT_METHODS.has(method)) {
            const [text] = args;
            if (!text) fail(call, `${method}() needs the text to enter.`);
            if (!this.secretCall(text) && staticString(text) === null) {
                fail(text, `${method}() takes a string literal or secret("<profile>", "<field>").`);
            }
            this.plainArgs(call, 1, 2);
            return;
        }
        if ((method === "press" && kind !== "page") || method === "setChecked") {
            if (!args[0]) fail(call, `${method}() needs an argument.`);
        }
        this.plainArgs(call, 0, 2);
    }

    /** Validates call.arguments[from..] as literal values, with at most `max` arguments in total. */
    private plainArgs(call: t.CallExpression, from: number, max: number): void {
        if (call.arguments.length > max) fail(call, `Too many arguments (at most ${max}).`);
        for (const arg of call.arguments.slice(from)) this.value(arg, { locatorKeys: false, depth: 0 });
    }

    private secretCall(node: t.Node): boolean {
        if (node.type !== "CallExpression" || node.callee.type !== "Identifier" || node.callee.name !== "secret") return false;
        if (!this.fixtures.has("secret")) fail(node, "Destructure secret from the test fixtures: async ({ page, step, secret }) => ...");
        noTypeArguments(node);
        const [profile, field] = node.arguments.map((arg) => staticString(arg));
        if (node.arguments.length !== 2 || !profile || !field || !SECRET_NAME_PATTERN.test(profile) || !SECRET_NAME_PATTERN.test(field)) {
            fail(node, 'secret() takes a credential profile name and a field key as string literals, like secret("admin", "password").');
        }
        const envName = secretEnvName(profile, field);
        this.secretRefs.set(envName, { profile, field, envName });
        return true;
    }

    private value(node: t.Node, options: { locatorKeys: boolean; depth: number }): void {
        if (node.type === "SpreadElement" || node.type === "ArgumentPlaceholder") fail(node, "Spread arguments are not allowed.");
        if (staticString(node) !== null) return;
        switch (node.type) {
            case "NumericLiteral":
            case "BooleanLiteral":
                return;
            case "RegExpLiteral":
                if (/[^dgimsuy]/.test(node.flags)) fail(node, "Unsupported regular expression flags.");
                return;
            case "UnaryExpression":
                if (this.isNumber(node)) return;
                break;
            case "TemplateLiteral":
                fail(node, "Template literals cannot contain ${...} expressions.");
            case "CallExpression":
                if (node.callee.type === "Identifier" && node.callee.name === "secret") {
                    fail(node, "secret(...) may only be the text argument of fill(), pressSequentially() or keyboard.type().");
                }
                break;
            case "ArrayExpression":
                if (options.depth > 1) fail(node, "Values are nested too deeply.");
                for (const element of node.elements) {
                    if (!element) fail(node, "Array holes are not allowed.");
                    this.value(element, { locatorKeys: false, depth: options.depth + 1 });
                }
                return;
            case "ObjectExpression":
                if (options.depth > 1) fail(node, "Values are nested too deeply.");
                for (const property of node.properties) {
                    if (property.type !== "ObjectProperty" || property.computed || property.shorthand || property.key.type !== "Identifier") {
                        fail(property, "Option objects may only contain plain key: value pairs, like { name: \"Save\", exact: true }.");
                    }
                    const key = property.key.name;
                    if (FORBIDDEN_KEYS.has(key)) fail(property.key, `Option "${key}" is not allowed.`);
                    if (options.locatorKeys && (key === "has" || key === "hasNot")) {
                        if (!this.chainIsLocator(property.value)) fail(property.value, `${key} takes a locator.`);
                        continue;
                    }
                    this.value(property.value, { locatorKeys: false, depth: options.depth + 1 });
                }
                return;
            default:
                break;
        }
        fail(node, `${this.unexpectedValue(node)} Arguments must be literals (strings, numbers, booleans, regular expressions, arrays or { key: value } options).`);
    }

    private unexpectedValue(node: t.Node): string {
        if (node.type === "Identifier") return `"${node.name}" cannot be used as a value.`;
        if (node.type === "MemberExpression" || node.type === "CallExpression") return "Expressions cannot be used as values.";
        return this.unexpected(node);
    }
}

function parseSource(source: string): t.File {
    try {
        return parse(source, {
            sourceType: "module",
            plugins: ["typescript"],
            strictMode: true,
            errorRecovery: false,
            allowAwaitOutsideFunction: false,
            allowImportExportEverywhere: false,
            allowReturnOutsideFunction: false,
            allowSuperOutsideMethod: false,
            allowUndeclaredExports: false,
            createParenthesizedExpressions: false,
        }) as unknown as t.File;
    } catch (error) {
        const loc = (error as { loc?: { line: number; column: number } }).loc;
        const message = error instanceof Error ? error.message.replace(/\s*\(\d+:\d+\)$/, "") : String(error);
        throw new SpecSourceError(`${loc ? `Line ${loc.line}, column ${loc.column + 1}: ` : ""}Syntax error: ${message}`);
    }
}

export function analyzeSpecSource(source: string): { ok: true; analysis: SpecAnalysis } | { ok: false; error: string } {
    try {
        if (source.length > MAX_SOURCE_CHARS) throw new SpecSourceError(`spec.ts is larger than ${MAX_SOURCE_CHARS} characters.`);
        const validator = new Validator();
        validator.run(parseSource(source));
        return {
            ok: true,
            analysis: {
                testTitle: validator.testTitle,
                steps: validator.steps,
                secretRefs: [...validator.secretRefs.values()],
                importSource: validator.importSource,
            },
        };
    } catch (error) {
        if (error instanceof SpecSourceError) return { ok: false, error: error.message };
        throw error;
    }
}

function comparable(title: string): string {
    return title.trim().replace(/\s+/g, " ").replace(/[.;:]+$/, "").toLowerCase();
}

/** The named-steps rule: step() titles must be the Spec's steps from spec.yml, in order. */
export function stepTitlesError(stepTitles: string[], humanSteps: string[]): string | null {
    const expected = humanSteps.map((step) => step.trim()).filter(Boolean);
    const numbered = (titles: string[]) => titles.map((title, index) => `${index + 1}. "${title}"`).join(" ");
    if (expected.length === 0) {
        return `spec.yml lists no steps. Add one step per step() block of spec.ts, in order: ${numbered(stepTitles)}.`;
    }
    const mismatch = expected.findIndex((title, index) => comparable(title) !== comparable(stepTitles[index] ?? ""));
    if (mismatch < 0 && expected.length === stepTitles.length) return null;
    const index = mismatch < 0 ? expected.length : mismatch;
    const detail = index < expected.length
        ? stepTitles[index] === undefined
            ? `spec.ts has no step() for step ${index + 1} "${expected[index]}".`
            : `step ${index + 1} of spec.ts is "${stepTitles[index]}" but spec.yml expects "${expected[index]}".`
        : `spec.ts has an extra step ${index + 1} "${stepTitles[index]}".`;
    return `The step() titles in spec.ts must match the steps in spec.yml, in the same order: ${detail} spec.yml steps: ${numbered(expected)}.`;
}

/** Full validation of a Spec's executable, including the named-steps rule when spec.yml is known. */
export function validateSpecSource(source: string, humanSpec?: Pick<HumanSpec, "steps"> | null): SpecSourceValidation {
    const result = analyzeSpecSource(source);
    if (!result.ok) return result;
    if (humanSpec) {
        const error = stepTitlesError(result.analysis.steps, humanSpec.steps);
        if (error) return { ok: false, error };
    }
    return { ok: true };
}

/** Env names of the secrets a valid spec.ts types (empty for an invalid source). */
export function secretEnvRefs(source: string): string[] {
    const result = analyzeSpecSource(source);
    return result.ok ? result.analysis.secretRefs.map((ref) => ref.envName) : [];
}
