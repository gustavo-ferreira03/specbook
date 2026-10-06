import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { accountsRepository, type User } from "../../infra/repositories/accounts";
import { publicFrontendOrigin } from "../../infra/web/security";

export const SESSION_AGE_SECONDS = 7 * 24 * 60 * 60;
export const authEvents = new EventEmitter();
authEvents.setMaxListeners(0);
export const tokenHash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
export const randomToken = () => crypto.randomBytes(32).toString("hex");

export function publicUser(user: User) {
    return { id: user.id, name: user.name, email: user.email, role: user.role, disabledAt: user.disabledAt };
}

export function requestOrigin(c: Context): string {
    return publicFrontendOrigin(c) || new URL(c.req.url).origin;
}

export function cookieToken(headers: Headers, name = "specbook_session"): string | null {
    const cookies = new Map((headers.get("cookie") ?? "").split(";").map((pair) => {
        const index = pair.indexOf("=");
        return [pair.slice(0, index).trim(), pair.slice(index + 1).trim()];
    }));
    const token = cookies.get(`__Host-${name}`) ?? cookies.get(name);
    return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}

export async function sessionFromHeaders(headers: Headers) {
    const token = cookieToken(headers);
    return token ? accountsRepository.session(tokenHash(token)) : null;
}

export function writeCookie(c: Context, name: string, value: string, age: number, origin = requestOrigin(c)): void {
    const secure = origin.startsWith("https://");
    setCookie(c, secure ? `__Host-${name}` : name, value, { httpOnly: true, secure, sameSite: "Lax", path: "/", maxAge: age });
}

export function clearCookies(c: Context, name = "specbook_session"): void {
    deleteCookie(c, name, { path: "/" });
    deleteCookie(c, `__Host-${name}`, { path: "/", secure: true });
}

export async function startSession(c: Context, user: User, origin?: string): Promise<void> {
    const previous = cookieToken(c.req.raw.headers);
    if (previous) { await accountsRepository.deleteSession(tokenHash(previous)); authEvents.emit("session", tokenHash(previous)); }
    const token = randomToken();
    await accountsRepository.createSession(tokenHash(token), user.id, new Date(Date.now() + SESSION_AGE_SECONDS * 1000).toISOString());
    writeCookie(c, "specbook_session", token, SESSION_AGE_SECONDS, origin);
}

export async function revokeUserSessions(userId: string): Promise<void> {
    await accountsRepository.revokeUserSessions(userId);
    authEvents.emit("user", userId);
}

export async function watchSession(headers: Headers, close: () => void): Promise<() => void> {
    const initial = await sessionFromHeaders(headers);
    if (!initial) { close(); return () => {}; }
    const userChanged = (id: string) => { if (id === initial.user.id) close(); };
    const revoked = (hash: string) => { if (hash === initial.session.tokenHash) close(); };
    authEvents.on("user", userChanged);
    authEvents.on("session", revoked);
    const expiry = setTimeout(close, Math.max(0, Date.parse(initial.session.expiresAt) - Date.now()));
    expiry.unref();
    const cleanup = () => { clearTimeout(expiry); authEvents.off("user", userChanged); authEvents.off("session", revoked); };
    try { if (!await sessionFromHeaders(headers)) close(); }
    catch { close(); }
    return cleanup;
}
