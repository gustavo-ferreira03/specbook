import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { configHome, scrub } from "./credentials";
import { normalizeServerUrl, redactTokens } from "./remote";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.resolve(moduleDirectory, "..");
const MAX_UI_DOWNLOAD_BYTES = 200 * 1024 * 1024;
const MAX_UI_EXTRACTED_BYTES = 1024 * 1024 * 1024;
declare const SPECBOOK_UI_RELEASE_SHA256: string;
const expectedUiSha256 = typeof SPECBOOK_UI_RELEASE_SHA256 === "undefined" ? "" : SPECBOOK_UI_RELEASE_SHA256;

export interface ServeOptions { port?: string; host?: string; data?: string; ui?: string; signal?: AbortSignal }
export type ServeEvent =
    | { event: "downloading_ui"; version: string }
    | { event: "ready"; url: string; apiUrl: string; port: number; host: string; data: string; ui: string; uiSource: "explicit" | "bundled" | "cache" | "download" }
    | { event: "stopped"; url: string };

async function version(): Promise<string> {
    const manifest = JSON.parse(await fs.readFile(path.join(packageDirectory, "package.json"), "utf8")) as { version?: unknown };
    if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(manifest.version)) throw new Error("The CLI package has an invalid version");
    return manifest.version;
}

async function uiEntry(directory: string): Promise<string | null> {
    const entry = path.join(directory, "server.js");
    const stat = await fs.lstat(entry).catch(() => null);
    return stat?.isFile() && !stat.isSymbolicLink() ? entry : null;
}

async function response(url: string, signal?: AbortSignal): Promise<Response> {
    let fetched: Response;
    try {
        const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
        fetched = await fetch(url, { signal: requestSignal });
    } catch (error) {
        if (signal?.aborted) throw signal.reason;
        throw new Error("The UI release could not be downloaded");
    }
    if (!fetched.ok) {
        await fetched.body?.cancel();
        throw new Error(fetched.status === 404 ? "The UI release is unavailable (HTTP 404)" : `The UI release could not be downloaded (HTTP ${fetched.status})`);
    }
    return fetched;
}

