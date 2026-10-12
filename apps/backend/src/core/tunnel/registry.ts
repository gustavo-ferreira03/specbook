import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { CodedError } from "@specbook/runtime/errors";
import { RUNNER_PROTOCOL_VERSION, type RunnerQueueEntry } from "@specbook/runtime/runner-protocol";
import { tunnelConfigSchema, type TunnelConfig } from "@specbook/runtime/tunnel-protocol";
import { TunnelMultiplexer } from "@specbook/runtime/network/tunnel-stream";
import { createRunProxy } from "@specbook/runtime/network/proxy";
import { authenticateRunnerToken } from "../private-runner/tokens";
import { environmentsRepository } from "../../infra/repositories/environments";
import { runnersRepository, type RunnerToken } from "../../infra/repositories/runners";
import { projectsRepository } from "../../infra/repositories/projects";
import type { RunEnvironment } from "../../infra/db/schema";
import { isAllowedHost } from "../../infra/web/security";
import type { HostAllowlist } from "../../../../../shared/http-origin";

interface Connection { websocket: WebSocket; multiplexer: TunnelMultiplexer; runnerId: string; tokenHash: string; config: TunnelConfig }
interface Waiting { environment: RunEnvironment; projectId: string; runIds: string[]; queuedAt: string }
const connections = new Map<string, Connection>();
const connecting = new Set<string>();
const waiting = new Map<string, Waiting>();
let shutdown = new AbortController();
export class TunnelWaitInterrupted extends Error {}

export function stopTunnelWaits(): void { shutdown.abort(new TunnelWaitInterrupted("Backend stopped while waiting for a tunnel")); }

export function tunnelStartCommand(environment: Pick<RunEnvironment, "id" | "name">, projectId: string): string {
    return `specbook tunnel --project ${projectId} --environment ${environment.id}`;
}

export function hasTunnel(environmentId: string): boolean {
    return connections.get(environmentId)?.websocket.readyState === 1;
}

export function publicTunnels() {
    return [...connections.values()].filter((connection) => connection.websocket.readyState === 1).map(({ runnerId, config }) => ({
        runnerId, environmentId: config.environment.id, environmentName: config.environment.name, projectId: config.environment.projectId, group: config.environment.group, online: true,
    }));
}

function retireConnection(connection: Connection, code: number, reason: string): void {
    connection.multiplexer.close();
    connection.websocket.close(code, reason);
}

export function closeRunnerTunnels(runnerId: string): void {
    for (const connection of connections.values()) if (connection.runnerId === runnerId) retireConnection(connection, 1008, "Runner token changed");
}

export async function configuredTunnel(runner: RunnerToken, projectId: string, selector: string): Promise<TunnelConfig> {
    const projects = runner.projectIds;
    if (projects && !projects.includes(projectId)) throw new CodedError("environment", "This runner token is not allowed to access this project");
    const environment = (await environmentsRepository.list(projectId)).find((row) => row.id === selector || row.name.toLowerCase() === selector.toLowerCase());
    if (!environment || String(environment.executor) !== "tunnel") throw new CodedError("environment", "Choose an environment configured for server execution through a tunnel");
    if (!environment.runnerGroup || runner.group !== environment.runnerGroup) throw new CodedError("environment", "Use a runner token restricted to this environment's runner group");
    return tunnelConfigSchema.parse({
        environment: { id: environment.id, projectId, name: environment.name, group: environment.runnerGroup },
        origins: [...new Set([new URL(environment.baseUrl).origin, ...environment.allowedOrigins])], websocketPath: "/runner/tunnel",
    });
}

async function currentConnection(connection: Connection): Promise<boolean> {
    const runner = await runnersRepository.get(connection.runnerId);
    if (!runner || runner.tokenHash !== connection.tokenHash) return false;
    try {
        const current = await configuredTunnel(runner, connection.config.environment.projectId, connection.config.environment.id);
        return JSON.stringify(current) === JSON.stringify(connection.config);
    } catch { return false; }
}

