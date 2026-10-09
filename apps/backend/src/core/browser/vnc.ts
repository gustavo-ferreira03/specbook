import { CodedError } from "../errors";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { WebSocket } from "ws";
import { minimalChildEnv } from "../runner/process";
import { browserFailureMessage } from "../jobs/presentation-errors";

export const SCREEN_WIDTH = 1280;
export const SCREEN_HEIGHT = 810;

export interface VncSession {
    id: string;
    display: string;
    port: number;
}

interface VncSessionRecord extends VncSession {
    xvfbProc: ChildProcess;
    x11vncProc: ChildProcess;
    password: string;
    passwordDir: string;
    viewers: Set<WebSocket>;
}

export class BrowserUnavailableError extends CodedError {
    constructor(cause: unknown) {
        super("infrastructure", browserFailureMessage(cause), { cause });
        this.name = "BrowserUnavailableError";
    }
}

interface SpawnedProcess {
    proc: ChildProcess;
    ready: Promise<number>;
}

const sessions = new Map<string, VncSessionRecord>();
const closing = new Map<string, Promise<void>>();

const PROCESS_SUPERVISOR = `
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const [cleanupDir, command, ...args] = process.argv.slice(1);
const child = spawn(command, args, { stdio: ["ignore", 1, 2, 3] });
let stopping = false;
let killTimer;
const stop = () => {
    if (stopping) return;
    stopping = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
    killTimer.unref();
};
const finish = async (code) => {
    clearTimeout(killTimer);
    process.stdin.destroy();
    if (cleanupDir) await fs.rm(cleanupDir, { recursive: true, force: true }).catch(() => {});
    process.exit(code);
};
child.once("error", error => { process.stderr.write(String(error)); void finish(1); });
child.once("exit", code => void finish(code || 0));
process.stdin.on("end", stop);
process.stdin.on("error", stop);
process.stdin.resume();
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
`;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnUntilReady(cmd: string, args: string[], env: NodeJS.ProcessEnv, output: 1 | 3, pattern: RegExp, cleanupDir = ""): SpawnedProcess {
    const proc = spawn(process.execPath, ["-e", PROCESS_SUPERVISOR, cleanupDir, cmd, ...args], {
        stdio: ["pipe", "pipe", "pipe", "pipe"], env,
    });
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    const ready = new Promise<number>((resolve, reject) => {
        let settled = false;
        let outputText = "";
        const finish = (error?: Error, value?: number) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve(value!);
        };
        const timer = setTimeout(() => finish(new Error(`${cmd} did not become ready: ${stderr.trim()}`)), 10_000);
        proc.stdio[output]?.on("data", (chunk: Buffer) => {
            outputText = (outputText + chunk.toString()).slice(-4000);
            const match = pattern.exec(outputText);
            if (match) finish(undefined, Number.parseInt(match[1], 10));
        });
        proc.once("error", (error) => finish(error));
        proc.once("exit", (code, signal) => finish(new Error(stderr.trim() || `${cmd} exited early: ${code ?? signal ?? "unknown"}`)));
    });
    if (output !== 1) proc.stdout?.resume();
    return { proc, ready };
}

function x11Env(display?: string): NodeJS.ProcessEnv {
    return minimalChildEnv({ DISPLAY: display, XDG_SESSION_TYPE: "x11" });
}

function hasStopped(proc: ChildProcess): boolean {
    return proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null;
}

async function stopProcess(proc: ChildProcess | null): Promise<void> {
    if (!proc || hasStopped(proc)) return;
    proc.stdin?.end();
    proc.kill("SIGTERM");
    for (let attempt = 0; attempt < 80 && !hasStopped(proc); attempt += 1) await sleep(25);
    if (!hasStopped(proc)) proc.kill("SIGKILL");
    for (let attempt = 0; attempt < 40 && !hasStopped(proc); attempt += 1) await sleep(25);
}