async function downloadUi(currentVersion: string, target: string, url: string, signal?: AbortSignal): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(expectedUiSha256)) throw new Error("This CLI build has no trusted UI release checksum; use a release CLI or provide an extracted UI with --ui");
    const parent = path.dirname(target);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = await fs.mkdtemp(path.join(parent, `.ui-${currentVersion}-`));
    try {
        const archive = path.join(temporary, "ui.tar.gz");
        const downloaded = await response(url, signal);
        if (!downloaded.body) throw new Error("The UI release archive is empty");
        const hash = createHash("sha256");
        let bytes = 0;
        const measured = new Transform({ transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > MAX_UI_DOWNLOAD_BYTES) { callback(new Error("The UI release archive exceeds 200 MB")); return; }
            hash.update(chunk);
            callback(null, chunk);
        } });
        await pipeline(Readable.fromWeb(downloaded.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>), measured, createWriteStream(archive, { flags: "wx", mode: 0o600 }), ...(signal ? [{ signal }] : []));
        if (hash.digest("hex") !== expectedUiSha256) throw new Error("UI release checksum verification failed");
        const extracted = path.join(temporary, "ui");
        await fs.mkdir(extracted, { mode: 0o700 });
        const tar = await import("tar");
        let expanded = 0;
        let invalid = false;
        await tar.x({ file: archive, cwd: extracted, strict: true, preservePaths: false, filter(name, entry) {
            expanded += entry.size;
            const relative = name.replace(/^\.\//, "");
            if (expanded > MAX_UI_EXTRACTED_BYTES || !("type" in entry) || !["File", "Directory"].includes(entry.type)
                || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) invalid = true;
            return !invalid;
        } });
        if (invalid) throw new Error("The UI release archive contains unsafe or oversized entries");
        const manifest = JSON.parse(await fs.readFile(path.join(extracted, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
        if (!await uiEntry(extracted) || manifest.name !== "specbook-ui" || manifest.version !== currentVersion) throw new Error("The UI release does not match this CLI version");
        try { await fs.rename(extracted, target); } catch (error) {
            if (!await uiEntry(target)) throw error;
        }
    } finally {
        await fs.rm(temporary, { recursive: true, force: true });
    }
}

export async function resolveUi(options: Pick<ServeOptions, "ui" | "signal">, emit: (event: ServeEvent) => Promise<void>): Promise<{ directory: string; source: "explicit" | "bundled" | "cache" | "download" }> {
    if (options.ui) {
        const directory = path.resolve(options.ui);
        if (!await uiEntry(directory)) throw new Error("--ui must point to an extracted Specbook standalone UI with server.js. Download the UI artifact matching this CLI version and extract it first.");
        return { directory, source: "explicit" };
    }
    for (const directory of [path.join(moduleDirectory, "ui"), path.join(packageDirectory, "ui")]) {
        if (await uiEntry(directory)) return { directory, source: "bundled" };
    }
    const currentVersion = await version();
    const directory = path.join(configHome(), "ui", currentVersion);
    if (await uiEntry(directory)) return { directory, source: "cache" };
    const release = process.env.SPECBOOK_UI_RELEASE_URL ?? "https://github.com/gustavo-ferreira03/specbook/releases/download/v{version}/specbook-ui-{version}.tar.gz";
    const url = normalizeServerUrl(release.replaceAll("{version}", currentVersion));
    if (new URL(url).protocol !== "https:") throw new Error("SPECBOOK_UI_RELEASE_URL must use HTTPS");
    await emit({ event: "downloading_ui", version: currentVersion });
    try {
        await downloadUi(currentVersion, directory, url, options.signal);
        return { directory, source: "download" };
    } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        const reason = error instanceof Error ? error.message : "UI download failed";
        throw new Error(`${reason}. Download specbook-ui-${currentVersion}.tar.gz and its .sha256 from the v${currentVersion} release, verify and extract it, then run specbook serve --ui <directory>. The Docker image includes the UI.`);
    }
}

function portNumber(value: string | undefined, fallback: number, label: string): number {
    const number = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error(`Use ${label === "API" ? "an" : "a"} ${label} port between 1 and 65535`);
    return number;
}

function hostUrl(host: string, port: number): string {
    const reachable = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
    return `http://${reachable.includes(":") ? `[${reachable}]` : reachable}:${port}`;
}

async function availablePort(host: string, port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const listener = net.createServer();
        listener.once("error", () => reject(new Error(`Port ${port} is unavailable on ${host}; choose another --port or set PORT for the API`)));
        listener.listen(port, host, () => listener.close((error) => error ? reject(error) : resolve()));
    });
}

async function cliPackage(data: string): Promise<string> {
    if (process.env.SPECBOOK_CLI_PACKAGE_FILE) return path.resolve(process.env.SPECBOOK_CLI_PACKAGE_FILE);
    const bundled = path.join(packageDirectory, "dist", "specbook.tgz");
    if ((await fs.stat(bundled).catch(() => null))?.isFile()) return bundled;
    const directory = path.join(data, "cli");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "specbook.tgz");
    const temporary = path.join(directory, `specbook-${process.pid}.tgz`);
    const tar = await import("tar");
    try {
        await tar.c({ cwd: packageDirectory, file: temporary, gzip: true, prefix: "package", filter(name) {
            return name !== "dist/specbook.tgz" && name !== "dist/ui" && !name.startsWith("dist/ui/");
        } }, ["package.json", "README.md", "dist"]);
        await fs.chmod(temporary, 0o600);
        await fs.rename(temporary, file);
        return file;
    } finally { await fs.rm(temporary, { force: true }); }
}

interface ServerProcess { child: ChildProcess; exited: boolean; error?: Error; done: Promise<void> }

