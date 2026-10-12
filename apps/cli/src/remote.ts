import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { stringify } from "yaml";
import { z } from "zod";
import { configHome, containsSecret } from "./credentials";
import { loadConfig, listSpecs, safeWorkspacePath, type LocalConfig } from "./workspace";
import { runLocal, type LocalRun } from "./run";

const serverSchema = z.object({ url: z.string().url(), token: z.string().min(1) }).strict();
const serversSchema = z.array(serverSchema);
type Server = z.infer<typeof serverSchema>;
const hashesSchema = z.object({ specTs: z.string(), specYaml: z.string() });
const stateSchema = z.object({
    url: z.string(), projectId: z.string(),
    specs: z.record(z.string(), z.object({ revision: z.string(), hashes: hashesSchema })),
    features: z.record(z.string(), z.string()),
});
type RemoteState = z.infer<typeof stateSchema>;
const fileSchema = z.object({ "spec.yml": z.string(), "spec.ts": z.string() });
const snapshotSchema = z.object({
    features: z.array(z.object({ path: z.string(), source: z.string() })),
    specs: z.array(z.object({ path: z.string(), revision: z.string(), files: fileSchema })),
});
const projectSchema = z.object({ id: z.string().uuid(), name: z.string(), baseUrl: z.string() });
const environmentSchema = z.object({ id: z.string(), name: z.string(), baseUrl: z.string() });
export type RemoteProject = z.infer<typeof projectSchema>;
export type RemoteEnvironment = z.infer<typeof environmentSchema>;

const tokens = new Set<string>();
for (const value of [process.env.SPECBOOK_TOKEN, process.env.GITHUB_TOKEN, process.env.SPECBOOK_GITLAB_TOKEN, process.env.CI_JOB_TOKEN]) if (value) tokens.add(value);
for (const [index, arg] of process.argv.entries()) {
    if (arg === "--token" && process.argv[index + 1]) tokens.add(process.argv[index + 1]);
    if (arg.startsWith("--token=")) tokens.add(arg.slice(8));
}
export function rememberToken(token: string): void { tokens.add(token); }
export function redactTokens(text: string): string {
    const values = [...tokens].flatMap((token) => [token, encodeURIComponent(token), JSON.stringify(token).slice(1, -1)]).sort((a, b) => b.length - a.length);
    return values.reduce((safe, value) => value ? safe.split(value).join("[REDACTED]") : safe, text);
}
export async function scrubTokens(text: string): Promise<string> {
    for (const server of await readServers()) rememberToken(server.token);
    return redactTokens(text);
}

