import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

const MAX_OUTPUT_CHARS = 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_RUNS = 2;
const ENV_ALLOWLIST = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LANGUAGE",
    "TZ",
    "DISPLAY",
    "XAUTHORITY",
    "TMPDIR",
    "TMP",
    "TEMP",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "LD_LIBRARY_PATH",
    "FONTCONFIG_PATH",
    "FONTCONFIG_FILE",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
]);
const ENV_PREFIX_ALLOWLIST = ["LC_", "PLAYWRIGHT_"];

export interface ProcessResult {
    code: number | null;
    output: string;
    timedOut: boolean;
}

const activeProcesses = new Set<ChildProcess>();

export function minimalChildEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined) continue;
        if (ENV_ALLOWLIST.has(key) || ENV_PREFIX_ALLOWLIST.some((prefix) => key.startsWith(prefix))) env[key] = value;
    }
    const nodeDir = path.dirname(process.execPath);
    const entries = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
    if (!entries.includes(nodeDir)) env.PATH = [nodeDir, ...entries].join(path.delimiter);
    for (const [key, value] of Object.entries(extra)) {
        if (value === undefined) delete env[key];
        else env[key] = value;
    }
    return env;
}

export function terminateProcessTree(proc: ChildProcess): void {
    if (process.platform === "linux" && proc.pid) {
        try {
            process.kill(-proc.pid, "SIGKILL");
            return;
        } catch {}
    }
    try {
        proc.kill("SIGKILL");
    } catch {}
}

export function stopActiveProcesses(): void {
    for (const proc of activeProcesses) terminateProcessTree(proc);
}

export function runNodeCli(
    script: string,
    args: string[],
    options: { cwd: string; timeoutMs: number; env?: Record<string, string | undefined>; signal?: AbortSignal },
): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
        options.signal?.throwIfAborted();
        const proc = spawn(process.execPath, [script, ...args], {
            cwd: options.cwd,
            env: minimalChildEnv(options.env),
            detached: process.platform === "linux",
            stdio: ["ignore", "pipe", "pipe"],
        });
        activeProcesses.add(proc);
        let output = "";
        let settled = false;
        const append = (data: Buffer) => {
            output += data.toString();
            if (output.length > MAX_OUTPUT_CHARS * 2) output = output.slice(-MAX_OUTPUT_CHARS);
        };
        const collected = () => output.slice(-MAX_OUTPUT_CHARS);
        const finish = (result: ProcessResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", abort);
            resolve(result);
        };
        const timer = setTimeout(() => {
            terminateProcessTree(proc);
            finish({ code: null, output: collected(), timedOut: true });
        }, options.timeoutMs);
        const abort = () => terminateProcessTree(proc);
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
        proc.stdout.on("data", append);
        proc.stderr.on("data", append);
        proc.once("error", (error) => {
            activeProcesses.delete(proc);
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", abort);
            reject(error);
        });
        proc.once("exit", (code) => {
            activeProcesses.delete(proc);
            finish({ code, output: collected(), timedOut: false });
        });
    });
}

function maxConcurrentRuns(): number {
    const value = Number(process.env.SPECBOOK_MAX_CONCURRENT_RUNS);
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_CONCURRENT_RUNS;
}

let runningSlots = 0;
const slotQueue: { resume: () => void; signal?: AbortSignal; abort: () => void }[] = [];

export async function withRunSlot<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (runningSlots >= maxConcurrentRuns()) {
        await new Promise<void>((resolve, reject) => {
            const waiter = { resume: resolve, signal, abort: () => {
                const index = slotQueue.indexOf(waiter);
                if (index < 0) return;
                slotQueue.splice(index, 1);
                reject(signal?.reason ?? new Error("Run cancelled"));
            } };
            slotQueue.push(waiter);
            signal?.addEventListener("abort", waiter.abort, { once: true });
            if (signal?.aborted) waiter.abort();
        });
    } else {
        runningSlots += 1;
    }
    try {
        signal?.throwIfAborted();
        return await work();
    } finally {
        const next = slotQueue.shift();
        if (next) {
            next.signal?.removeEventListener("abort", next.abort);
            next.resume();
        } else runningSlots -= 1;
    }
}
