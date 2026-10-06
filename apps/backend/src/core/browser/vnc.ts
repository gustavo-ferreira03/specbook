import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { WebSocket } from "ws";

const DISPLAY_START = 99;
const DISPLAY_END = 119;
const VNC_PORT_START = 5900;
export const SCREEN_WIDTH = 1280;
export const SCREEN_HEIGHT = 800;

export interface VncSession {
    id: string;
    display: string;
    port: number;
}

interface VncSessionRecord extends VncSession {
    displayNumber: number;
    xvfbProc: ChildProcess;
    x11vncProc: ChildProcess;
    password: string;
    passwordDir: string;
}

interface SpawnedProcess {
    proc: ChildProcess;
    ready: Promise<void>;
}

const sessions = new Map<string, VncSessionRecord>();
const reservedDisplays = new Set<number>();

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnWithOutput(cmd: string, args: string[], env: NodeJS.ProcessEnv): SpawnedProcess {
    const proc = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"], env });
    let stderr = "";
    const ready = new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve();
        }, 700);
        proc.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        proc.once("error", (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        proc.once("exit", (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(stderr.trim() || `${cmd} exited early: ${code ?? signal ?? "unknown"}`));
        });
    });
    return { proc, ready };
}

function x11Env(display: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, DISPLAY: display, XDG_SESSION_TYPE: "x11" };
    delete env.WAYLAND_DISPLAY;
    return env;
}

function hasStopped(proc: ChildProcess): boolean {
    return proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null;
}

async function stopProcess(proc: ChildProcess | null): Promise<void> {
    if (!proc || hasStopped(proc)) return;
    proc.kill("SIGKILL");
    for (let attempt = 0; attempt < 40 && !hasStopped(proc); attempt += 1) {
        await sleep(25);
    }
}

async function cleanOwnedDisplayArtifacts(display: number, proc: ChildProcess): Promise<void> {
    const pid = proc.pid;
    if (pid === undefined || !hasStopped(proc)) return;
    const lockPath = `/tmp/.X${display}-lock`;
    const socketPath = `/tmp/.X11-unix/X${display}`;
    const readLockPid = async (): Promise<number | null> => {
        try {
            const value = Number.parseInt((await fs.readFile(lockPath, "utf8")).trim(), 10);
            return Number.isInteger(value) ? value : null;
        } catch {
            return null;
        }
    };
    if ((await readLockPid()) !== pid) return;
    try {
        await fs.rm(socketPath, { force: true });
    } catch {
        return;
    }
    if ((await readLockPid()) === pid) {
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
    }
}

async function stopRecord(record: VncSessionRecord): Promise<void> {
    await Promise.all([stopProcess(record.x11vncProc), stopProcess(record.xvfbProc)]);
    await cleanOwnedDisplayArtifacts(record.displayNumber, record.xvfbProc);
    await fs.rm(record.passwordDir, { recursive: true, force: true }).catch(() => undefined);
    reservedDisplays.delete(record.displayNumber);
}

/**
 * x11vnc reads the password from a private file instead of argv, so it never
 * shows up in `ps`. VNC authentication only uses the first 8 characters.
 */
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
        if (sessions.get(record.id) === record) stopVncStack(record.id);
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

