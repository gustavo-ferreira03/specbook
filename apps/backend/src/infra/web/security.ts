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

/**
 * Git Smart HTTP and CI authenticate every request with a project token, so neither
 * DNS rebinding nor cross-site form posts can use it without that secret.
 */
function isGitHttpPath(pathname: string): boolean {
    return pathname.startsWith("/git/");
}

/** Rejects requests whose Host header is not ours, which defeats DNS rebinding. */
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

/**
 * Requires a custom header on state-changing requests. Browsers cannot attach
 * it cross-origin without a CORS preflight, which only our frontend passes.
 */
export function csrfGuard(): MiddlewareHandler {
    return async (c, next) => {
        if (SAFE_METHODS.has(c.req.method) || isGitHttpPath(c.req.path) || c.req.path.startsWith("/ci/")) return next();
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