export async function createEnvironmentTunnelProxy(environment: RunEnvironment) {
    if (!hasTunnel(environment.id)) throw new CodedError("environment", `No tunnel connected in group ${environment.runnerGroup ?? "(unset)"}. Start specbook tunnel inside the private network.`);
    return createRunProxy(environment.allowedOrigins, undefined, async (target) => {
        const connection = connections.get(environment.id);
        if (!connection || !environment.allowedOrigins.includes(target.origin) || !connection.config.origins.includes(target.origin)) {
            throw new CodedError("environment", "Tunnel connection unavailable or target blocked");
        }
        if (!await currentConnection(connection)) {
            retireConnection(connection, 1008, "Tunnel configuration changed");
            throw new CodedError("environment", "Tunnel connection unavailable or target blocked");
        }
        return connection.multiplexer.connect(target.origin);
    });
}

export async function waitForTunnel(environment: RunEnvironment, projectId: string, runIds: string[] = [], signal?: AbortSignal, queuedAt = new Date().toISOString()): Promise<void> {
    signal = signal ? AbortSignal.any([signal, shutdown.signal]) : shutdown.signal;
    signal.throwIfAborted();
    if (hasTunnel(environment.id)) return;
    const id = crypto.randomUUID();
    waiting.set(id, { environment, projectId, runIds, queuedAt });
    try {
        while (!hasTunnel(environment.id)) {
            signal?.throwIfAborted();
            await new Promise<void>((resolve) => {
                const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
                const timer = setTimeout(done, 500);
                signal?.addEventListener("abort", done, { once: true });
                if (signal?.aborted) done();
            });
        }
        signal?.throwIfAborted();
    } finally { waiting.delete(id); }
}

export function pendingTunnelRunIds(): string[] { return [...waiting.values()].flatMap((entry) => entry.runIds); }

export async function tunnelQueueEntries(): Promise<RunnerQueueEntry[]> {
    const groups = new Map<string, Waiting[]>();
    for (const entry of waiting.values()) if (entry.runIds.length) groups.set(entry.environment.id, [...groups.get(entry.environment.id) ?? [], entry]);
    return Promise.all([...groups.values()].map(async (entries) => {
        const first = entries[0]!;
        const oldest = entries.reduce((value, entry) => entry.queuedAt < value ? entry.queuedAt : value, first.queuedAt);
        return {
            projectId: first.projectId, projectName: (await projectsRepository.getProject(first.projectId))?.name ?? "Project",
            environmentId: first.environment.id, environmentName: first.environment.name, group: first.environment.runnerGroup ?? null,
            executor: "tunnel" as const, queued: entries.reduce((sum, entry) => sum + entry.runIds.length, 0),
            oldestQueuedAt: oldest, oldestWaitMs: Math.max(0, Date.now() - Date.parse(oldest)), onlineRunners: hasTunnel(first.environment.id) ? 1 : 0, busyRunners: 0,
            reason: `No tunnel connected in group ${first.environment.runnerGroup ?? "(unset)"}.`,
        };
    }));
}