async function stopRecord(record: VncSessionRecord): Promise<void> {
    await stopProcess(record.x11vncProc);
    await stopProcess(record.xvfbProc);
    await fs.rm(record.passwordDir, { recursive: true, force: true }).catch(() => undefined);
}

async function writePasswordFile(): Promise<{ password: string; dir: string; file: string }> {
    const password = crypto.randomBytes(6).toString("base64url");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "specbook-vnc-"));
    const file = path.join(dir, "passwd");
    await fs.writeFile(file, `${password}\n`, { mode: 0o600 });
    return { password, dir, file };
}

function publicSession(record: VncSessionRecord): VncSession {
    return { id: record.id, display: record.display, port: record.port };
}

function monitorSession(record: VncSessionRecord): void {
    const stop = () => {
        if (sessions.get(record.id) === record) void stopVncStack(record.id);
    };
    record.xvfbProc.once("error", stop);
    record.xvfbProc.once("exit", stop);
    record.x11vncProc.once("error", stop);
    record.x11vncProc.once("exit", stop);
}

export function getVncSession(id: string): VncSession | null {
    const record = sessions.get(id);
    return record ? publicSession(record) : null;
}

export function hasVncViewers(id: string): boolean {
    return (sessions.get(id)?.viewers.size ?? 0) > 0;
}

async function startDisplay(): Promise<{ proc: ChildProcess; display: string }> {
    for (let attempt = 0; attempt < 16; attempt++) {
        const number = crypto.randomInt(100, 10_000);
        const occupied = await Promise.all([`/tmp/.X${number}-lock`, `/tmp/.X11-unix/X${number}`].map((file) =>
            fs.lstat(file).then(() => true, (error: NodeJS.ErrnoException) => error.code !== "ENOENT"),
        ));
        if (occupied.some(Boolean)) continue;
        const xvfb = spawnUntilReady("Xvfb", [`:${number}`, "-displayfd", "3", "-screen", "0", `${SCREEN_WIDTH}x${SCREEN_HEIGHT}x24`, "-nolisten", "tcp"], x11Env(), 3, /^(\d+)\n/m);
        try {
            return { proc: xvfb.proc, display: `:${await xvfb.ready}` };
        } catch (error) {
            await stopProcess(xvfb.proc);
            if (!(error instanceof Error) || !/already active|already in use|Cannot establish any listening sockets/.test(error.message)) throw error;
        }
    }
    throw new Error("No free browser display could be allocated");
}

export async function startVncStack(): Promise<VncSession> {
    let xvfbProc: ChildProcess | null = null;
    let x11vncProc: ChildProcess | null = null;
    let record: VncSessionRecord | null = null;
    let passwordDir: string | null = null;
    try {
        const secret = await writePasswordFile();
        passwordDir = secret.dir;
        const xvfb = await startDisplay();
        xvfbProc = xvfb.proc;
        const display = xvfb.display;
        const x11vnc = spawnUntilReady("x11vnc", [
            "-norc", "-display", display, "-localhost", "-passwdfile", secret.file,
            "-quiet", "-forever", "-shared", "-noipv6", "-no6", "-noshm", "-wait", "50", "-nap",
        ], x11Env(display), 1, /^PORT=(\d+)\r?\n/m, secret.dir);
        x11vncProc = x11vnc.proc;
        const port = await x11vnc.ready;
        record = { id: crypto.randomUUID(), display, port, xvfbProc, x11vncProc, password: secret.password, passwordDir: secret.dir, viewers: new Set() };
        monitorSession(record);
        sessions.set(record.id, record);
        if (hasStopped(xvfbProc) || hasStopped(x11vncProc)) throw new Error("The browser display stopped during startup");
        return publicSession(record);
    } catch (error) {
        if (record) sessions.delete(record.id);
        await stopProcess(x11vncProc);
        await stopProcess(xvfbProc);
        if (passwordDir) await fs.rm(passwordDir, { recursive: true, force: true }).catch(() => undefined);
        throw new BrowserUnavailableError(error);
    }
}