export function normalizeServerUrl(value: string): string {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("Use a full HTTP(S) server URL"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Use an HTTP(S) server URL without credentials, query or fragment");
    return url.href.replace(/\/$/, "");
}

async function readServers(): Promise<Server[]> {
    const file = path.join(configHome(), "servers.json");
    try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Servers must be a regular file");
        if (process.platform !== "win32" && ((stat.mode & 0o077) || stat.uid !== process.getuid?.())) throw new Error("Servers file must belong to this user with 0600 permissions");
        let data: unknown;
        try { data = JSON.parse(await fs.readFile(file, "utf8")); } catch { throw new Error("Servers file contains invalid JSON"); }
        const result = serversSchema.safeParse(data);
        if (!result.success) throw new Error("Servers file has an invalid structure");
        for (const server of result.data) { normalizeServerUrl(server.url); rememberToken(server.token); }
        return result.data;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
}

async function writeServers(servers: Server[]): Promise<void> {
    const directory = configHome();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("SPECBOOK_HOME must be a directory, without a symlink");
    const temporary = path.join(directory, `servers-${randomUUID()}.tmp`);
    try {
        await fs.writeFile(temporary, JSON.stringify(servers, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        await fs.rename(temporary, path.join(directory, "servers.json"));
    } finally { await fs.rm(temporary, { force: true }); }
}

export class RemoteError extends Error {
    constructor(message: string, readonly status: number, readonly detail?: { code: string; conflicts: { path: string; revision: string | null }[]; command: string }) { super(message); }
}

export async function request(server: Server, route: string, options: { method?: string; body?: unknown; timeoutMs?: number; frontendFallback?: boolean } = {}): Promise<Response> {
    rememberToken(server.token);
    const url = normalizeServerUrl(server.url);
    const send = async (base: string) => {
        try {
            return await fetch(`${base}${route}`, {
                method: options.method ?? "GET", headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
                ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
                redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 35_000),
            });
        } catch { throw new Error("Could not reach Specbook; check the server URL and connection"); }
    };
    let response = await send(url);
    if (options.frontendFallback && !url.endsWith("/api") && (response.status === 404 || response.ok && response.headers.get("content-type")?.includes("text/html"))) response = await send(`${url}/api`);
    if (!response.ok) {
        const body = await response.text();
        let data: unknown;
        try { data = JSON.parse(body); } catch { /* A proxy error may be HTML. */ }
        const parsed = z.object({ error: z.string().optional(), message: z.string().optional(), code: z.string().optional(), conflicts: z.array(z.object({ path: z.string(), revision: z.string().nullable() })).optional(), command: z.string().optional() }).safeParse(data);
        const detail = parsed.success && parsed.data.code === "revision_conflict" ? { code: parsed.data.code, conflicts: parsed.data.conflicts ?? [], command: "specbook pull" } : undefined;
        const reason = parsed.success ? parsed.data.error ?? parsed.data.message : undefined;
        throw new RemoteError(redactTokens(reason ?? `Specbook returned HTTP ${response.status}`), response.status, detail);
    }
    return response;
}

export async function responseJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
    let data: unknown;
    try { data = await response.json(); } catch { throw new Error("Specbook returned an invalid JSON response"); }
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new Error("Specbook returned an unexpected response");
    return parsed.data;
}

const equivalent = (left: string, right: string) => left === right || left === `${right}/api` || `${left}/api` === right;
export async function savedServer(url?: string): Promise<Server> {
    const normalized = url ? normalizeServerUrl(url) : undefined;
    const servers = await readServers();
    const server = normalized ? servers.find((item) => equivalent(item.url, normalized)) : servers.at(-1);
    if (!server) throw new Error(normalized ? "Log in to this server with specbook login first" : "Log in with specbook login <server-url> first");
    return server;
}

export async function login(url: string, token: string) {
    rememberToken(token);
    if (!token || /\s/.test(token) || token.length > 4096) throw new Error("Provide one personal access token");
    const normalized = normalizeServerUrl(url);
    const response = await request({ url: normalized, token }, "/auth/me", { frontendFallback: true });
    const { user } = await responseJson(response, z.object({ user: z.object({ id: z.string(), name: z.string(), email: z.string(), role: z.string() }) }));
    const apiUrl = response.url.slice(0, -"/auth/me".length);
    const servers = (await readServers()).filter((server) => !equivalent(server.url, normalized));
    servers.push({ url: apiUrl, token });
    await writeServers(servers);
    return { url: apiUrl, user, default: true };
}

export async function logout(url?: string) {
    const servers = await readServers();
    const normalized = url ? normalizeServerUrl(url) : servers.at(-1)?.url;
    const next = normalized ? servers.filter((server) => !equivalent(server.url, normalized)) : servers;
    await writeServers(next);
    return { url: normalized ?? null, removed: next.length !== servers.length, defaultUrl: next.at(-1)?.url ?? null };
}

export async function connectionChoices(url?: string) {
    const server = await savedServer(url);
    const { projects } = await responseJson(await request(server, "/projects"), z.object({ projects: z.array(projectSchema) }));
    return { server, projects };
}
export async function environmentChoices(server: Server, projectId: string) {
    return (await responseJson(await request(server, `/projects/${encodeURIComponent(projectId)}/environments`), z.object({ environments: z.array(environmentSchema) }))).environments;
}
export async function connect(workspace: string, server: Server, project: RemoteProject, environment: RemoteEnvironment) {
    const config = await loadConfig(workspace);
    config.remote = { url: server.url, projectId: project.id, environment: environment.name };
    await fs.writeFile(await safeWorkspacePath(workspace, "config.yml"), stringify(config));
    return { url: server.url, project: { id: project.id, name: project.name }, environment: environment.name, workspace };
}

async function connected(workspace: string) {
    const config = await loadConfig(workspace);
    if (!config.remote) throw new Error("Connect this workspace with specbook connect first");
    return { remote: config.remote, server: await savedServer(config.remote.url) };
}
async function readState(workspace: string, remote: NonNullable<LocalConfig["remote"]>): Promise<RemoteState> {
    const empty = { url: remote.url, projectId: remote.projectId, specs: {}, features: {} };
    try {
        const data = stateSchema.safeParse(JSON.parse(await fs.readFile(await safeWorkspacePath(workspace, "remote.json"), "utf8")));
        if (!data.success) throw new Error("Remote revision file has an invalid structure");
        return data.data.url === remote.url && data.data.projectId === remote.projectId ? data.data : empty;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty; throw error; }
}
async function writeState(workspace: string, state: RemoteState): Promise<void> {
    const temporary = `remote-${randomUUID()}.tmp`;
    const file = await safeWorkspacePath(workspace, temporary, true);
    try {
        await fs.writeFile(file, JSON.stringify(state, null, 2) + "\n", { flag: "wx" });
        await fs.rename(file, await safeWorkspacePath(workspace, "remote.json", true));
    } finally { await fs.rm(file, { force: true }); }
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const hashes = (files: z.infer<typeof fileSchema>) => ({ specTs: hash(files["spec.ts"]), specYaml: hash(files["spec.yml"]) });
const equalHashes = (left: z.infer<typeof hashesSchema> | undefined, right: z.infer<typeof hashesSchema>) => left?.specTs === right.specTs && left.specYaml === right.specYaml;
async function localFiles(workspace: string, relative: string) {
    const read = async (name: string) => {
        try { return await fs.readFile(await safeWorkspacePath(workspace, `${relative}/${name}`), "utf8"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    };
    const source = await read("spec.ts"), yaml = await read("spec.yml");
    return source === null || yaml === null ? null : { "spec.ts": source, "spec.yml": yaml };
}
function specPath(relative: string): void {
    if (!/^specs\/(?:[a-zA-Z0-9][a-zA-Z0-9_-]*\/)+[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(relative)) throw new Error("Specbook returned an invalid Spec path");
}
function featurePath(relative: string): void {
    if (!/^specs\/[a-zA-Z0-9][a-zA-Z0-9_-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_-]*)*$/.test(relative)) throw new Error("Specbook returned an invalid Feature path");
}

export async function pull(workspace: string) {
    const { remote, server } = await connected(workspace);
    const snapshot = await responseJson(await request(server, `/projects/${remote.projectId}/specs/files`), snapshotSchema);
    for (const feature of snapshot.features) { featurePath(feature.path); await safeWorkspacePath(workspace, `${feature.path}/feature.yml`, true); }
    for (const spec of snapshot.specs) { specPath(spec.path); await safeWorkspacePath(workspace, `${spec.path}/spec.ts`, true); await safeWorkspacePath(workspace, `${spec.path}/spec.yml`, true); }
    const state = await readState(workspace, remote);
    const pulled: { path: string; revision: string }[] = [], conflicts: { path: string; reason: string }[] = [];
    for (const feature of snapshot.features) {
        const featurePath = `${feature.path}/feature.yml`;
        const file = await safeWorkspacePath(workspace, featurePath, true);
        const previous = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
        if (previous !== null && hash(previous) !== (state.features[featurePath] ?? hash(feature.source)) || previous === null && state.features[featurePath]) {
            conflicts.push({ path: featurePath, reason: "local_changes" }); continue;
        }
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, feature.source);
        state.features[featurePath] = hash(feature.source);
    }
    for (const spec of snapshot.specs) {
        specPath(spec.path);
        const local = await localFiles(workspace, spec.path), previous = state.specs[spec.path];
        const anyFile = await fs.lstat(await safeWorkspacePath(workspace, spec.path, true)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
        if (previous && (!local || !equalHashes(previous.hashes, hashes(local))) || !previous && anyFile && (!local || !equalHashes(hashes(local), hashes(spec.files)))) {
            conflicts.push({ path: spec.path, reason: "local_changes" }); continue;
        }
        const directory = await safeWorkspacePath(workspace, spec.path, true);
        await fs.mkdir(directory, { recursive: true });
        for (const [name, source] of Object.entries(spec.files)) await fs.writeFile(await safeWorkspacePath(workspace, `${spec.path}/${name}`, true), source);
        state.specs[spec.path] = { revision: spec.revision, hashes: hashes(spec.files) };
        pulled.push({ path: spec.path, revision: spec.revision });
    }
    await writeState(workspace, state);
    return { url: remote.url, projectId: remote.projectId, pulled, conflicts };
}

async function verifiedRuns(workspace: string, paths: string[]) {
    const runs = await safeWorkspacePath(workspace, "runs");
    const entries = (await fs.readdir(runs, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    const latest = new Map<string, { runId: string; result: LocalRun["results"][number] }>();
    for (const id of entries) {
        let run: LocalRun;
        try { run = JSON.parse(await fs.readFile(await safeWorkspacePath(workspace, `runs/${id}/run.json`), "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw new Error("A local run record could not be read"); }
        for (const result of run.results ?? []) if (paths.includes(result.path) && !latest.has(result.path)) latest.set(result.path, { runId: id, result });
        if (latest.size === paths.length) break;
    }
    return latest;
}

export async function publish(workspace: string, selector?: string, options: { run?: boolean; environment?: string } = {}) {
    const { remote, server } = await connected(workspace);
    if (options.run) {
        const run = await runLocal(workspace, selector);
        if (run.status !== "passed") throw new Error(`Local verification failed; read ${run.report} before publishing`);
    }
    const specs = await listSpecs(workspace, selector);
    if (!specs.length) throw new Error("No Specs found to publish");
    const state = await readState(workspace, remote);
    const latest = await verifiedRuns(workspace, specs.map((spec) => spec.path));
    const input = [];
    const verified: { path: string; runId: string }[] = [];
    for (const spec of specs) {
        const files = { "spec.ts": spec.source, "spec.yml": spec.yaml };
        const run = latest.get(spec.path);
        if (run?.result.status !== "passed" || !equalHashes(run.result.hashes, hashes(files))) throw new Error(`${spec.path} needs a passing run of its current files. Run specbook run ${spec.path}, or publish with --run`);
        const featurePath = path.posix.dirname(spec.path);
        const source = await fs.readFile(await safeWorkspacePath(workspace, `${featurePath}/feature.yml`), "utf8");
        const text = JSON.stringify({ files, source });
        if (await containsSecret(text) || await scrubTokens(text) !== text) throw new Error("Spec files contain a stored secret; remove tokens and use secret() references for credentials before publishing");
        input.push({ path: spec.path, baseRevision: state.specs[spec.path]?.revision ?? null, files, feature: { path: featurePath, source } });
        verified.push({ path: spec.path, runId: run.runId });
    }
    const result = await responseJson(await request(server, `/projects/${remote.projectId}/specs/publish`, { method: "POST", body: { environment: options.environment ?? remote.environment, specs: input } }), z.object({ commitSha: z.string(), specs: z.array(z.object({ id: z.string(), path: z.string(), revision: z.string(), status: z.string() })), features: z.array(z.object({ path: z.string(), source: z.string() })).optional() }));
    for (const spec of result.specs) {
        const sent = input.find((entry) => entry.path === spec.path);
        if (!sent) throw new Error("Specbook returned an unexpected published Spec");
        state.specs[spec.path] = { revision: spec.revision, hashes: hashes(sent.files) };
    }
    for (const feature of result.features ?? []) { featurePath(feature.path); state.features[`${feature.path}/feature.yml`] = hash(feature.source); }
    await writeState(workspace, state);
    return { url: remote.url, projectId: remote.projectId, environment: options.environment ?? remote.environment, commitSha: result.commitSha, specs: result.specs, verified };
}
