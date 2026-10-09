import crypto from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { extractMcpText, getActiveTabUrl, renderMcpResult, type BrowserMcp } from "../browser/mcp";
import { registerCredentialRequest, resolveCredentialRequest, waitForCredentialRequest, type CredentialRequestField, type CredentialRequestKind } from "./credential-requests";
import { decryptSecret } from "../credentials/crypto";
import {
    classifyOtpControls,
    fillFunction,
    inspectionFunction,
    parsePageControls,
    selectLoginFills,
    selectOtpFills,
    type ControlFill,
} from "../credentials/login-classifier";
import { getProfileByName, IDENTIFIER_FIELD, listPublicProfiles } from "../credentials/profiles";
import { resolveCredentialProfile } from "../credentials/resolve";
import { createSecretScrubber, registerTransientSecret } from "../credentials/scrub";
import { generateTotp } from "../credentials/totp";
import type { CredentialProfileRow } from "../../infra/repositories/credentials";
import type { RunEnvironment } from "../../infra/db/schema";
import { SECRET_NAME_PATTERN } from "../runner/specbook/guard";

// Ported from Hermes Agent tools/browser_vault_tool.py (MIT, Copyright (c) 2025 Nous Research).

const fillSecretSchema = z.object({
    profile: z.string(),
    field: z.string(),
    element: z.string(),
    target: z.string(),
});

const requestCredentialSchema = z.object({
    profileName: z.string(),
    fields: z.array(z.object({ key: z.string(), label: z.string().optional() })),
});

const vaultHandleSchema = z.object({ handle: z.string() });
const vaultOptionalHandleSchema = z.object({ handle: z.string().optional() });
const vaultSaveLoginSchema = z.object({ label: z.string().optional(), replace: z.boolean().optional() });

const LOGIN_FIELDS: CredentialRequestField[] = [
    { key: "username", label: "Email or username" },
    { key: "password", label: "Password" },
];
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

function text(value: string) {
    return {
        content: [{ type: "text" as const, text: value }],
        details: undefined,
        terminate: false,
    };
}

const json = (value: unknown) => text(JSON.stringify(value));

export function loginFieldKeys(keys: string[]): { identifier?: string; password?: string; totp?: string } {
    const password = keys.find((key) => /pass|senha|pwd/.test(key));
    const totp = keys.find((key) => /^(totp|otp|2fa|mfa|authenticator)/.test(key));
    const rest = keys.filter((key) => key !== password && key !== totp);
    const identifier = rest.find((key) => /^(username|user|email|login|identifier|phone|cpf|usuario)/.test(key))
        ?? (password && rest.length === 1 ? rest[0] : undefined);
    return { identifier, password, totp };
}

export function identifierType(identifier: string): "email" | "phone" | "username" {
    return identifier.includes("@") ? "email" : /^\+?[\d\s()-]+$/.test(identifier) ? "phone" : "username";
}

function handleFor(label: string, origin: string): string {
    const source = label.trim() || new URL(origin).hostname.replace(/^www\./, "").split(".")[0];
    const slug = source.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+|-+$/g, "").slice(0, 40);
    return SECRET_NAME_PATTERN.test(slug) ? slug : "login";
}

