import { isIP } from "node:net";

export interface HostAllowlist {
    any: boolean;
    exact: Set<string>;
    anyPort: Set<string>;
}

function parseHost(value: string): URL | null {
    if (!value || /[\s/@\\?#,]/.test(value)) return null;
    try {
        const url = new URL(`http://${value}`);
        return url.host ? url : null;
    } catch { return null; }
}

/** Literal addresses cannot be rebound through DNS and support arbitrary published ports. */
export function buildHostAllowlist(_port: number, env: NodeJS.ProcessEnv = process.env): HostAllowlist {
    const allowlist: HostAllowlist = { any: false, exact: new Set(), anyPort: new Set(["localhost"]) };
    for (const value of [env.FRONTEND_ORIGIN, env.SPECBOOK_PUBLIC_API_URL, env.SPECBOOK_BACKEND_URL]) {
        try { if (value) allowlist.exact.add(new URL(value).host.toLowerCase()); } catch {}
    }
    for (const raw of (env.SPECBOOK_ALLOWED_HOSTS ?? "").split(",")) {
        const entry = raw.trim().toLowerCase();
        if (entry === "*") allowlist.any = true;
        else {
            const url = parseHost(entry);
            if (!url) continue;
            if (entry === url.hostname) allowlist.anyPort.add(url.hostname);
            else allowlist.exact.add(url.host);
        }
    }
    return allowlist;
}

export function isAllowedHost(allowlist: HostAllowlist, host: string | undefined): boolean {
    const url = host ? parseHost(host) : null;
    if (!url) return false;
    return allowlist.any || isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0
        || allowlist.exact.has(url.host) || allowlist.anyPort.has(url.hostname);
}

export function matchesOriginHost(origin: string, host: string): boolean {
    try {
        const url = new URL(origin);
        const target = new URL(`${url.protocol}//${host}`);
        return ["http:", "https:"].includes(url.protocol) && url.origin === origin && url.host === target.host;
    } catch { return false; }
}

/** The bundled frontend removes incoming forwarding headers and supplies these after validation. */
export function frontendProxyOrigin(headers: Headers, allowlist: HostAllowlist): string | null {
    if (headers.get("x-specbook-proxy") !== "1") return null;
    const host = headers.get("x-forwarded-host") ?? "";
    const protocol = headers.get("x-forwarded-proto");
    if (!isAllowedHost(allowlist, host) || (protocol !== "http" && protocol !== "https")) return null;
    return `${protocol}://${host}`;
}
