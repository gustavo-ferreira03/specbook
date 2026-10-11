import { parse } from "@babel/parser";
import type * as t from "@babel/types";
import { analyzeSpecSource } from "@specbook/runtime/validate";
import { LOCATOR_FACTORIES, STATIC_LOCATOR_REFINERS } from "@specbook/runtime/specbook/allowlist";
import type { Locator, Page } from "playwright-core";

const methods = new Set([...LOCATOR_FACTORIES, ...STATIC_LOCATOR_REFINERS]);

export interface LocatorCheck {
    locator: string;
    line: number;
    count: number | null;
    status: "matched" | "missing" | "ambiguous" | "error";
    error?: string;
}

// Interpret only validated locator syntax; never evaluate Spec code in the browser or Node.
export async function checkPageLocators(page: Page, source: string): Promise<LocatorCheck[]> {
    const validation = analyzeSpecSource(source);
    if (!validation.ok) throw new Error(validation.error);
    const tree = parse(source, { sourceType: "module", plugins: ["typescript"] });
    const found: { locator: string; node: t.Node; bindings: Map<string, t.Node> }[] = [];
    const isLocatorCall = (node: t.Node | null | undefined): node is t.CallExpression => node?.type === "CallExpression"
        && node.callee.type === "MemberExpression" && !node.callee.computed
        && node.callee.property.type === "Identifier" && methods.has(node.callee.property.name);
    const walk = (node: t.Node, bindings: Map<string, t.Node>, parent?: t.Node) => {
        if (node.type === "ArrowFunctionExpression") bindings = new Map(bindings);
        if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init) bindings.set(node.id.name, node.init);
        if (isLocatorCall(node)) {
            const chained = parent?.type === "MemberExpression" && parent.object === node
                && parent.property.type === "Identifier" && methods.has(parent.property.name);
            if (!chained) found.push({ locator: source.slice(node.start ?? 0, node.end ?? 0), node, bindings: new Map(bindings) });
        }
        for (const item of Object.values(node)) {
            if (Array.isArray(item)) {
                for (const child of item) if (child && typeof child.type === "string") walk(child as t.Node, bindings, node);
            } else if (item && typeof item === "object" && "type" in item && typeof item.type === "string") walk(item as t.Node, bindings, node);
        }
    };
    walk(tree, new Map());
    const value = (node: t.Node, bindings: Map<string, t.Node>): unknown => {
        switch (node.type) {
            case "StringLiteral": case "NumericLiteral": case "BooleanLiteral": return node.value;
            case "NullLiteral": return null;
            case "RegExpLiteral": return new RegExp(node.pattern, node.flags);
            case "TemplateLiteral": return node.quasis[0]?.value.cooked;
            case "UnaryExpression":
                if (node.operator === "-" && node.argument.type === "NumericLiteral") return -node.argument.value;
                break;
            case "ObjectExpression": {
                const result: Record<string, unknown> = Object.create(null);
                for (const property of node.properties) {
                    if (property.type !== "ObjectProperty") throw new Error("Unsupported locator option");
                    const key = property.key.type === "Identifier" ? property.key.name : property.key.type === "StringLiteral" ? property.key.value : "";
                    result[key] = value(property.value, bindings);
                }
                return result;
            }
            case "ArrayExpression": return node.elements.map((item) => item ? value(item, bindings) : null);
            case "Identifier":
                if (node.name === "page") return page;
                if (bindings.has(node.name)) return value(bindings.get(node.name)!, bindings);
                break;
            case "CallExpression": {
                if (!isLocatorCall(node)) break;
                const callee = node.callee as t.MemberExpression;
                const target = value(callee.object, bindings) as Page | Locator;
                const method = (callee.property as t.Identifier).name;
                const args = node.arguments.map((item) => value(item, bindings));
                return (target as unknown as Record<string, (...args: unknown[]) => unknown>)[method]!.apply(target, args);
            }
        }
        throw new Error("Unsupported locator expression");
    };
    const results: LocatorCheck[] = [];
    for (const item of found) {
        const locator = item.locator;
        try {
            const count = await (value(item.node, item.bindings) as Locator).count();
            results.push({ locator, line: item.node.loc?.start.line ?? 1, count,
                status: count === 0 ? "missing" : count > 1 ? "ambiguous" : "matched" });
        } catch (error) {
            results.push({ locator, line: item.node.loc?.start.line ?? 1, count: null, status: "error",
                error: error instanceof Error ? error.message : String(error) });
        }
    }
    return results;
}
