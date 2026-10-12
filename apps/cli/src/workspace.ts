import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { analyzeSpecSource, stepTitlesError, type SpecAnalysis } from "@specbook/runtime/validate";
import { parseSpecYaml, parseFeatureYaml, serializeFeatureYaml, serializeSpecYaml } from "@specbook/runtime/yaml";
import type { HumanSpec } from "@specbook/runtime/types";

export const configSchema = z.object({ version: z.literal(1).default(1), baseUrl: z.string().url(), agent: z.enum(["claude", "codex"]).optional() }).strict();
export type LocalConfig = z.infer<typeof configSchema>;
export interface LocalSpec {
    path: string;
    directory: string;
    title: string;
    description: string;
    humanSpec: HumanSpec;
    source: string;
    analysis: SpecAnalysis;
    feature: string;
}

export async function safeWorkspacePath(workspace: string, relative: string, forWrite = false): Promise<string> {
    const root = path.resolve(workspace);
    const target = path.resolve(root, relative);
    const inside = path.relative(root, target);
    if (!inside || inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new Error("Path must be inside .specbook");
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(".specbook must be a directory, without a symlink");
    let current = root;
    for (const part of inside.split(path.sep)) {
        current = path.join(current, part);
        const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
            if (forWrite && error.code === "ENOENT") return null;
            throw error;
        });
        if (stat?.isSymbolicLink()) throw new Error("Symlinks are not allowed inside .specbook");
    }
    return target;
}

export async function workspaceDirectory(cwd = process.cwd()): Promise<string> {
    const directory = path.join(path.resolve(cwd), ".specbook");
    await safeWorkspacePath(directory, "config.yml");
    return directory;
}