export async function runServe(options: ServeOptions, emit: (event: ServeEvent) => Promise<void>, log: (line: string) => void): Promise<void> {
    const port = portNumber(options.port ?? process.env.FRONTEND_PORT, 4001, "web UI");
    const apiPort = portNumber(process.env.PORT, options.port !== undefined ? port - 1 : 4000, "API");
    if (port === apiPort) throw new Error("The web UI and API ports must differ; set PORT for the API");
    const host = options.host ?? process.env.HOST ?? "127.0.0.1";
    if (!host || /[\s/\\?#@]/.test(host)) throw new Error("Use a hostname or IP address for --host");
    const data = path.resolve(options.data ?? process.env.SPECBOOK_STORAGE_DIR ?? path.join(configHome(), "server"));
    const serverEntry = path.join(packageDirectory, "dist", "server", "index.js");
    if (!(await fs.stat(serverEntry).catch(() => null))?.isFile()) throw new Error("The server runtime is not built. Install a packed Specbook CLI or run pnpm --filter @specbook/runtime --filter specbook build in this checkout.");
    const resolvedUi = await resolveUi(options, emit);
    options.signal?.throwIfAborted();
    await availablePort(host, apiPort);
    await availablePort(host, port);
    await fs.mkdir(data, { recursive: true, mode: 0o700 });
    const apiUrl = hostUrl(host, apiPort);
    const url = hostUrl(host, port);
    const environment = { ...process.env, NODE_ENV: "production", SPECBOOK_STORAGE_DIR: data, SPECBOOK_CLI_PACKAGE_FILE: await cliPackage(data),
        FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN ?? url, FRONTEND_PORT: String(port),
        SPECBOOK_BACKEND_URL: process.env.SPECBOOK_BACKEND_URL ?? apiUrl };
    const children: ServerProcess[] = [];
    const startup = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, startup.signal]) : startup.signal;
    const launch = (entry: string, directory: string, overrides: NodeJS.ProcessEnv): ServerProcess => {
        const child = spawn(process.execPath, [entry], { cwd: directory, env: { ...environment, ...overrides }, stdio: ["ignore", "pipe", "pipe"] });
        const state: ServerProcess = { child, exited: false, done: Promise.resolve() };
        for (const stream of [child.stdout, child.stderr]) {
            let pending = "";
            let writes = Promise.resolve();
            const write = (line: string) => { writes = writes.then(async () => {
                let safe: string;
                try { safe = redactTokens(await scrub(line)); } catch { safe = "Could not scrub server output securely"; }
                log(safe);
            }); };
            stream?.on("data", (chunk: Buffer) => {
                pending += chunk.toString();
                const lines = pending.split("\n");
                pending = lines.pop() ?? "";
                for (const line of lines) write(line);
                if (pending.length > 64_000) { write(pending.slice(0, 64_000)); pending = ""; }
            });
            stream?.on("end", () => { if (pending) write(pending); });
        }
        state.done = new Promise((resolve) => {
            child.once("error", () => { state.exited = true; state.error = new Error("A Specbook server process could not start"); startup.abort(state.error); resolve(); });
            child.once("exit", (code, childSignal) => {
                state.exited = true;
                if (!signal.aborted) { state.error = new Error(`A Specbook server process stopped (${childSignal ?? `exit ${code}`})`); startup.abort(state.error); }
                resolve();
            });
        });
        children.push(state);
        return state;
    };
    const waitReady = async (target: string) => {
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
            signal.throwIfAborted();
            try {
                const fetched = await fetch(target, { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]), redirect: "error" });
                await fetched.body?.cancel();
                if (fetched.ok) return;
            } catch { signal.throwIfAborted(); }
            await new Promise<void>((resolve) => setTimeout(resolve, 200));
        }
        throw new Error("Specbook did not become ready within 90 seconds; check the server output");
    };
    try {
        launch(serverEntry, data, { PORT: String(apiPort), HOST: host });
        await waitReady(`${apiUrl}/health`);
        launch(path.join(resolvedUi.directory, "server.js"), resolvedUi.directory, { PORT: String(port), HOSTNAME: host });
        await waitReady(`${url}/api/health`);
        await emit({ event: "ready", url, apiUrl, port, host, data, ui: resolvedUi.directory, uiSource: resolvedUi.source });
        await new Promise<void>((resolve) => { signal.addEventListener("abort", () => resolve(), { once: true }); if (signal.aborted) resolve(); });
        if (startup.signal.aborted) throw startup.signal.reason;
    } finally {
        startup.abort();
        for (const state of children) if (!state.exited) state.child.kill("SIGTERM");
        const force = setTimeout(() => { for (const state of children) if (!state.exited) state.child.kill("SIGKILL"); }, 12_000);
        await Promise.all(children.map((state) => state.done));
        clearTimeout(force);
    }
    await emit({ event: "stopped", url });
}
