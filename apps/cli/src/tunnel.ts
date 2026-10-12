import net from "node:net";
import { WebSocket } from "ws";
import { RUNNER_PROTOCOL_VERSION } from "@specbook/runtime/runner-protocol";
import { tunnelConfigSchema, tunnelReadySchema, type TunnelConfig } from "@specbook/runtime/tunnel-protocol";
import { TunnelMultiplexer } from "@specbook/runtime/network/tunnel-stream";
import { httpTarget, resolveTarget } from "@specbook/runtime/network/targets";
import { normalizeServerUrl, rememberToken, RemoteError } from "./remote";
import { remoteFetch, webSocketProxyAgent } from "./network";
import { CLI_VERSION as RUNNER_CLI_VERSION } from "./version";

export interface TunnelOptions { url: string; token: string; project: string; environment?: string; allowedOrigins?: string[]; signal?: AbortSignal }
export type TunnelEvent =
    | { event: "connected"; url: string; environment: TunnelConfig["environment"]; origins: string[] }
    | { event: "retrying"; reason: string; retryInMs: number }
    | { event: "stopped"; url: string };

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, milliseconds);
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
    });
}

function requireAllowedOrigins(origins: string[], allowedOrigins: string[]): void {
    if (origins.some((origin) => !allowedOrigins.includes(origin))) throw new RemoteError("Tunnel configuration includes origins outside --allow-origin or SPECBOOK_TUNNEL_ALLOWED_ORIGINS", 403);
}

function monitorConnection(websocket: WebSocket): void {
    let pongTimeout: NodeJS.Timeout | undefined;
    const pong = () => { clearTimeout(pongTimeout); pongTimeout = undefined; };
    websocket.on("pong", pong);
    const interval = setInterval(() => {
        if (websocket.readyState !== WebSocket.OPEN || pongTimeout) return;
        pongTimeout = setTimeout(() => websocket.terminate(), 15_000);
        websocket.ping();
    }, 15_000);
    websocket.once("close", () => { clearInterval(interval); pong(); websocket.removeListener("pong", pong); });
}

async function connect(api: string, token: string, config: TunnelConfig, allowedOrigins: string[], signal: AbortSignal): Promise<WebSocket> {
    const url = new URL(`${api}${config.websocketPath}`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const websocket = new WebSocket(url, {
        headers: { Authorization: `Bearer ${token}`, "X-Specbook-Project": config.environment.projectId,
            "X-Specbook-Environment": config.environment.id, "X-Specbook-Version": RUNNER_CLI_VERSION, "X-Specbook-Protocol": String(RUNNER_PROTOCOL_VERSION) },
        agent: webSocketProxyAgent(url), handshakeTimeout: 15_000, maxPayload: 65_536, perMessageDeflate: false, followRedirects: false,
    });
    websocket.on("error", () => undefined);
    return new Promise<WebSocket>((resolve, reject) => {
        const abort = () => { websocket.terminate(); reject(signal.reason ?? new Error("Tunnel stopped")); };
        signal.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(() => fail(new Error("Tunnel handshake timed out")), 15_000);
        const fail = (error: Error) => { clearTimeout(timer); websocket.terminate(); reject(error); };
        websocket.once("unexpected-response", (_request, response) => {
            response.resume();
            const status = response.statusCode ?? 503;
            fail(new RemoteError(status === 409 ? "Another tunnel is already connected to this environment; retrying"
                : status === 426 ? "Tunnel protocol is incompatible. Install the CLI from this server and restart the tunnel."
                : "The tunnel token cannot open a tunnel for this environment", status));
        });
        websocket.once("error", () => fail(new Error("Could not open the tunnel; check the server URL, proxy and connection")));
        websocket.once("close", () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new Error("Tunnel connection closed")); });
        websocket.once("message", (data, binary) => {
            if (binary) { fail(new Error("Invalid tunnel handshake")); return; }
            let ready: unknown;
            try { ready = JSON.parse(data.toString()); } catch { fail(new Error("Invalid tunnel handshake")); return; }
            const parsed = tunnelReadySchema.safeParse(ready);
            if (!parsed.success) { fail(new Error("Invalid tunnel handshake")); return; }
            try { requireAllowedOrigins(parsed.data.origins, allowedOrigins); } catch (error) { fail(error as Error); return; }
            if (parsed.data.origins.length !== config.origins.length || parsed.data.origins.some((origin) => !config.origins.includes(origin))
                || parsed.data.environment.id !== config.environment.id) { fail(new Error("Tunnel configuration changed; reconnect")); return; }
            clearTimeout(timer);
            monitorConnection(websocket);
            new TunnelMultiplexer(websocket, async (origin) => {
                if (!config.origins.includes(origin) || !allowedOrigins.includes(origin)) throw new Error("Network target blocked");
                const target = httpTarget(origin);
                const address = await resolveTarget(target, true);
                return new Promise<net.Socket>((connected, refused) => {
                    const socket = net.connect({ host: address.address, port: Number(target.port || (target.protocol === "https:" ? 443 : 80)) });
                    socket.setTimeout(30_000, () => socket.destroy());
                    socket.once("connect", () => { socket.setNoDelay(); connected(socket); });
                    socket.once("error", () => { socket.destroy(); refused(new Error("Could not reach the allowed origin")); });
                    socket.once("close", () => refused(new Error("Allowed origin connection closed")));
                });
            });
            resolve(websocket);
        });
        if (signal.aborted) abort();
    });
}

