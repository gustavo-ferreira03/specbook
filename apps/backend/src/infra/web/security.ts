import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { RUNNER_REQUEST_LIMIT_BYTES } from "@specbook/runtime/runner-protocol";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

import {
  buildHostAllowlist,
  frontendProxyOrigin,
  isAllowedHost,
} from "../../../../../shared/http-origin";
import type { HostAllowlist } from "../../../../../shared/http-origin";
import { logger } from "../logger";

export const publicFrontendOrigin = function publicFrontendOrigin(
  c: Context
): string {
  return (
    frontendProxyOrigin(
      c.req.raw.headers,
      buildHostAllowlist(Number(process.env.PORT ?? 4000))
    ) ?? (process.env.FRONTEND_ORIGIN ?? "").replace(/\/$/u, "")
  );
};

export const isAllowedWebsocketOrigin = function isAllowedWebsocketOrigin(
  headers: Headers,
  allowlist: HostAllowlist,
  allowedOrigins: Set<string>
): boolean {
  const origin = headers.get("origin");
  return (
    origin !== null &&
    (allowedOrigins.has(origin) ||
      origin === frontendProxyOrigin(headers, allowlist))
  );
};

export const htmlReportHeaders = function htmlReportHeaders(
  html: string
): Record<string, string> {
  const elements = [
    ...html.matchAll(
      /<script\b(?<capture1>[^>]*)>(?<capture2>[\s\S]*?)<\/script\s*>/giu
    ),
  ];
  const scripts = elements
    .filter(
      (match) =>
        !/\btype\s*=\s*["'](?:application\/octet-stream|application\/json)["']/iu.test(
          match[1]
        )
    )
    .map(
      (match) =>
        `'sha256-${createHash("sha256").update(match[2]).digest("base64")}'`
    );
  const library = elements.find(
    (match) =>
      /\bid\s*=\s*["']specbook-replay-library["']/iu.test(match[1]) &&
      /\btype\s*=\s*["']application\/octet-stream["']/iu.test(match[1])
  );
  if (library && library[2].length <= 2_000_000) {
    try {
      const source = gunzipSync(Buffer.from(library[2].trim(), "base64"), {
        maxOutputLength: 1_000_000,
      });
      scripts.push(
        `'sha256-${createHash("sha256").update(source).digest("base64")}'`
      );
    } catch {
      /* Cleanup is best effort after the operation has completed or failed. */
    }
  }
  return {
    "Content-Type": "text/html; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": `default-src 'none'; connect-src 'none'; script-src ${scripts.join(" ") || "'none'"}; img-src data: blob:; media-src data:; font-src data:; style-src 'unsafe-inline'; frame-src about: blob:; sandbox allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox`,
  };
};

const isGitHttpPath = function isGitHttpPath(pathname: string): boolean {
  return pathname.startsWith("/git/");
};

export const hostGuard = function hostGuard(
  allowlist: HostAllowlist
): MiddlewareHandler {
  return async (c, next) => {
    const pathname = c.req.path;
    if (
      pathname === "/health" ||
      isGitHttpPath(pathname) ||
      pathname.startsWith("/ci/") ||
      pathname.startsWith("/runner/")
    ) {
      return await next();
    }
    const host = c.req.header("host");
    if (!isAllowedHost(allowlist, host)) {
      logger.warn("rejected request with unexpected Host header", {
        host,
        path: pathname,
      });
      return await c.json(
        { error: "Host not allowed. Add it to SPECBOOK_ALLOWED_HOSTS." },
        421
      );
    }
    return await next();
  };
};

export const csrfGuard = function csrfGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (
      SAFE_METHODS.has(c.req.method) ||
      isGitHttpPath(c.req.path) ||
      c.req.path.startsWith("/ci/") ||
      /^Bearer /iu.test(c.req.header("authorization") ?? "")
    ) {
      return await next();
    }
    if (c.req.header(REQUEST_HEADER) !== "1") {
      return await c.json({ error: `Missing ${REQUEST_HEADER} header` }, 403);
    }
    return await next();
  };
};

export const jsonBodyLimit = function jsonBodyLimit(
  maxSize = DEFAULT_BODY_LIMIT_BYTES
): MiddlewareHandler {
  const limiter = bodyLimit({
    maxSize,
    onError: (c) => c.json({ error: "Request body too large" }, 413),
  });
  const runnerLimiter = bodyLimit({
    maxSize: RUNNER_REQUEST_LIMIT_BYTES,
    onError: (c) =>
      c.json({ error: "Runner artifacts exceed the upload limit" }, 413),
  });
  return async (c, next) =>
    await (() => {
      if (isGitHttpPath(c.req.path)) {
        return next();
      }
      if (/^\/runner\/jobs\/[^/]+\/complete$/u.test(c.req.path)) {
        return runnerLimiter(c, next);
      }
      return limiter(c, next);
    })();
};

export const requestLogger = function requestLogger(): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    // oxlint-disable-next-line node/callback-return -- This is middleware continuation or a rendered text helper, rather than an error-first Node callback.
    await next();
    const { status } = c.res;
    const fields = {
      method: c.req.method,
      path: c.req.path,
      status,
      durationMs: Math.round(performance.now() - started),
    };
    if (status >= 500) {
      logger.error("request", fields);
    } else if (c.req.path === "/health") {
      logger.debug("request", fields);
    } else {
      logger.info("request", fields);
    }
  };
};

export { buildHostAllowlist, frontendProxyOrigin, isAllowedHost };

export const REQUEST_HEADER = "X-Specbook-Request";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEFAULT_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