export async function loadConfig(workspace: string): Promise<LocalConfig> {
    const config = configSchema.parse(parse(await fs.readFile(await safeWorkspacePath(workspace, "config.yml"), "utf8")));
    const url = new URL(config.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("baseUrl must be an HTTP(S) URL without credentials");
    return config;
}

export function detectAgents(): ("claude" | "codex")[] {
    return (["claude", "codex"] as const).filter((agent) => spawnSync(agent, ["--version"], { stdio: "ignore", timeout: 5000 }).status === 0);
}

export async function initWorkspace(cwd: string, baseUrl: string, agent?: "claude" | "codex"): Promise<unknown> {
    const config = configSchema.parse({ version: 1, baseUrl, agent });
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Use an HTTP(S) base URL without credentials");
    const workspace = path.join(path.resolve(cwd), ".specbook");
    await fs.mkdir(workspace, { recursive: true });
    const configFile = await safeWorkspacePath(workspace, "config.yml", true);
    await fs.writeFile(configFile, stringify(config), { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
    });
    await fs.mkdir(await safeWorkspacePath(workspace, "specs", true), { recursive: true });
    await fs.mkdir(await safeWorkspacePath(workspace, "runs", true), { recursive: true });
    await fs.mkdir(await safeWorkspacePath(workspace, "chats", true), { recursive: true });
    await fs.writeFile(await safeWorkspacePath(workspace, ".gitignore", true), "runs/\nchats/\n");
    const skill = `---\nname: specbook\ndescription: Converse with Specbook to explore a web app and maintain executable behavior contracts.\n---\n\nStart with specbook chat "<requested behavior>" --json. Treat Specbook as a QA teammate: it explores the app, asks when blocked, proposes coverage, and writes and runs Specs. Read the returned id, status and message, then continue the same conversation:\n\n- working: run specbook chat <id> --wait --json until a turn finishes. --timeout limits how long the caller waits; it doesn't cancel the background turn. Don't send another message while working.\n- waiting_for_reply: answer with specbook chat <id> "<answer>" --json. Use facts from the user's request or project context; ask the human when the expected behavior is unclear.\n- waiting_for_selection: inspect each proposal's number, title, why and feature. Select coverage within the user's request with specbook chat <id> --select 1,2 --json, or reply in text to request changes. Specbook checks and runs each selected Spec, with at most three runs per Spec in a turn.\n- needs_credentials: tell the human the requested profile and field names, and give the pending action's exact specbook credentials add <profile> command. The human enters values through that command's hidden prompts or stdin. Never ask for, read, print or send secret values in the conversation. After the human adds the profile, continue with specbook chat <id> "done" --json.\n- done: stop and report the Specs' statuses and evidence/report paths. A finished request can include failed Specs; read specs, not just the conversation status.\n- failed: explain the error and suggested fix. Retry the same conversation only after fixing the cause.\n\nUse specbook chats --json to find saved conversations. --agent claude|codex chooses the local brain for a new conversation; an existing conversation keeps its agent. --no-wait returns working immediately, and --wait reads the eventual result.\n\nFor manual work, use specbook browse open, snapshot, inspect, click and fill. Use snapshot element refs and fill <ref> --secret profile.field for credentials. Specs live in .specbook/specs/<feature>/<slug>/{spec.yml,spec.ts}; feature.yml describes the feature. Read .specbook/spec-writing-rules.md before writing a Spec, run specbook spec check, then specbook run, and review evidence with specbook report. Every run starts signed out in a fresh browser. Change only Specbook files; never change app code as part of Spec creation.\n`;
    const { specWritingRules } = await import("@specbook/runtime/writing-rules");
    await fs.writeFile(await safeWorkspacePath(workspace, "SKILL.md", true), skill);
    await fs.writeFile(await safeWorkspacePath(workspace, "spec-writing-rules.md", true), specWritingRules());
    for (const folder of [".agents", ".claude"]) {
        const skillDir = path.join(cwd, folder, "skills", "specbook");
        let current = path.resolve(cwd);
        for (const part of [folder, "skills", "specbook"]) {
            current = path.join(current, part);
            const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
            if (stat?.isSymbolicLink()) throw new Error("Cannot install instructions through a symlink");
        }
        await fs.mkdir(skillDir, { recursive: true });
        const file = path.join(skillDir, "SKILL.md");
        await fs.writeFile(file, skill, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    }
    return { workspace, config: await loadConfig(workspace), agents: detectAgents() };
}

export function slugify(title: string): string {
    const slug = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100);
    if (!slug) throw new Error("Use a title containing letters or digits");
    return slug;
}

export async function newSpec(workspace: string, title: string, feature: string): Promise<unknown> {
    if (!title.trim()) throw new Error("Spec title is required");
    const featureSlug = slugify(feature);
    const slug = slugify(title);
    const directory = await safeWorkspacePath(workspace, `specs/${featureSlug}/${slug}`, true);
    await fs.mkdir(directory, { recursive: true });
    const humanSpec = { preconditions: [], steps: ["Open the app"], expectedResult: "The app loads.", postconditions: [] };
    const featureFile = await safeWorkspacePath(workspace, `specs/${featureSlug}/feature.yml`, true);
    await fs.writeFile(featureFile, serializeFeatureYaml({ title: feature, description: "" }), { flag: "wx" }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const yamlFile = await safeWorkspacePath(workspace, `specs/${featureSlug}/${slug}/spec.yml`, true);
    const testFile = await safeWorkspacePath(workspace, `specs/${featureSlug}/${slug}/spec.ts`, true);
    if (await fs.lstat(yamlFile).catch(() => null) || await fs.lstat(testFile).catch(() => null)) throw new Error("Spec already exists");
    await fs.writeFile(yamlFile, serializeSpecYaml({ title, description: "", humanSpec }), { flag: "wx" });
    await fs.writeFile(testFile, `import { test, expect } from "specbook";\n\ntest(${JSON.stringify(title)}, async ({ page, step }) => {\n    await step("Open the app", async () => {\n        await page.goto("/");\n        await expect(page.locator("body")).toBeVisible();\n    });\n});\n`, { flag: "wx" });
    return { path: `specs/${featureSlug}/${slug}`, title, feature };
}

export async function specDirectories(workspace: string, selector?: string): Promise<string[]> {
    const root = await safeWorkspacePath(workspace, "specs");
    const directories: string[] = [];
    for (const feature of await fs.readdir(root, { withFileTypes: true })) {
        if (feature.isSymbolicLink()) throw new Error("Symlinks are not allowed inside specs");
        if (!feature.isDirectory()) continue;
        for (const spec of await fs.readdir(path.join(root, feature.name), { withFileTypes: true })) {
            if (spec.isSymbolicLink()) throw new Error("Symlinks are not allowed inside specs");
            if (spec.isDirectory()) directories.push(`specs/${feature.name}/${spec.name}`);
        }
    }
    if (!selector) return directories.sort();
    let selected = selector.replace(/\\/g, "/").replace(/\/$/, "").replace(/\/(spec\.ts|spec\.yml)$/, "");
    if (path.isAbsolute(selected)) selected = path.relative(workspace, selected).replace(/\\/g, "/");
    selected = selected.replace(/^\.specbook\//, "").replace(/^\.\//, "");
    const matches = directories.filter((directory) => directory === selected || directory === `specs/${selected}` || directory.startsWith(`specs/${selected}/`) || path.basename(directory) === selected);
    if (!matches.length) throw new Error("No Specs match the selector");
    if (!selected.includes("/") && matches.length > 1 && !matches.every((item) => item.startsWith(`specs/${selected}/`))) throw new Error("Ambiguous Spec slug; use feature/slug");
    return matches.sort();
}

export async function readSpec(workspace: string, relative: string): Promise<LocalSpec> {
    const yaml = parseSpecYaml(await fs.readFile(await safeWorkspacePath(workspace, `${relative}/spec.yml`), "utf8"));
    const source = await fs.readFile(await safeWorkspacePath(workspace, `${relative}/spec.ts`), "utf8");
    const analyzed = analyzeSpecSource(source);
    if (!analyzed.ok) throw new Error(analyzed.error);
    const analysis = analyzed.analysis;
    const mismatch = stepTitlesError(analysis.steps, yaml.humanSpec.steps);
    if (mismatch) throw new Error(mismatch);
    if (!yaml.title) throw new Error("spec.yml needs a title");
    const featureSlug = relative.split("/")[1];
    const feature = parseFeatureYaml(await fs.readFile(await safeWorkspacePath(workspace, `specs/${featureSlug}/feature.yml`), "utf8"));
    return { path: relative, directory: path.join(workspace, relative), title: yaml.title, description: yaml.description, humanSpec: yaml.humanSpec, source, analysis, feature: feature.title ?? featureSlug };
}

export async function listSpecs(workspace: string, selector?: string): Promise<LocalSpec[]> {
    return Promise.all((await specDirectories(workspace, selector)).map((relative) => readSpec(workspace, relative)));
}
