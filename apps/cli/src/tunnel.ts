import net from "node:net";
import { WebSocket } from "ws";
import { RUNNER_CLI_VERSION, RUNNER_PROTOCOL_VERSION } from "@specbook/runtime/runner-protocol";
import { tunnelConfigSchema, tunnelReadySchema, type TunnelConfig } from "@specbook/runtime/tunnel-protocol";
import { TunnelMultiplexer } from "@specbook/runtime/network/tunnel-stream";
import { httpTarget, resolveTarget } from "@specbook/runtime/network/targets";
import { normalizeServerUrl, rememberToken, RemoteError } from "./remote";
import { remoteFetch, webSocketProxyAgent } from "./network";

export interface TunnelOptions { url: string; token: string; project: string; environment?: string; signal?: AbortSignal }
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

async function connect(api: string, token: string, config: TunnelConfig, signal: AbortSignal): Promise<WebSocket> {
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
        const fail = (error: Error) => { websocket.terminate(); reject(error); };
        websocket.once("unexpected-response", (_request, response) => {
            response.resume();
            fail(new RemoteError(response.statusCode === 409 ? "Tunnel is already connected or the protocol is incompatible. Install the CLI from this server and restart the tunnel." : "The runner token cannot open a tunnel for this environment", response.statusCode ?? 403));
        });
        websocket.once("error", () => fail(new Error("Could not open the tunnel; check the server URL, proxy and connection")));
        websocket.once("close", () => { signal.removeEventListener("abort", abort); reject(new Error("Tunnel connection closed")); });
        websocket.once("message", (data, binary) => {
            if (binary) { fail(new Error("Invalid tunnel handshake")); return; }
            let ready: unknown;
            try { ready = JSON.parse(data.toString()); } catch { fail(new Error("Invalid tunnel handshake")); return; }
            const parsed = tunnelReadySchema.safeParse(ready);
            if (!parsed.success || JSON.stringify(parsed.data.origins) !== JSON.stringify(config.origins)
                || parsed.data.environment.id !== config.environment.id) { fail(new Error("Tunnel configuration changed; reconnect")); return; }
            new TunnelMultiplexer(websocket, async (origin) => {
                if (!config.origins.includes(origin)) throw new Error("Network target blocked");
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
    if (!options.token || /\s/.test(options.token) || options.token.length > 4096) throw new Error("Provide one runner token through SPECBOOK_RUNNER_TOKEN or the hidden prompt");
    if (!options.project) throw new Error("SPECBOOK_PROJECT or --project is required");
    let api = normalizeServerUrl(options.url);
    const signal = options.signal ?? new AbortController().signal;
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
                if ([401, 403, 409].includes(response.status)) throw new RemoteError("Use a runner token restricted to this environment's group and project, and choose a tunnel environment", response.status);
                throw new Error("Specbook could not prepare the tunnel; retrying");
            }
            const config = tunnelConfigSchema.parse(await response.json());
            const websocket = await connect(api, options.token, config, signal);
            await emit({ event: "connected", url: api, environment: config.environment, origins: config.origins });
            await new Promise<void>((resolve, reject) => {
                if (websocket.readyState === WebSocket.CLOSED) { resolve(); return; }
                websocket.once("close", (code) => code === 1008 ? reject(new RemoteError("Runner token or tunnel configuration changed. Check Settings → Runners and restart the tunnel.", 403)) : resolve());
            });
        } catch (error) {
            if (signal.aborted) break;
            if (error instanceof RemoteError && [401, 403, 409].includes(error.status)) throw error;
            await emit({ event: "retrying", reason: "Tunnel disconnected; check the server URL, proxy and connection", retryInMs: 3000 });
        }
        await delay(3000, signal);
    }
    await emit({ event: "stopped", url: api });
}
