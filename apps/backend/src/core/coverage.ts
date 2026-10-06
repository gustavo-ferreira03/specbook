import path from "node:path";
import { parse } from "@babel/parser";
import type * as t from "@babel/types";
import type { RunEnvironment } from "../infra/db/schema";
import { featuresRepository, type Feature } from "../infra/repositories/features";
import { projectContextsRepository } from "../infra/repositories/project-contexts";
import { runsRepository, type Run } from "../infra/repositories/runs";
import { specsRepository, type Spec } from "../infra/repositories/specs";
import { ciResult } from "./ci/results";
import { resolveRunEnvironment } from "./environments";
import { matchesCurrentSpec } from "./jobs/current-run";
import { repoGit } from "./repo/git";
import { readRepoFile } from "./repo/safe-fs";
import { markdownHashOf, sourceHashOf, specTestFile, specYamlFile } from "./repo/writer";
import { parseSpecYaml } from "./repo/yaml";
import { listRunBatches } from "./runner/batch";
import { validateSpecSource } from "./runner/validate";

type CoverageStatus = "covered" | "partial" | "uncovered";
type SpecHealth = "passing" | "failing" | "flaky" | "draft" | "notRun" | "invalid" | "running";
export interface CoverageArea {
    kind: "area" | "role" | "rule";
    name: string;
    description: string;
    routes: string[];
    coverage: CoverageStatus;
    featureIds: string[];
    specIds: string[];
    matchedRoutes: string[];
    reason: string;
}

const normalize = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const contains = (text: string, phrase: string) => Boolean(normalize(phrase)) && ` ${normalize(text)} `.includes(` ${normalize(phrase)} `);
const emptyCounts = (): Record<SpecHealth, number> => ({ passing: 0, failing: 0, flaky: 0, draft: 0, notRun: 0, invalid: 0, running: 0 });

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

async function implementation(spec: Spec): Promise<{ valid: boolean; routes: string[] }> {
    if (spec.status === "invalid") return { valid: false, routes: [] };
    const root = repoGit.getRepoDir(spec.projectId);
    try {
        const [source, yaml] = await Promise.all([readRepoFile(root, path.resolve(root, specTestFile(spec.path))), readRepoFile(root, path.resolve(root, specYamlFile(spec.path)))]);
        const human = parseSpecYaml(yaml).humanSpec;
        const valid = sourceHashOf(source) === spec.sourceHash && markdownHashOf(yaml) === spec.markdownHash && validateSpecSource(source, human).ok;
        return { valid, routes: valid ? testedRoutes(source) : [] };
    } catch { return { valid: false, routes: [] }; }
}

function inEnvironment(run: { environment?: RunEnvironment | null }, environment: RunEnvironment): boolean {
    return run.environment ? run.environment.id === environment.id : environment.name === "Production";
}

async function latestRun(specId: string, environment: RunEnvironment): Promise<Run | undefined> {
    let before: string | undefined;
    for (;;) {
        const rows = await runsRepository.listRuns(specId, { limit: 200, before });
        const latest = rows.find((run) => inEnvironment(run, environment));
        if (latest || rows.length < 200) return latest;
        before = rows.at(-1)!.id;
    }
}

function featureText(feature: Feature, features: Map<string, Feature>): string {
    const parents = new Set<string>();
    const parts: string[] = [];
    let current: Feature | undefined = feature;
    while (current && !parents.has(current.id)) {
        parents.add(current.id);
        parts.push(current.title, current.description);
        current = current.parentId ? features.get(current.parentId) : undefined;
    }
    return parts.join(" ");
}

