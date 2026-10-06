import { NextResponse, type NextRequest } from "next/server";
import { buildHostAllowlist, isAllowedHost, matchesOriginHost } from "../../../shared/http-origin";

export function proxy(request: NextRequest) {
    const host = request.headers.get("host") ?? "";
    if (!isAllowedHost(buildHostAllowlist(4001), host)) {
        return NextResponse.json({ error: "Host not allowed. Add it to SPECBOOK_ALLOWED_HOSTS." }, { status: 421 });
    }
    const origin = request.headers.get("origin");
    if (origin && !matchesOriginHost(origin, host)) {
        return NextResponse.json({ error: "Origin not allowed" }, { status: 403 });
    }
    const target = new URL(process.env.SPECBOOK_BACKEND_URL ?? "http://127.0.0.1:4000");
    target.pathname = request.nextUrl.pathname.slice("/api".length) || "/";
    target.search = request.nextUrl.search;
    const headers = new Headers(request.headers);
    for (const name of [...headers.keys()]) {
        if (name.startsWith("x-forwarded-") || name.startsWith("x-specbook-proxy") || name === "forwarded") headers.delete(name);
    }
    headers.set("x-specbook-proxy", "1");
    headers.set("x-forwarded-host", host);
    headers.set("x-forwarded-proto", origin ? new URL(origin).protocol.slice(0, -1) : request.nextUrl.protocol.slice(0, -1));
    return NextResponse.rewrite(target, { request: { headers } });
}

export const config = { matcher: "/api/:path*" };