export function attachTunnelWebSockets(server: Server, hostAllowlist: HostAllowlist): () => void {
    if (shutdown.signal.aborted) shutdown = new AbortController();
    const wss = new WebSocketServer({ noServer: true, maxPayload: 65_536, perMessageDeflate: false });
    const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        if (request.url?.split("?")[0] !== "/runner/tunnel") return;
        let reservedEnvironment: string | undefined;
        let pendingInstance: { runnerId: string; id: string } | undefined;
        socket.once("close", () => {
            if (reservedEnvironment) connecting.delete(reservedEnvironment);
            if (pendingInstance) void runnersRepository.disconnect(pendingInstance.runnerId, pendingInstance.id).catch(() => undefined);
        });
        const reject = (status: number, message: string) => socket.end(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Forbidden"}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${message}`);
        void (async () => {
            if (!isAllowedHost(hostAllowlist, request.headers.host) || request.headers.origin) { reject(403, "Tunnel connections must come from the CLI"); return; }
            const runner = await authenticateRunnerToken(request.headers.authorization);
            if (!runner) { reject(401, "Provide a valid runner token"); return; }
            if (request.headers["x-specbook-protocol"] !== String(RUNNER_PROTOCOL_VERSION)) { reject(409, `Runner protocol is incompatible. Install the CLI from this server and restart specbook tunnel.`); return; }
            const version = String(request.headers["x-specbook-version"] ?? "");
            if (!version || version.length > 100) { reject(400, "Provide the CLI version"); return; }
            const projectId = String(request.headers["x-specbook-project"] ?? "");
            const environmentSelector = String(request.headers["x-specbook-environment"] ?? "");
            let config: TunnelConfig;
            try { config = await configuredTunnel(runner, projectId, environmentSelector); }
            catch { reject(403, "Runner token is not allowed to tunnel this environment"); return; }
            const environmentId = config.environment.id;
            if (socket.destroyed || socket.readableEnded) return;
            if (hasTunnel(environmentId) || connecting.has(environmentId)) { reject(409, "A tunnel is already connected for this environment"); return; }
            connecting.add(environmentId);
            reservedEnvironment = environmentId;
            await runnersRepository.touch(runner.id, { version, protocolVersion: RUNNER_PROTOCOL_VERSION, concurrency: 1 });
            const instanceId = crypto.randomUUID();
            pendingInstance = { runnerId: runner.id, id: instanceId };
            const versions = { version, protocolVersion: RUNNER_PROTOCOL_VERSION, concurrency: 1 };
            await runnersRepository.reportInstance(runner.id, instanceId, versions, "tunnel");
            if ((await runnersRepository.get(runner.id))?.tokenHash !== runner.tokenHash || socket.destroyed || socket.readableEnded) {
                await runnersRepository.disconnect(runner.id, instanceId);
                connecting.delete(environmentId);
                reservedEnvironment = undefined;
                reject(401, "Runner token changed");
                return;
            }
            wss.handleUpgrade(request, socket, head, (websocket) => {
                const connection: Connection = { websocket, multiplexer: new TunnelMultiplexer(websocket), runnerId: runner.id, tokenHash: runner.tokenHash, config };
                pendingInstance = undefined;
                connections.set(environmentId, connection);
                connecting.delete(environmentId);
                reservedEnvironment = undefined;
                websocket.send(JSON.stringify({ type: "ready", ...config }));
                let alive = true;
                websocket.on("pong", () => { alive = true; });
                const monitor = setInterval(() => {
                    if (!alive) { connection.multiplexer.close(); websocket.terminate(); return; }
                    alive = false;
                    websocket.ping();
                    void currentConnection(connection).then(async (current) => {
                        if (!current) retireConnection(connection, 1008, "Runner token or tunnel configuration changed");
                        else if (websocket.readyState === 1) {
                            await runnersRepository.touch(runner.id);
                            if (websocket.readyState !== 1) return;
                            await runnersRepository.reportInstance(runner.id, instanceId, versions, "tunnel");
                            if (websocket.readyState !== 1) await runnersRepository.disconnect(runner.id, instanceId);
                        }
                    }).catch(() => retireConnection(connection, 1011, "Could not verify tunnel"));
                }, 5000);
                monitor.unref();
                websocket.on("error", () => undefined);
                websocket.once("close", () => {
                    clearInterval(monitor);
                    if (connections.get(environmentId) === connection) connections.delete(environmentId);
                    void runnersRepository.disconnect(runner.id, instanceId).catch(() => undefined);
                });
            });
        })().catch(() => { if (reservedEnvironment) connecting.delete(reservedEnvironment); reject(403, "Could not open tunnel"); });
    };
    server.on("upgrade", upgrade);
    return () => { stopTunnelWaits(); server.off("upgrade", upgrade); for (const websocket of wss.clients) websocket.terminate(); wss.close(); };
}