export async function startVncStack(): Promise<VncSession> {
    let lastError: unknown;
    for (let display = DISPLAY_START; display <= DISPLAY_END; display += 1) {
        if (reservedDisplays.has(display)) continue;
        reservedDisplays.add(display);
        const displayName = `:${display}`;
        const port = VNC_PORT_START + (display - DISPLAY_START);
        let xvfbProc: ChildProcess | null = null;
        let x11vncProc: ChildProcess | null = null;
        let record: VncSessionRecord | null = null;
        let passwordDir: string | null = null;
        let active = false;
        try {
            const secret = await writePasswordFile();
            passwordDir = secret.dir;
            const xvfb = spawnWithOutput(
                "Xvfb",
                [displayName, "-screen", "0", `${SCREEN_WIDTH}x${SCREEN_HEIGHT}x24`],
                x11Env(displayName),
            );
            xvfbProc = xvfb.proc;
            await xvfb.ready;
            await sleep(500);
            if (hasStopped(xvfbProc)) throw new Error(`Xvfb failed to start on ${displayName}`);
            const x11vnc = spawnWithOutput(
                "x11vnc",
                [
                    "-display",
                    displayName,
                    "-localhost",
                    "-rfbport",
                    String(port),
                    "-passwdfile",
                    secret.file,
                    "-quiet",
                    "-forever",
                    "-shared",
                    "-noipv6",
                    "-noshm",
                    "-wait",
                    "50",
                    "-nap",
                ],
                x11Env(displayName),
            );
            x11vncProc = x11vnc.proc;
            await x11vnc.ready;
            await sleep(500);
            if (hasStopped(xvfbProc) || hasStopped(x11vncProc)) {
                throw new Error(`Xvfb/x11vnc failed to start on ${displayName}`);
            }
            record = {
                id: crypto.randomUUID(),
                display: displayName,
                displayNumber: display,
                port,
                xvfbProc,
                x11vncProc,
                password: secret.password,
                passwordDir: secret.dir,
            };
            monitorSession(record);
            sessions.set(record.id, record);
            if (hasStopped(xvfbProc) || hasStopped(x11vncProc)) {
                sessions.delete(record.id);
                throw new Error(`Xvfb/x11vnc failed to start on ${displayName}`);
            }
            active = true;
            return publicSession(record);
        } catch (error) {
            lastError = error;
            if (record) sessions.delete(record.id);
            await Promise.all([stopProcess(x11vncProc), stopProcess(xvfbProc)]);
            if (xvfbProc) await cleanOwnedDisplayArtifacts(display, xvfbProc);
            if (passwordDir) await fs.rm(passwordDir, { recursive: true, force: true }).catch(() => undefined);
        } finally {
            if (!active) reservedDisplays.delete(display);
        }
    }
    throw lastError instanceof Error ? lastError : new Error("Xvfb/x11vnc failed to start");
}

export function stopVncStack(id: string): void {
    const record = sessions.get(id);
    if (!record) return;
    sessions.delete(id);
    void stopRecord(record);
}

const RFB_HANDSHAKE_TIMEOUT_MS = 10_000;
const RFB_SECURITY_NONE = 1;
const RFB_SECURITY_VNC_AUTH = 2;

/** Buffers a byte stream so a handshake can read exact message sizes. */
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

    /** Returns whatever arrived beyond the handshake. */
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

/**
 * VNC authentication encrypts the challenge with single DES keyed by the
 * bit-reversed password. OpenSSL 3 only ships DES in its legacy provider, but
 * triple DES with three identical keys is exactly single DES.
 */
function vncAuthResponse(password: string, challenge: Buffer): Buffer {
    const key = Buffer.alloc(8);
    Buffer.from(password, "latin1").copy(key, 0, 0, 8);
    for (let index = 0; index < key.length; index += 1) key[index] = reverseBits(key[index]);
    const cipher = crypto.createCipheriv("des-ede3-ecb", Buffer.concat([key, key, key]), null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(challenge), cipher.final()]);
}

/** Speaks the RFB client handshake to x11vnc, answering its password challenge. */
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

/**
 * Presents a password-less RFB server to the browser. The browser is already
 * vetted by the WebSocket Origin check and holds the unguessable session id;
 * the VNC password stays inside the backend.
 */
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

/**
 * Bridges a browser WebSocket to the session's x11vnc, performing the VNC
 * password handshake on the browser's behalf before piping raw RFB traffic.
 */
export async function proxyVncSession(id: string, websocket: WebSocket): Promise<void> {
    const record = sessions.get(id);
    if (!record) {
        websocket.close(1008, "Unknown VNC session");
        return;
    }
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
    // From ClientInit onward both sides speak plain RFB, so bytes pass through.
    piping = true;
    const pendingUpstream = upstreamQueue.drain();
    const pendingDownstream = downstreamQueue.drain();
    if (pendingDownstream.length > 0) upstream.write(pendingDownstream);
    if (pendingUpstream.length > 0 && websocket.readyState === websocket.OPEN) websocket.send(pendingUpstream);
}
