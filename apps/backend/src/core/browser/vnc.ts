import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";

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
    reservedDisplays.delete(record.displayNumber);
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
        let active = false;
        try {
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
                    "-nopw",
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
