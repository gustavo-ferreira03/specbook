import type { Agent as HttpAgent } from "node:http";
import { ProxyAgent, type Dispatcher } from "undici-proxy";
import { HttpsProxyAgent } from "https-proxy-agent";

const dispatchers = new Map<string, Dispatcher>();
const socketAgents = new Map<string, HttpAgent>();
const env = (name: string) => process.env[name.toLowerCase()] ?? process.env[name];

function proxyFor(input: string | URL): string | undefined {
    const url = new URL(input);
    const secure = url.protocol === "https:" || url.protocol === "wss:";
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    const port = url.port || (secure ? "443" : "80");
    for (const entry of (env("NO_PROXY") ?? "").split(/[\s,]+/).filter(Boolean)) {
        if (entry === "*") return;
        const match = entry.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
        if (!match || match[2] && match[2] !== port) continue;
        const host = match[1]!.toLowerCase().replace(/\.$/, "").replace(/^\*?\./, "");
        if (hostname === host || hostname.endsWith(`.${host}`)) return;
    }
    const value = secure ? env("HTTPS_PROXY") || env("HTTP_PROXY") : env("HTTP_PROXY");
    if (!value) return;
    try {
        const proxy = new URL(value);
        if (!["http:", "https:"].includes(proxy.protocol) || proxy.search || proxy.hash) throw new Error();
    } catch { throw new Error("Use an HTTP(S) URL for HTTPS_PROXY or HTTP_PROXY"); }
    return value;
}

export function remoteFetch(url: string | URL, options: RequestInit = {}): Promise<Response> {
    const proxy = proxyFor(url);
    if (!proxy) return fetch(url, options);
    let dispatcher = dispatchers.get(proxy);
    if (!dispatcher) { dispatcher = new ProxyAgent(proxy); dispatchers.set(proxy, dispatcher); }
    return fetch(url, { ...options, dispatcher } as RequestInit & { dispatcher: Dispatcher });
}

export function webSocketProxyAgent(url: string | URL): HttpAgent | undefined {
    const proxy = proxyFor(url);
    if (!proxy) return;
    let agent = socketAgents.get(proxy);
    if (!agent) { agent = new HttpsProxyAgent(proxy); socketAgents.set(proxy, agent); }
    return agent;
}

export function redactProxyCredentials(text: string): string {
    const values = new Set<string>();
    for (const value of [env("HTTP_PROXY"), env("HTTPS_PROXY")]) {
        if (!value) continue;
        values.add(value);
        try {
            const url = new URL(value);
            const username = decodeURIComponent(url.username);
            const password = decodeURIComponent(url.password);
            if (username) values.add(username);
            if (password) values.add(password);
            if (username || password) values.add(Buffer.from(`${username}:${password}`).toString("base64"));
        } catch { /* Invalid proxy configuration is still hidden. */ }
    }
    for (const value of [...values].flatMap((value) => [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]).sort((a, b) => b.length - a.length)) {
        if (value) text = text.split(value).join("[REDACTED]");
    }
    return text;
}
