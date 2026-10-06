import * as oidc from "openid-client";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { accountsRepository, withAccountsLock } from "../../infra/repositories/accounts";
import { decryptSecret, encryptSecret } from "../credentials/crypto";
import { recordAudit } from "./audit";
import type { SsoSettings } from "./schemas";
import { clearCookies, cookieToken, randomToken, requestOrigin, startSession, tokenHash, writeCookie } from "./sessions";

let cached: { fingerprint: string; configuration: Promise<oidc.Configuration>; expires: number } | null = null;

export function validateIssuer(issuer: string): URL {
    let url: URL;
    try { url = new URL(issuer); } catch { throw new HTTPException(400, { message: "Enter the provider's issuer URL." }); }
    const localHttp = process.env.SPECBOOK_OIDC_ALLOW_HTTP === "1" && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.protocol !== "https:" && !localHttp || url.pathname.includes(".well-known")) {
        throw new HTTPException(400, { message: "Use the HTTPS issuer URL, without credentials, a query, or a discovery-document path." });
    }
    return url;
}

function configuration(settings: SsoSettings): Promise<oidc.Configuration> {
    const fingerprint = tokenHash(JSON.stringify(settings));
    if (cached?.fingerprint === fingerprint && cached.expires > Date.now()) return cached.configuration;
    const issuer = validateIssuer(settings.issuer);
    const secret = settings.clientSecret ? decryptSecret(settings.clientSecret) : undefined;
    const promise = oidc.discovery(issuer, settings.clientId, secret, secret ? oidc.ClientSecretPost(secret) : oidc.None(), {
        timeout: 15,
        execute: [oidc.enableNonRepudiationChecks, ...(issuer.protocol === "http:" ? [oidc.allowInsecureRequests] : [])],
    });
    cached = { fingerprint, configuration: promise, expires: Date.now() + 5 * 60_000 };
    promise.catch(() => { if (cached?.configuration === promise) cached = null; });
    return promise;
}

export function verifiedEmail(issuer: string, claims: Record<string, unknown>): string | null {
    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    const entra = /^https:\/\/login\.microsoftonline\.com\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/v2\.0$/i.test(issuer);
    if (claims.email_verified !== true && !(entra && claims.xms_edov === true)) return null;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
}

export async function beginOidc(c: Context, link: boolean): Promise<string> {
    const settings = await accountsRepository.getSso();
    if (!settings.enabled) throw new HTTPException(409, { message: "Single sign-on is not enabled." });
    const user = c.get("user");
    if (link && !user) throw new HTTPException(401, { message: "Sign in before connecting your account." });
    const config = await configuration(settings);
    const state = randomToken();
    const browser = randomToken();
    const nonce = oidc.randomNonce();
    const verifier = oidc.randomPKCECodeVerifier();
    const origin = requestOrigin(c);
    const redirectUri = `${origin}${c.req.header("x-specbook-proxy") === "1" ? "/api" : ""}/auth/oidc/callback`;
    await accountsRepository.cleanup();
    await accountsRepository.saveOidcState({ stateHash: tokenHash(state), browserHash: tokenHash(browser), pkceVerifier: encryptSecret(verifier),
        nonce, redirectUri, issuer: settings.issuer, clientId: settings.clientId, linkUserId: link ? user!.id : null,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    writeCookie(c, "specbook_oidc", browser, 600, origin);
    return oidc.buildAuthorizationUrl(config, { response_type: "code", scope: "openid email profile", redirect_uri: redirectUri,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256", state, nonce }).href;
}

export async function finishOidc(c: Context): Promise<string> {
    const state = c.req.query("state");
    const browser = cookieToken(c.req.raw.headers, "specbook_oidc");
    if (!state || !/^[a-f0-9]{64}$/.test(state) || !browser) throw new Error("The single sign-on request expired. Start again.");
    const pending = await accountsRepository.takeOidcState(tokenHash(state), tokenHash(browser));
    clearCookies(c, "specbook_oidc");
    if (!pending) throw new Error("The single sign-on request expired. Start again.");
    const settings = await accountsRepository.getSso();
    if (!settings.enabled || settings.issuer !== pending.issuer || settings.clientId !== pending.clientId) throw new Error("Single sign-on settings changed. Start again.");
    const config = await configuration(settings);
    const url = new URL(pending.redirectUri);
    url.search = new URL(c.req.url).search;
    const tokens = await oidc.authorizationCodeGrant(config, url, { expectedState: state, expectedNonce: pending.nonce,
        pkceCodeVerifier: decryptSecret(pending.pkceVerifier), idTokenExpected: true });
    const claims = tokens.claims();
    if (!claims?.sub) throw new Error("The provider did not identify this account.");
    let profile: Record<string, unknown> = claims;
    if (!verifiedEmail(pending.issuer, profile) && config.serverMetadata().userinfo_endpoint) {
        profile = { ...claims, ...await oidc.fetchUserInfo(config, tokens.access_token, claims.sub) };
    }
    const email = verifiedEmail(pending.issuer, profile);
    if (!email || settings.allowedEmailDomains.length && !settings.allowedEmailDomains.includes(email.split("@")[1])) {
        throw new Error("A verified email from an allowed domain is required.");
    }
    const user = await withAccountsLock(async () => {
        const currentSettings = await accountsRepository.getSso();
        if (!currentSettings.enabled || currentSettings.issuer !== settings.issuer || currentSettings.clientId !== settings.clientId || currentSettings.clientSecret !== settings.clientSecret) {
            throw new Error("Single sign-on settings changed. Start again.");
        }
        if (currentSettings.allowedEmailDomains.length && !currentSettings.allowedEmailDomains.includes(email.split("@")[1])) {
            throw new Error("A verified email from an allowed domain is required.");
        }
        const verified = async (user: Awaited<ReturnType<typeof accountsRepository.createSsoUser>>) => {
            await accountsRepository.saveSso({ ...currentSettings, verifiedUsers: [...new Set([...(currentSettings.verifiedUsers ?? []), user.id])] });
            return user;
        };
        const known = await accountsRepository.identity(pending.issuer, claims.sub);
        if (pending.linkUserId) {
            const active = c.get("user");
            if (!active || active.id !== pending.linkUserId || active.email !== email || active.disabledAt || known && known.id !== active.id) {
                throw new Error("Sign in to the matching account before connecting single sign-on.");
            }
            if (!known) await accountsRepository.addIdentity(active.id, pending.issuer, claims.sub);
            return verified(active);
        }
        if (known) {
            if (known.disabledAt) throw new Error("This account is disabled.");
            return verified(known);
        }
        if (await accountsRepository.userByEmail(email)) throw new Error("Sign in to your existing account first, then connect single sign-on from your account menu.");
        const name = typeof profile.name === "string" ? profile.name.replace(/[\x00-\x1f<>]/g, "").trim().slice(0, 80) : email;
        return verified(await accountsRepository.createSsoUser(email, name || email, currentSettings.defaultRole, pending.issuer, claims.sub));
    });
    await startSession(c, user, new URL(pending.redirectUri).origin);
    await recordAudit(pending.linkUserId ? "auth.sso.linked" : "auth.sso.login", {}, undefined, { id: user.id, name: user.name, email: user.email, kind: "user" });
    return `${new URL(pending.redirectUri).origin}${pending.linkUserId && user.role === "admin" ? "/settings" : "/"}`;
}
