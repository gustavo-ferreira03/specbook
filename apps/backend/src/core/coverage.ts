import path from "node:path";
import { parse } from "@babel/parser";
import type * as t from "@babel/types";
import { featuresRepository, type Feature } from "../infra/repositories/features";
import { projectContextsRepository } from "../infra/repositories/project-contexts";
import { specsRepository, type Spec } from "../infra/repositories/specs";
import { repoGit } from "./repo/git";
import { readRepoFile } from "./repo/safe-fs";
import { markdownHashOf, sourceHashOf, specTestFile, specYamlFile } from "./repo/writer";
import { parseSpecYaml } from "./repo/yaml";
import { validateSpecSource } from "./runner/validate";

type CoverageStatus = "covered" | "partial" | "uncovered";
export interface CoverageArea {
    name: string;
    routes: string[];
    coverage: CoverageStatus;
    reason: string;
    featureId: string | null;
    specs: { id: string; title: string }[];
    uncoveredRoutes: string[];
}

function routePath(value: string): string | null {
    try {
        const url = new URL(value, "https://coverage.invalid");
        return ["http:", "https:"].includes(url.protocol) ? `${url.pathname.replace(/\/$/, "") || "/"}${url.hash}` : null;
    } catch { return null; }
}

function matchesRoute(route: string, tested: string): boolean {
    const expected = routePath(route)?.split("/");
    const actual = routePath(tested)?.split("/");
    return Boolean(expected && actual && expected.length === actual.length && expected.every((part, index) => part === actual[index] || (/^:[\w-]+$|^%7B[\w-]+%7D$/i.test(part) && Boolean(actual[index]))));
}

function testedRoutes(source: string): string[] {
    const routes = new Set<string>();
    const visit = (node: t.Node) => {
        if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && !node.callee.computed && node.callee.property.type === "Identifier") {
            const member = node.callee;
            const method = node.callee.property.name;
            const fixtureCall = member.object.type === "Identifier"
                && ((member.object.name === "page" && ["goto", "waitForURL"].includes(method)) || (member.object.name === "request" && ["get", "post", "put", "patch", "delete"].includes(method)));
            const assertion = method === "toHaveURL" && member.object.type === "CallExpression" && member.object.callee.type === "Identifier"
                && member.object.callee.name === "expect" && member.object.arguments[0]?.type === "Identifier" && member.object.arguments[0].name === "page";
            const argument = node.arguments[0];
            const value = argument?.type === "StringLiteral" ? argument.value
                : argument?.type === "TemplateLiteral" && argument.expressions.length === 0 ? argument.quasis[0]?.value.cooked : null;
            if ((fixtureCall || assertion) && value && routePath(value)) routes.add(value);
        }
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) for (const child of value) { if (child && typeof child === "object" && typeof child.type === "string") visit(child); }
            else if (value && typeof value === "object" && "type" in value && typeof value.type === "string") visit(value as t.Node);
        }
    };
    visit(parse(source, { sourceType: "module", plugins: ["typescript"] }));
    return [...routes];
}

type Implementation = { valid: boolean; routes: string[] };
const analyses = new Map<string, { sourceHash: string; markdownHash: string; result: Implementation }>();

async function implementation(spec: Spec): Promise<Implementation> {
    if (spec.status === "invalid") return { valid: false, routes: [] };
    const root = repoGit.getRepoDir(spec.projectId);
    try {
        // The files are read on every call so edits on disk and unsafe links are still noticed; only the parse is reused.
        const [source, yaml] = await Promise.all([readRepoFile(root, path.resolve(root, specTestFile(spec.path))), readRepoFile(root, path.resolve(root, specYamlFile(spec.path)))]);
        if (sourceHashOf(source) !== spec.sourceHash || markdownHashOf(yaml) !== spec.markdownHash) return { valid: false, routes: [] };
        const cached = analyses.get(spec.id);
        if (cached?.sourceHash === spec.sourceHash && cached.markdownHash === spec.markdownHash) return cached.result;
        const valid = validateSpecSource(source, parseSpecYaml(yaml).humanSpec).ok;
        const result = { valid, routes: valid ? testedRoutes(source) : [] };
        analyses.set(spec.id, { sourceHash: spec.sourceHash, markdownHash: spec.markdownHash, result });
        return result;
    } catch { return { valid: false, routes: [] }; }
}

function subtree(rootId: string, features: Feature[]): Set<string> {
    const ids = new Set([rootId]);
    for (let size = 0; size !== ids.size;) {
        size = ids.size;
        for (const feature of features) if (feature.parentId && ids.has(feature.parentId)) ids.add(feature.id);
    }
    return ids;
}

export async function projectCoverage(projectId: string) {
    const [revision, features, specs] = await Promise.all([
        projectContextsRepository.getLatestConfirmedProjectContext(projectId), featuresRepository.listFeatures(projectId), specsRepository.listSpecs(projectId),
    ]);
    const details = new Map(await Promise.all(specs.map(async (spec) => [spec.id, await implementation(spec)] as const)));
    const testsRoute = (spec: Spec, route: string) => Boolean(details.get(spec.id)?.routes.some((tested) => matchesRoute(route, tested)));
    const areas = (revision?.context.areas ?? []).map(({ name, routes }): CoverageArea => {
        const feature = features.find((item) => item.title.trim().toLowerCase() === name.trim().toLowerCase());
        const featureIds = feature ? subtree(feature.id, features) : new Set<string>();
        const matched = specs.filter((spec) => featureIds.has(spec.featureId) || routes.some((route) => testsRoute(spec, route)));
        const valid = matched.filter((spec) => details.get(spec.id)?.valid);
        const uncoveredRoutes = routes.filter((route) => !valid.some((spec) => testsRoute(spec, route)));
        const coverage: CoverageStatus = !matched.length ? "uncovered" : valid.length && !uncoveredRoutes.length ? "covered" : "partial";
        const reason = coverage === "uncovered" ? "No Specs yet"
            : !valid.length ? "Specs need repairing"
            : coverage === "partial" ? `${uncoveredRoutes.length} known route${uncoveredRoutes.length === 1 ? "" : "s"} without a Spec`
            : routes.length ? "Specs reach every known route" : "Specs exist";
        return { name, routes, coverage, reason, featureId: feature?.id ?? null, specs: matched.map((spec) => ({ id: spec.id, title: spec.title })), uncoveredRoutes };
    });
    return { confirmed: Boolean(revision), basis: "An area's Specs are the Specs in its feature and any Spec that opens one of its routes. They show where Specs exist, not complete behavioral coverage.", areas };
}