export async function projectCoverage(projectId: string, environmentName?: string) {
    const [revision, features, specs, environment, batches] = await Promise.all([
        projectContextsRepository.getLatestConfirmedProjectContext(projectId), featuresRepository.listFeatures(projectId), specsRepository.listSpecs(projectId),
        resolveRunEnvironment(projectId, environmentName), listRunBatches(projectId),
    ]);
    const featureMap = new Map(features.map((feature) => [feature.id, feature]));
    const details = new Map(await Promise.all(specs.map(async (spec) => [spec.id, await implementation(spec)] as const)));
    const latest = new Map(await Promise.all(specs.map(async (spec) => [spec.id, await latestRun(spec.id, environment)] as const)));
    const health = new Map(await Promise.all(specs.map(async (spec) => {
        const run = latest.get(spec.id);
        const current = run && await matchesCurrentSpec(run, spec);
        const state: SpecHealth = spec.lifecycle === "draft" ? "draft" : !details.get(spec.id)?.valid ? "invalid" : !current ? "notRun"
            : run.status === "running" ? "running" : run.flaky ? "flaky" : run.status === "passed" ? "passing" : "failing";
        return [spec.id, state] as const;
    })));
    const areas: CoverageArea[] = [];
    const addArea = (kind: CoverageArea["kind"], name: string, description: string, routes: string[]) => {
        const matched = specs.filter((spec) => contains(`${spec.title} ${spec.description} ${featureMap.has(spec.featureId) ? featureText(featureMap.get(spec.featureId)!, featureMap) : ""}`, name)
            || routes.some((route) => details.get(spec.id)?.routes.some((tested) => matchesRoute(route, tested))));
        const active = matched.filter((spec) => spec.lifecycle === "active" && details.get(spec.id)?.valid);
        const matchedRoutes = routes.filter((route) => active.some((spec) => details.get(spec.id)?.routes.some((tested) => matchesRoute(route, tested))));
        const coverage: CoverageStatus = !matched.length ? "uncovered" : active.length && matchedRoutes.length === routes.length ? "covered" : "partial";
        const reason = coverage === "uncovered" ? "No matching Specs found"
            : !active.length ? "Matching Specs are drafts or need repairing"
            : coverage === "partial" ? `${routes.length - matchedRoutes.length} known route${routes.length - matchedRoutes.length === 1 ? " has" : "s have"} no matching active Spec`
            : routes.length ? "Active Specs reference every known route" : "Matching active Specs exist";
        const featureIds = [...new Set([...features.filter((feature) => contains(featureText(feature, featureMap), name)).map((feature) => feature.id), ...matched.map((spec) => spec.featureId)])];
        areas.push({ kind, name, description, routes, coverage, featureIds, specIds: matched.map((spec) => spec.id), matchedRoutes, reason });
    };
    if (revision) {
        for (const area of revision.context.areas) addArea("area", area.name, area.description, area.routes);
        for (const role of revision.context.roles) addArea("role", role.name, role.capabilities.join("; "), []);
        for (const rule of revision.context.businessRules) addArea("rule", rule, "", []);
    }
    const totals = emptyCounts();
    const featureRows = features.map((feature) => {
        const own = specs.filter((spec) => spec.featureId === feature.id);
        const counts = emptyCounts();
        for (const spec of own) { counts[health.get(spec.id)!]++; totals[health.get(spec.id)!]++; }
        const lastRunAt = own.map((spec) => latest.get(spec.id)?.startedAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
        return { id: feature.id, title: feature.title, counts, lastRunAt };
    });
    const trend = [];
    for (const batch of batches.filter((batch) => batch.status !== "running" && batch.specs.length && inEnvironment(batch, environment))) {
        const result = await ciResult(batch);
        if (!result.complete) continue;
        const passed = result.results.filter((item) => item.status === "passed" || item.flaky).length;
        const total = result.results.length;
        trend.push({ id: batch.id, label: batch.label, startedAt: batch.startedAt, environment: batch.environment?.name ?? "Production", passed, total, passRate: Math.round(passed / total * 100) });
        if (trend.length === 20) break;
    }
    trend.reverse();
    return { confirmed: Boolean(revision), environment: { id: environment.id, name: environment.name },
        basis: "Matches use feature and Spec text and literal tested routes. They show where Specs exist, not complete behavioral coverage.", areas, features: featureRows, totals, trend };
}