export async function stopVncStack(id: string): Promise<void> {
    const previous = closing.get(id);
    if (previous) return previous;
    const record = sessions.get(id);
    if (!record) return;
    sessions.delete(id);
    const task = stopRecord(record);
    closing.set(id, task);
    try { await task; } finally { closing.delete(id); }
}

const RFB_HANDSHAKE_TIMEOUT_MS = 10_000;
const RFB_SECURITY_NONE = 1;
const RFB_SECURITY_VNC_AUTH = 2;

class ByteQueue {
    private chunks: Buffer[] = [];
    private size = 0;
    private failure: Error | null = null;
    private waiter: { size: number; resolve: (value: Buffer) => void; reject: (error: Error) => void } | null = null;

    push(chunk: Buffer): void {
        this.chunks.push(chunk);
        this.size += chunk.length;
        this.flush();
    }

    fail(error: Error): void {
        this.failure ??= error;
        const waiter = this.waiter;
        this.waiter = null;
        waiter?.reject(this.failure);
    }

    read(size: number): Promise<Buffer> {
        if (this.failure) return Promise.reject(this.failure);
        return new Promise((resolve, reject) => {
            this.waiter = { size, resolve, reject };
            this.flush();
        });
    }

    drain(): Buffer {
        const rest = Buffer.concat(this.chunks);
        this.chunks = [];
        this.size = 0;
        return rest;
    }

    private flush(): void {
        if (!this.waiter || this.size < this.waiter.size) return;
        const all = Buffer.concat(this.chunks);
        const { size, resolve } = this.waiter;
        this.waiter = null;
        this.chunks = all.length > size ? [all.subarray(size)] : [];
        this.size = all.length - size;
        resolve(all.subarray(0, size));
    }
}

function parseRfbVersion(raw: Buffer): { major: number; minor: number } {
    const match = /^RFB (\d{3})\.(\d{3})\n$/.exec(raw.toString("latin1"));
    if (!match) throw new Error("Invalid RFB protocol version");
    return { major: Number(match[1]), minor: Number(match[2]) };
}

async function readReason(queue: ByteQueue): Promise<string> {
    const length = (await queue.read(4)).readUInt32BE(0);
    return (await queue.read(Math.min(length, 4096))).toString("utf8");
}

function reverseBits(byte: number): number {
    let result = 0;
    for (let bit = 0; bit < 8; bit += 1) result |= ((byte >> bit) & 1) << (7 - bit);
    return result;
}

function vncAuthResponse(password: string, challenge: Buffer): Buffer {
    const key = Buffer.alloc(8);
    Buffer.from(password, "latin1").copy(key, 0, 0, 8);
    for (let index = 0; index < key.length; index += 1) key[index] = reverseBits(key[index]);
    const cipher = crypto.createCipheriv("des-ede3-ecb", Buffer.concat([key, key, key]), null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(challenge), cipher.final()]);
}

async function authenticateUpstream(socket: net.Socket, queue: ByteQueue, password: string): Promise<void> {
    const server = parseRfbVersion(await queue.read(12));
    if (server.major !== 3 || server.minor < 3) throw new Error("Unsupported RFB server version");
    const minor = server.minor >= 8 ? 8 : server.minor >= 7 ? 7 : 3;
    socket.write(`RFB 003.00${minor}\n`);
    let type: number;
    if (minor >= 7) {
        const count = (await queue.read(1))[0];
        if (count === 0) throw new Error(`VNC server refused the connection: ${await readReason(queue)}`);
        const types = [...(await queue.read(count))];
        if (types.includes(RFB_SECURITY_VNC_AUTH)) type = RFB_SECURITY_VNC_AUTH;
        else if (types.includes(RFB_SECURITY_NONE)) type = RFB_SECURITY_NONE;
        else throw new Error("VNC server offers no supported security type");
        socket.write(Buffer.from([type]));
    } else {
        type = (await queue.read(4)).readUInt32BE(0);
        if (type === 0) throw new Error(`VNC server refused the connection: ${await readReason(queue)}`);
        if (type !== RFB_SECURITY_NONE && type !== RFB_SECURITY_VNC_AUTH) {
            throw new Error("VNC server offers no supported security type");
        }
    }
    if (type === RFB_SECURITY_VNC_AUTH) socket.write(vncAuthResponse(password, await queue.read(16)));
    if (type === RFB_SECURITY_VNC_AUTH || minor >= 8) {
        const result = (await queue.read(4)).readUInt32BE(0);
        if (result !== 0) {
            const reason = minor >= 8 ? await readReason(queue).catch(() => "") : "";
            throw new Error(`VNC authentication failed${reason ? `: ${reason}` : ""}`);
        }
    }
}

