import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { logger } from "../logger";
import { buildHostAllowlist, frontendProxyOrigin, isAllowedHost, type HostAllowlist } from "../../../../../shared/http-origin";
export { buildHostAllowlist, frontendProxyOrigin, isAllowedHost };

export function publicFrontendOrigin(c: Context): string {
    return frontendProxyOrigin(c.req.raw.headers, buildHostAllowlist(Number(process.env.PORT ?? 4000)))
        ?? (process.env.FRONTEND_ORIGIN ?? "").replace(/\/$/, "");
}

export function isAllowedWebsocketOrigin(headers: Headers, allowlist: HostAllowlist, allowedOrigins: Set<string>): boolean {
    const origin = headers.get("origin");
    return origin !== null && (allowedOrigins.has(origin) || origin === frontendProxyOrigin(headers, allowlist));
}

export const REQUEST_HEADER = "X-Specbook-Request";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEFAULT_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

function isGitHttpPath(pathname: string): boolean {
    return pathname.startsWith("/git/");
}

export function hostGuard(allowlist: HostAllowlist): MiddlewareHandler {
    return async (c, next) => {
        const pathname = c.req.path;
        if (pathname === "/health" || isGitHttpPath(pathname) || pathname.startsWith("/ci/")) return next();
        const host = c.req.header("host");
        if (!isAllowedHost(allowlist, host)) {
            logger.warn("rejected request with unexpected Host header", { host, path: pathname });
            return c.json({ error: "Host not allowed. Add it to SPECBOOK_ALLOWED_HOSTS." }, 421);
        }
        return next();
    };
}

export function csrfGuard(): MiddlewareHandler {
    return async (c, next) => {
        if (SAFE_METHODS.has(c.req.method) || isGitHttpPath(c.req.path) || c.req.path.startsWith("/ci/") || c.req.path.startsWith("/mcp/projects/")) return next();
        if (c.req.header(REQUEST_HEADER) !== "1") {
            return c.json({ error: `Missing ${REQUEST_HEADER} header` }, 403);
        }
        return next();
    };
}

export function jsonBodyLimit(maxSize = DEFAULT_BODY_LIMIT_BYTES): MiddlewareHandler {
    const limiter = bodyLimit({
        maxSize,
        onError: (c) => c.json({ error: "Request body too large" }, 413),
    });
    return async (c, next) => (isGitHttpPath(c.req.path) ? next() : limiter(c, next));
}

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