export async function runTunnel(options: TunnelOptions, emit: (event: TunnelEvent) => Promise<void>): Promise<void> {
    rememberToken(options.token);
    if (!options.token || /\s/.test(options.token) || options.token.length > 4096) throw new Error("Provide one tunnel token through SPECBOOK_RUNNER_TOKEN or the hidden prompt");
    if (!options.project) throw new Error("SPECBOOK_PROJECT or --project is required");
    const allowedOrigins = [...new Set(options.allowedOrigins ?? [])];
    if (!allowedOrigins.length) throw new Error("Configure --allow-origin or SPECBOOK_TUNNEL_ALLOWED_ORIGINS with the application origins this tunnel may access");
    for (const origin of allowedOrigins) {
        try { if (httpTarget(origin).origin !== origin) throw new Error(); }
        catch { throw new Error("Tunnel allowed origins must be HTTP(S) origins without credentials, paths or fragments"); }
    }
    let api = normalizeServerUrl(options.url);
    const signal = options.signal ?? new AbortController().signal;
    let retryInMs = 3000;
    while (!signal.aborted) {
        try {
            const params = new URLSearchParams({ project: options.project, environment: options.environment ?? "Production" });
            const get = (url: string) => remoteFetch(`${url}/runner/tunnel/config?${params}`, { headers: { Authorization: `Bearer ${options.token}` },
                signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), redirect: "error" });
            let response = await get(api);
            if (!api.endsWith("/api") && (response.status === 404 || response.ok && response.headers.get("content-type")?.includes("text/html"))) {
                api += "/api";
                response = await get(api);
            }
            if (!response.ok) {
                await response.body?.cancel();
                if ([401, 403, 409].includes(response.status)) throw new RemoteError("Use a tunnel token restricted to this environment's group and project, and choose a tunnel environment", response.status);
                if (response.status === 426) throw new RemoteError("Tunnel protocol is incompatible. Install the CLI from this server and restart the tunnel.", 426);
                throw new Error("Specbook could not prepare the tunnel; retrying");
            }
            const config = tunnelConfigSchema.parse(await response.json());
            requireAllowedOrigins(config.origins, allowedOrigins);
            const websocket = await connect(api, options.token, config, allowedOrigins, signal);
            retryInMs = 3000;
            await emit({ event: "connected", url: api, environment: config.environment, origins: config.origins });
            await new Promise<void>((resolve, reject) => {
                if (websocket.readyState === WebSocket.CLOSED) { resolve(); return; }
                websocket.once("close", (code) => {
                    if (signal.aborted) resolve();
                    else if (code === 1008) reject(new RemoteError("Tunnel token or environment origins changed. Check Settings → Runners and restart the tunnel.", 403));
                    else reject(new Error("Tunnel disconnected"));
                });
            });
        } catch (error) {
            if (signal.aborted) break;
            if (error instanceof RemoteError && [401, 403, 426].includes(error.status)) throw error;
            const reason = error instanceof RemoteError && error.status === 409 ? "Another tunnel is already connected to this environment; retrying"
                : "Tunnel disconnected; check the server URL, proxy and connection";
            await emit({ event: "retrying", reason, retryInMs });
        }
        await delay(retryInMs, signal);
        retryInMs = Math.min(retryInMs * 2, 30_000);
    }
    await emit({ event: "stopped", url: api });
}