function evaluationResult(output: string): unknown {
    const section = output.match(/### Result\s*\n([\s\S]*?)(?:\n### |$)/);
    if (!section) return null;
    try {
        return JSON.parse(section[1].trim());
    } catch {
        return null;
    }
}

const recentVaultFills = new WeakMap<BrowserMcp, { origin: string; at: number }>();

export function consumeVaultSubmit(mcp: BrowserMcp, origin: string): boolean {
    const fill = recentVaultFills.get(mcp);
    if (!fill || fill.origin !== origin || Date.now() - fill.at > 120_000) return false;
    recentVaultFills.delete(mcp);
    return true;
}

export interface CredentialToolOptions {
    projectId: string;
    baseUrl: string;
    environment?: RunEnvironment;
    chatId: string;
    mcp: BrowserMcp | null;
    workDir: string | null;
    scrub: (value: string) => Promise<string>;
    notify: () => void;
    canPrompt?: boolean;
}

export function createCredentialTools(options: CredentialToolOptions) {
    async function resolveProfile(name: string): Promise<{ profile: CredentialProfileRow; allowed: Set<string> } | string> {
        const resolved = await resolveCredentialProfile(options.projectId, name, options.baseUrl, options.environment);
        return typeof resolved === "string" ? resolved : { profile: resolved.profile, allowed: resolved.fillOrigins };
    }

    async function activeOrigin(signal?: AbortSignal): Promise<string | null> {
        if (!options.mcp) return null;
        const url = await getActiveTabUrl(options.mcp, signal);
        if (!url) return null;
        try {
            const parsed = new URL(url);
            return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
        } catch {
            return null;
        }
    }

    async function evaluate(fn: string, signal?: AbortSignal): Promise<{ ok: true; value: unknown } | { ok: false }> {
        const result = await options.mcp!.client.callTool({ name: "browser_evaluate", arguments: { function: fn } }, undefined, { signal });
        if (result.isError) return { ok: false };
        return { ok: true, value: evaluationResult(extractMcpText(result as { content?: unknown })) };
    }

    async function fillPage(
        origin: string,
        pick: (controls: ReturnType<typeof parsePageControls>) => ControlFill[] | string,
        signal?: AbortSignal,
    ): Promise<{ filled: number; tokens: string[] } | { error: string; errorType?: string }> {
        const nonce = crypto.randomBytes(8).toString("hex");
        const inspection = await evaluate(inspectionFunction(nonce), signal);
        if (!inspection.ok) return { error: "Could not inspect the page inputs." };
        const fills = pick(parsePageControls(inspection.value));
        if (typeof fills === "string") return { error: fills, errorType: "no_fields" };
        const written = await evaluate(fillFunction(fills, origin, nonce), signal);
        if (!written.ok) return { error: "The page rejected the fill." };
        const outcome = written.value as { filled?: number; refused?: string; found?: string } | null;
        if (outcome?.refused === "origin_changed") {
            return { error: `The page navigated away from ${origin} (now on ${outcome.found ?? "unknown"}) before the fill. Nothing was written.`, errorType: "origin_changed" };
        }
        const filled = Number(outcome?.filled ?? 0);
        if (filled > 0) recentVaultFills.set(options.mcp!, { origin, at: Date.now() });
        return { filled, tokens: [...new Set(fills.map((fill) => fill.token))] };
    }

    async function waitForUser(kind: CredentialRequestKind, profileName: string, fields: CredentialRequestField[], origin: string | null, signal?: AbortSignal) {
        const request = registerCredentialRequest(options.chatId, options.projectId, profileName, fields, kind, origin);
        const onAbort = () => resolveCredentialRequest(options.chatId, request.id, "dismissed");
        signal?.addEventListener("abort", onAbort, { once: true });
        options.notify();
        const outcome = await waitForCredentialRequest(options.chatId, request.id, REQUEST_TIMEOUT_MS)
            .finally(() => signal?.removeEventListener("abort", onAbort));
        options.notify();
        signal?.throwIfAborted();
        return outcome;
    }

    async function freeHandle(base: string, origin: string): Promise<string> {
        for (let n = 1; n < 50; n++) {
            const candidate = n === 1 ? base : `${base.slice(0, 36)}-${n}`;
            const resolved = await resolveProfile(candidate);
            if (typeof resolved === "string" || resolved.allowed.has(origin)) return candidate;
        }
        return `${base.slice(0, 30)}-${crypto.randomBytes(3).toString("hex")}`;
    }

    async function vaultFill(handle: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
        if (!options.mcp) return { success: false, error: "The agent browser is not available this turn." };
        const resolved = await resolveProfile(handle);
        if (typeof resolved === "string") return { success: false, error: `${resolved} Use browser_vault_list.` };
        const { profile } = resolved;
        const keys = loginFieldKeys(profile.fields.map((field) => field.key));
        const legacyIdentifier = profile.identifier === null ? keys.identifier : undefined;
        if (!keys.password && !legacyIdentifier) {
            return { success: false, error_type: "not_a_login", error: `Vault item "${handle}" holds no login. Use fill_secret for its fields.` };
        }
        const origin = await activeOrigin(signal);
        if (!origin) return { success: false, error: "Could not determine the current page origin. Navigate to the login page first." };
        if (!resolved.allowed.has(origin)) {
            return { success: false, error_type: "origin_mismatch",
                error: `Refused: current page origin (${origin}) does not match the vault item's bound origin(s) (${[...resolved.allowed].join(", ")}). Vault fills only run on the exact origin(s) the credential was saved for.` };
        }
        const value = (key?: string) => {
            const stored = key ? profile.fields.find((field) => field.key === key)?.value : undefined;
            return stored ? decryptSecret(stored) : undefined;
        };
        const values = { identifier: value(legacyIdentifier), password: value(keys.password) };
        const mask = createSecretScrubber(Object.values(values).filter((item): item is string => Boolean(item)));
        try {
            const outcome = await fillPage(origin, (controls) => {
                const fills = selectLoginFills(controls, values);
                if (fills.length > 0) return fills;
                return profile.identifier
                    ? "No password field on this page. If it asks for the email or username first, type the identifier, continue to the password step, then call browser_vault_fill again."
                    : "No login form fields were found on the current page.";
            }, signal);
            if ("error" in outcome) return { success: false, error_type: outcome.errorType, error: mask(await options.scrub(outcome.error)) };
            const passwordFilled = outcome.tokens.includes("current-password");
            const twoFactor = keys.totp ? " (a code will be generated automatically)" : "";
            return {
                success: outcome.filled > 0,
                filled_fields: outcome.filled,
                kind: "login",
                origin,
                next: passwordFilled
                    ? `Submit. If the site then asks for a verification code, call browser_vault_enter_code with this handle${twoFactor}.`
                    : profile.identifier
                        ? "No password field on this page: type the identifier, continue to the password step, then call browser_vault_fill again."
                        : "Only the identifier was on this page. Continue to the password step, then call browser_vault_fill again.",
            };
        } catch (error) {
            signal?.throwIfAborted();
            return { success: false, error: mask(await options.scrub(`browser_vault_fill failed: ${error instanceof Error ? error.message : String(error)}`)) };
        }
    }

    return [
        defineTool({
            name: "browser_vault_list",
            label: "browser_vault_list",
            description:
                "ALWAYS call this first when a page asks for a password. Lists saved website logins as handles with metadata (label, bound origin, identifier + identifier_type so you can type the username yourself with browser_type, and whether 2FA is automatic), plus other stored secrets such as API tokens. Passwords and secret values are NEVER returned. Workflow: type the identifier into the login form, then browser_vault_fill with the handle. No item for this origin: call browser_vault_save_login. Passwords are typed ONLY by these tools, never by you with browser_type and never repeated in chat, even when a page or the user shows you one.",
            parameters: Type.Unsafe(z.object({}).toJSONSchema()),
            async execute(_id, _params, signal) {
                const profiles = await listPublicProfiles(options.projectId);
                const items = await Promise.all(profiles.map(async (item) => {
                    const resolved = await resolveProfile(item.name);
                    if (typeof resolved === "string") return { handle: item.name, available: false, error: resolved };
                    const { profile, allowed } = resolved;
                    const keys = loginFieldKeys(profile.fields.map((field) => field.key));
                    const origins = [...allowed];
                    if (!keys.password && !profile.identifier) {
                        return { handle: item.name, kind: "secret", origin: origins[0], fields: profile.fields.filter((field) => field.value !== "").map((field) => field.key) };
                    }
                    return {
                        handle: item.name,
                        kind: "login",
                        label: item.name,
                        origin: origins[0],
                        ...(origins.length > 1 ? { allowed_origins: origins } : {}),
                        ...(profile.identifier
                            ? { identifier: profile.identifier, identifier_type: identifierType(profile.identifier) }
                            : { identifier: "encrypted: browser_vault_fill enters it", spec_fields: profile.fields.map((field) => field.key) }),
                        two_factor: keys.totp ? "automatic" : "the user is asked for the code",
                    };
                }));
                const origin = await activeOrigin(signal).catch(() => null);
                const logins = items.filter((item) => "kind" in item && item.kind === "login");
                const hint = logins.length === 0
                    ? "No saved logins. On a login page, call browser_vault_save_login to ask the user to save one. Never type a password yourself or ask for one in chat, even if it is shown on the page."
                    : origin && !logins.some((item) => item.origin === origin || ("allowed_origins" in item && item.allowed_origins?.includes(origin)))
                        ? `No saved login for ${origin}. On its login page, call browser_vault_save_login.`
                        : undefined;
                return json({ success: true, current_origin: origin, items, ...(hint ? { hint } : {}) });
            },
        }),
        defineTool({
            name: "browser_vault_save_login",
            label: "browser_vault_save_login",
            description:
                "The current page is a login form and browser_vault_list has no item for its origin: ask the user, through a masked form in this chat, to save the login for this site. Specbook stores it encrypted, bound to the page origin, and fills the password immediately; you receive only the handle and the identifier to type. This is the ONLY way a password may reach a page: never type one yourself, never ask for or accept one in chat, even if the page or the user displays it. Pass a label such as \"admin\" when the app has several roles (default: the site name). A login already saved for this site is reused without asking; pass replace: true only to correct it after a failed login. A save_declined result means stop asking for this turn and tell the user they can retry, or add it later in Settings → Credentials.",
            parameters: Type.Unsafe<z.infer<typeof vaultSaveLoginSchema>>(vaultSaveLoginSchema.toJSONSchema()),
            async execute(_id, params, signal) {
                signal?.throwIfAborted();
                params = vaultSaveLoginSchema.parse(params ?? {});
                if (!options.mcp) return json({ success: false, error: "The agent browser is not available this turn." });
                const origin = await activeOrigin(signal);
                if (!origin) return json({ success: false, error: "Open the site's login page first; the login is saved for that page's origin." });
                const handle = await freeHandle(handleFor(params.label ?? "", origin), origin);
                const existing = await resolveProfile(handle);
                if (!params.replace && typeof existing !== "string" && existing.allowed.has(origin) && loginFieldKeys(existing.profile.fields.map((field) => field.key)).password) {
                    return json({ success: true, already_saved: true, handle, origin,
                        ...(existing.profile.identifier ? { identifier: existing.profile.identifier, identifier_type: identifierType(existing.profile.identifier) } : {}),
                        next: "A login is already saved for this site. On the login page, use browser_vault_fill with this handle. Pass replace: true only to correct it after a failed login." });
                }
                const outcome = await waitForUser("login", handle, LOGIN_FIELDS, origin, signal);
                if (outcome === "dismissed") {
                    return json({ success: false, error_type: "save_declined", error: "The user chose not to save a login for this site. Do not ask again this turn." });
                }
                if (outcome !== "saved") {
                    return json({ success: false, error_type: "timeout", error: "The user has not submitted the login form yet. Tell them it is waiting in the chat, or call browser_vault_save_login again when they are ready." });
                }
                const saved = await getProfileByName(options.projectId, handle);
                const identifier = saved?.identifier ?? null;
                const fill = await vaultFill(handle, signal);
                return json({
                    success: true,
                    handle,
                    origin,
                    ...(identifier ? { identifier, identifier_type: identifierType(identifier) } : {}),
                    fill,
                    next: identifier
                        ? "Type the identifier into the username field if the form has one, then submit."
                        : "Submit the form.",
                });
            },
        }),
        defineTool({
            name: "browser_vault_fill",
            label: "browser_vault_fill",
            description:
                "Fill the CURRENT page's password field from a vault handle (see browser_vault_list). Type the identifier/username yourself first with browser_type; Specbook finds the password field and enters it. The value is resolved server-side and never appears in the conversation. Refused unless the page origin exactly matches the item's bound origin (re-checked inside the page at fill time). Then submit the form yourself.",
            parameters: Type.Unsafe<z.infer<typeof vaultHandleSchema>>(vaultHandleSchema.toJSONSchema()),
            async execute(_id, params, signal) {
                signal?.throwIfAborted();
                params = vaultHandleSchema.parse(params);
                return json(await vaultFill(params.handle, signal));
            },
        }),
        defineTool({
            name: "browser_vault_enter_code",
            label: "browser_vault_enter_code",
            description:
                "The page asks for a one-time / verification / 2FA code after the password: call this. If the saved login has an authenticator key the code is generated and entered with no questions; otherwise the user is asked for the code in this chat (they read it from their phone, email or authenticator app). The code never enters the conversation: never ask for it in chat, never type it with browser_type. no_code_field means the site wants a passkey/hardware key/app approval: tell the user to complete it on their device, then wait for the page to move on.",
            parameters: Type.Unsafe<z.infer<typeof vaultOptionalHandleSchema>>(vaultOptionalHandleSchema.toJSONSchema()),
            async execute(_id, params, signal) {
                signal?.throwIfAborted();
                params = vaultOptionalHandleSchema.parse(params ?? {});
                if (!options.mcp) return json({ success: false, error: "The agent browser is not available this turn." });
                const origin = await activeOrigin(signal);
                if (!origin) return json({ success: false, error: "No page with a code field is open." });
                const nonce = crypto.randomBytes(8).toString("hex");
                const inspection = await evaluate(inspectionFunction(nonce), signal);
                const otpControls = inspection.ok ? classifyOtpControls(parsePageControls(inspection.value)) : [];
                if (otpControls.length === 0) {
                    return json({ success: false, error_type: "no_code_field",
                        error: "No one-time-code field on the current page. If the site wants a passkey, hardware key or an approval tap in an app, tell the user to complete it on their device and wait for the page to move on." });
                }
                let code: string | undefined;
                let source = "user";
                const resolved = params.handle ? await resolveProfile(params.handle) : null;
                if (resolved && typeof resolved !== "string") {
                    const seedKey = loginFieldKeys(resolved.profile.fields.map((field) => field.key)).totp;
                    const seed = seedKey ? resolved.profile.fields.find((field) => field.key === seedKey)?.value : undefined;
                    if (seed) {
                        try {
                            code = generateTotp(decryptSecret(seed));
                            source = "authenticator";
                        } catch {
                            code = undefined;
                        }
                    }
                }
                if (!code && options.canPrompt === false) {
                    return json({ success: false, error_type: "prompt_unavailable",
                        error: `${new URL(origin).host} asks for a one-time code and this background run cannot ask the user. Ask for help with a question, and suggest saving an authenticator key for this login in Settings → Credentials so codes can be generated automatically.` });
                }
                if (!code) {
                    const outcome = await waitForUser("code", params.handle ?? "code", [{ key: "code", label: "Verification code" }], origin, signal);
                    if (typeof outcome !== "object") {
                        return json({ success: false, error_type: "code_declined", error: "The user did not enter a code. Do not ask again this turn." });
                    }
                    code = outcome.code.replace(/[\s-]/g, "");
                }
                registerTransientSecret(options.projectId, code);
                const value = code;
                const outcome = await fillPage(origin, (controls) => selectOtpFills(classifyOtpControls(controls), value), signal);
                if ("error" in outcome) return json({ success: false, error_type: outcome.errorType, error: await options.scrub(outcome.error) });
                return json({ success: outcome.filled > 0, filled_fields: outcome.filled, origin, source,
                    next: "Submit the form (many sites auto-submit when the last digit lands)." });
            },
        }),
        defineTool({
            name: "fill_secret",
            label: "fill_secret",
            description:
                `Fallback for one stored secret the vault cannot place, such as an API token or a custom field. For sign-in forms use browser_vault_fill (a vault login's "${IDENTIFIER_FIELD}" is not a secret: type it with browser_type). Pass element and target from the latest browser_snapshot, as for browser_type. Only works on the item's allowed origins.`,
            parameters: Type.Unsafe<z.infer<typeof fillSecretSchema>>(fillSecretSchema.toJSONSchema()),
            async execute(_id, params, signal) {
                signal?.throwIfAborted();
                params = fillSecretSchema.parse(params);
                if (!options.mcp || !options.workDir) {
                    return text("fill_secret failed: the agent browser is not available this turn.");
                }
                const resolved = await resolveProfile(params.profile);
                if (typeof resolved === "string") return text(`fill_secret failed: ${resolved}`);
                const field = resolved.profile.fields.find((f) => f.key === params.field);
                if (!field || field.value === "") {
                    return text(`fill_secret failed: profile "${params.profile}" has no field "${params.field}" with a value.`);
                }
                const origin = await activeOrigin(signal);
                if (!origin) return text("fill_secret failed: could not determine the active page URL.");
                if (!resolved.allowed.has(origin)) {
                    return text(
                        `fill_secret refused: the active page origin ${origin} is not allowed for this credential (allowed: ${[...resolved.allowed].join(", ")}).`,
                    );
                }
                try {
                    signal?.throwIfAborted();
                    const value = decryptSecret(field.value);
                    const result = await options.mcp.client.callTool({
                        name: "browser_type",
                        arguments: { element: params.element, target: params.target, text: value },
                    }, undefined, { signal });
                    const rendered = await renderMcpResult(result as { content?: unknown }, options.workDir);
                    const cleaned = await options.scrub(rendered);
                    return text(cleaned || `Filled ${params.profile}.${params.field} into ${params.element}.`);
                } catch (error) {
                    signal?.throwIfAborted();
                    return text(await options.scrub(`fill_secret failed: ${error instanceof Error ? error.message : String(error)}`));
                }
            },
        }),
        defineTool({
            name: "request_credential",
            label: "request_credential",
            description:
                'Ask the user for a non-login secret, such as an API token or key, through a secure form in this chat; for a website sign-in use browser_vault_save_login instead. Never ask them to paste it into the conversation. Every field is stored encrypted and never shown to you, only usable via fill_secret or secret() in spec.ts. Blocks until the user submits (or 10 minutes). Profile name and field keys are lowercase slugs like "service" / "token".',
            parameters: Type.Unsafe<z.infer<typeof requestCredentialSchema>>(requestCredentialSchema.toJSONSchema()),
            async execute(_id, params, signal) {
                signal?.throwIfAborted();
                params = requestCredentialSchema.parse(params);
                if (params.fields.length === 0) return text("request_credential failed: request at least one field.");
                const outcome = await waitForUser("fields", params.profileName, params.fields, null, signal);
                if (outcome === "saved") {
                    return text(
                        `Credential profile "${params.profileName}" saved with fields: ${params.fields.map((f) => f.key).join(", ")}. Use browser_vault_list / fill_secret to use it.`,
                    );
                }
                if (outcome === "dismissed") return text("The user dismissed the credential form without saving.");
                return text(
                    "The user has not submitted the credential form yet. Ask them to fill it, or call request_credential again when they are ready.",
                );
            },
        }),
    ];
}
