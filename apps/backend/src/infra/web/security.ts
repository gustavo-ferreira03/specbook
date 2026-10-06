import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { logger } from "../logger";

export const REQUEST_HEADER = "X-Specbook-Request";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEFAULT_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

/**
 * Git Smart HTTP authenticates every request with a project token, so neither
 * DNS rebinding nor cross-site form posts can use it without that secret.
 */
function isGitHttpPath(pathname: string): boolean {
    return pathname.startsWith("/git/");
}

function hostOf(value: string | undefined): string | null {
    if (!value) return null;
    try {
        return new URL(value).host.toLowerCase();
    } catch {
        return null;
    }
}

function hostnameOf(host: string): string {
    if (host.startsWith("[")) {
        const end = host.indexOf("]");
        return end < 0 ? host : host.slice(0, end + 1);
    }
    const colon = host.lastIndexOf(":");
    return colon < 0 ? host : host.slice(0, colon);
}

interface HostAllowlist {
    any: boolean;
    exact: Set<string>;
    anyPort: Set<string>;
}

/**
 * Hosts the API answers for. Entries in SPECBOOK_ALLOWED_HOSTS without a port
 * match that hostname on any port; `*` disables the check.
 */
export function buildHostAllowlist(port: number, env: NodeJS.ProcessEnv = process.env): HostAllowlist {
    const allowlist: HostAllowlist = { any: false, exact: new Set(), anyPort: new Set() };
    for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) allowlist.exact.add(`${hostname}:${port}`);
    for (const url of [env.FRONTEND_ORIGIN, env.NEXT_PUBLIC_API_URL, env.SPECBOOK_PUBLIC_API_URL]) {
        const host = hostOf(url);
        if (host) allowlist.exact.add(host);
    }
    for (const raw of (env.SPECBOOK_ALLOWED_HOSTS ?? "").split(",")) {
        const entry = raw.trim().toLowerCase();
        if (!entry) continue;
        if (entry === "*") allowlist.any = true;
        else if (hostnameOf(entry) === entry) allowlist.anyPort.add(entry);
        else allowlist.exact.add(entry);
    }
    return allowlist;
}

export function isAllowedHost(allowlist: HostAllowlist, host: string | undefined): boolean {
    if (allowlist.any) return true;
    if (!host) return false;
    const normalized = host.trim().toLowerCase();
    return allowlist.exact.has(normalized) || allowlist.anyPort.has(hostnameOf(normalized));
}

/** Rejects requests whose Host header is not ours, which defeats DNS rebinding. */
export function hostGuard(allowlist: HostAllowlist): MiddlewareHandler {
    return async (c, next) => {
        const pathname = c.req.path;
        if (pathname === "/health" || isGitHttpPath(pathname)) return next();
        const host = c.req.header("host");
        if (!isAllowedHost(allowlist, host)) {
            logger.warn("rejected request with unexpected Host header", { host, path: pathname });
            return c.json({ error: "Host not allowed. Add it to SPECBOOK_ALLOWED_HOSTS." }, 421);
        }
        return next();
    };
}

/**
 * Requires a custom header on state-changing requests. Browsers cannot attach
 * it cross-origin without a CORS preflight, which only our frontend passes.
 */
export function csrfGuard(): MiddlewareHandler {
    return async (c, next) => {
        if (SAFE_METHODS.has(c.req.method) || isGitHttpPath(c.req.path)) return next();
        if (c.req.header(REQUEST_HEADER) !== "1") {
            return c.json({ error: `Missing ${REQUEST_HEADER} header` }, 403);
        }
        return next();
    };
}

/** Caps request bodies for the JSON API; Git Smart HTTP enforces its own limits. */
export function jsonBodyLimit(maxSize = DEFAULT_BODY_LIMIT_BYTES): MiddlewareHandler {
    const limiter = bodyLimit({
        maxSize,
        onError: (c) => c.json({ error: "Request body too large" }, 413),
    });
    return async (c, next) => (isGitHttpPath(c.req.path) ? next() : limiter(c, next));
}

/** One structured log line per request. */
export function requestLogger(): MiddlewareHandler {
    return async (c, next) => {
        const started = performance.now();
        await next();
        const status = c.res.status;
        const fields = {
            method: c.req.method,
            path: c.req.path,
            status,
            durationMs: Math.round(performance.now() - started),
        };
        if (status >= 500) logger.error("request", fields);
        else if (c.req.path === "/health") logger.debug("request", fields);
        else logger.info("request", fields);
    };
}