async function acceptDownstream(websocket: WebSocket, queue: ByteQueue): Promise<void> {
    websocket.send(Buffer.from("RFB 003.008\n", "latin1"));
    const client = parseRfbVersion(await queue.read(12));
    if (client.major !== 3) throw new Error("Unsupported RFB client version");
    if (client.minor >= 7) {
        websocket.send(Buffer.from([1, RFB_SECURITY_NONE]));
        const choice = (await queue.read(1))[0];
        if (choice !== RFB_SECURITY_NONE) throw new Error("VNC client chose an unsupported security type");
        if (client.minor >= 8) websocket.send(Buffer.alloc(4));
    } else {
        const type = Buffer.alloc(4);
        type.writeUInt32BE(RFB_SECURITY_NONE, 0);
        websocket.send(type);
    }
}

function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
    if (Array.isArray(data)) return Buffer.concat(data);
    return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

export async function proxyVncSession(id: string, websocket: WebSocket): Promise<void> {
    if (websocket.readyState !== websocket.OPEN) return;
    const record = sessions.get(id);
    if (!record) {
        websocket.close(1008, "Unknown VNC session");
        return;
    }
    record.viewers.add(websocket);
    websocket.once("close", () => record.viewers.delete(websocket));
    const upstream = net.createConnection(record.port, "127.0.0.1");
    const upstreamQueue = new ByteQueue();
    const downstreamQueue = new ByteQueue();
    let piping = false;
    const closeWebSocket = () => {
        if (websocket.readyState === websocket.OPEN || websocket.readyState === websocket.CONNECTING) {
            websocket.terminate();
        }
    };
    const cleanup = () => {
        upstream.destroy();
        closeWebSocket();
    };
    upstream.on("data", (data: Buffer) => {
        if (!piping) upstreamQueue.push(data);
        else if (websocket.readyState === websocket.OPEN) websocket.send(data);
    });
    upstream.on("close", () => {
        upstreamQueue.fail(new Error("VNC server closed the connection"));
        closeWebSocket();
    });
    upstream.on("error", (error) => {
        upstreamQueue.fail(error);
        cleanup();
    });
    websocket.on("message", (data) => {
        const chunk = toBuffer(data as Buffer | ArrayBuffer | Buffer[]);
        if (!piping) downstreamQueue.push(chunk);
        else if (upstream.writable) upstream.write(chunk);
    });
    websocket.on("close", () => {
        downstreamQueue.fail(new Error("Browser closed the connection"));
        upstream.destroy();
    });
    websocket.on("error", (error) => {
        downstreamQueue.fail(error);
        cleanup();
    });

    const timer = setTimeout(() => {
        const error = new Error("VNC handshake timed out");
        upstreamQueue.fail(error);
        downstreamQueue.fail(error);
    }, RFB_HANDSHAKE_TIMEOUT_MS);
    try {
        await authenticateUpstream(upstream, upstreamQueue, record.password);
        await acceptDownstream(websocket, downstreamQueue);
    } catch (error) {
        cleanup();
        throw error;
    } finally {
        clearTimeout(timer);
    }
    piping = true;
    const pendingUpstream = upstreamQueue.drain();
    const pendingDownstream = downstreamQueue.drain();
    if (pendingDownstream.length > 0) upstream.write(pendingDownstream);
    if (pendingUpstream.length > 0 && websocket.readyState === websocket.OPEN) websocket.send(pendingUpstream);
}
