import crypto from "node:crypto";
import {
    loginAnthropic,
    loginGitHubCopilot,
    loginOpenAICodexDeviceCode,
    type OAuthCredentials,
    type OAuthDeviceCodeInfo,
} from "@earendil-works/pi-ai/oauth";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { llmAuth, modelRegistry } from "../core/llm/runtime";
import { settingsRepository } from "../repositories/settings";

type OAuthProvider = "anthropic" | "openai-codex" | "github-copilot";
type OAuthStatus = "pending" | "done" | "error";

interface OAuthSession {
    provider: OAuthProvider;
    status: OAuthStatus;
    controller: AbortController;
    timeout: NodeJS.Timeout;
    url?: string;
    userCode?: string;
    verificationUri?: string;
    error?: string;
    manualInput?: string;
    resolveManualInput?: (input: string) => void;
}

interface ProviderInfo {
    id: string;
    name: string;
    configured: boolean;
    authMethods: ("oauth" | "api_key")[];
    models: { id: string; label: string }[];
}

const OAUTH_PROVIDERS = new Set<OAuthProvider>(["anthropic", "openai-codex", "github-copilot"]);
const OAUTH_ONLY_PROVIDERS = new Set<OAuthProvider>(["openai-codex", "github-copilot"]);
const OAUTH_SESSION_TTL_MS = 15 * 60 * 1000;
const OAUTH_RESULT_TTL_MS = 60 * 1000;
const oauthSessions = new Map<string, OAuthSession>();
const llmPatchSchema = z
    .object({
        provider: z.string().trim().optional(),
        model: z.string().trim().optional(),
    })
    .strict();
const apiKeySchema = z.object({ apiKey: z.string().trim().min(1) }).strict();
const oauthManualSchema = z.object({ sessionId: z.string().uuid(), input: z.string().trim().min(1) }).strict();

function providerIds(): Set<string> {
    return new Set([...modelRegistry.getAll().map((model) => model.provider), ...OAUTH_PROVIDERS]);
}

function requireProvider(provider: string): void {
    if (!providerIds().has(provider)) throw new HTTPException(400, { message: "Unknown LLM provider" });
}

function requireOAuthProvider(provider: string): OAuthProvider {
    if (!OAUTH_PROVIDERS.has(provider as OAuthProvider)) {
        throw new HTTPException(400, { message: "OAuth is not supported for this provider" });
    }
    return provider as OAuthProvider;
}

function removeOAuthSession(id: string, abort: boolean): void {
    const session = oauthSessions.get(id);
    if (!session) return;
    clearTimeout(session.timeout);
    oauthSessions.delete(id);
    if (abort) session.controller.abort();
}

function removeProviderOAuthSessions(provider: string): void {
    for (const [id, session] of oauthSessions) {
        if (session.provider === provider) removeOAuthSession(id, true);
    }
}

function createOAuthSession(provider: OAuthProvider): [string, OAuthSession] {
    removeProviderOAuthSessions(provider);
    const id = crypto.randomUUID();
    const controller = new AbortController();
    const timeout = setTimeout(() => removeOAuthSession(id, true), OAUTH_SESSION_TTL_MS);
    timeout.unref();
    const session: OAuthSession = {
        provider,
        status: "pending",
        controller,
        timeout,
    };
    oauthSessions.set(id, session);
    return [id, session];
}

function updateOAuthSession(id: string, update: Partial<OAuthSession>): void {
    const session = oauthSessions.get(id);
    if (!session) return;
    Object.assign(session, update);
}

function finishOAuthSession(id: string, status: "done" | "error", error?: string): void {
    const session = oauthSessions.get(id);
    if (!session) return;
    clearTimeout(session.timeout);
    session.controller.abort();
    session.status = status;
    session.error = error;
    session.timeout = setTimeout(() => removeOAuthSession(id, false), OAUTH_RESULT_TTL_MS);
    session.timeout.unref();
}

function saveOAuthCredentials(id: string, credentials: OAuthCredentials): void {
    const session = oauthSessions.get(id);
    if (!session) return;
    llmAuth.set(session.provider, { type: "oauth", ...credentials });
    modelRegistry.refresh();
    finishOAuthSession(id, "done");
}

function failOAuthSession(id: string): void {
    finishOAuthSession(id, "error", "Authentication failed. Please try again.");
}

function waitForManualInput(session: OAuthSession): Promise<string> {
    if (session.manualInput) {
        const input = session.manualInput;
        delete session.manualInput;
        return Promise.resolve(input);
    }
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(new Error("OAuth session expired"));
        if (session.controller.signal.aborted) {
            reject(new Error("OAuth session expired"));
            return;
        }
        session.resolveManualInput = (input) => {
            session.controller.signal.removeEventListener("abort", onAbort);
            delete session.resolveManualInput;
            resolve(input);
        };
        session.controller.signal.addEventListener("abort", onAbort, { once: true });
    });
}

function startOAuthLogin(id: string, session: OAuthSession): "browser" | "device_code" {
    if (session.provider === "anthropic") {
        void loginAnthropic({
            onAuth: ({ url }) => updateOAuthSession(id, { url }),
            onPrompt: async () => "",
            onManualCodeInput: () => waitForManualInput(session),
        })
            .then((credentials) => saveOAuthCredentials(id, credentials))
            .catch(() => failOAuthSession(id));
        return "browser";
    }

    if (session.provider === "openai-codex") {
        void loginOpenAICodexDeviceCode({
            onDeviceCode: ({ userCode, verificationUri }: OAuthDeviceCodeInfo) => {
                updateOAuthSession(id, { userCode, verificationUri });
            },
            signal: session.controller.signal,
        })
            .then((credentials) => saveOAuthCredentials(id, credentials))
            .catch(() => failOAuthSession(id));
        return "device_code";
    }

    void loginGitHubCopilot({
        onDeviceCode: ({ userCode, verificationUri }: OAuthDeviceCodeInfo) => {
            updateOAuthSession(id, { userCode, verificationUri });
        },
        onPrompt: async () => "",
        signal: session.controller.signal,
    })
        .then((credentials) => saveOAuthCredentials(id, credentials))
        .catch(() => failOAuthSession(id));
    return "device_code";
}

function listProviders(): ProviderInfo[] {
    const modelsByProvider = new Map<string, { id: string; label: string }[]>(
        [...OAUTH_PROVIDERS].map((provider) => [provider, []]),
    );
    for (const model of modelRegistry.getAll()) {
        const models = modelsByProvider.get(model.provider) ?? [];
        models.push({ id: model.id, label: model.name ?? model.id });
        modelsByProvider.set(model.provider, models);
    }
    return [...modelsByProvider.entries()]
        .map(([id, models]) => ({
            id,
            name: modelRegistry.getProviderDisplayName(id),
            configured: modelRegistry.getProviderAuthStatus(id).configured,
            authMethods: OAUTH_ONLY_PROVIDERS.has(id as OAuthProvider)
                ? (["oauth"] as ("oauth" | "api_key")[])
                : OAUTH_PROVIDERS.has(id as OAuthProvider)
                  ? (["oauth", "api_key"] as ("oauth" | "api_key")[])
                  : (["api_key"] as ("oauth" | "api_key")[]),
            models,
        }))
        .sort((left, right) => {
            if (left.configured !== right.configured) return left.configured ? -1 : 1;
            const leftOAuth = left.authMethods.includes("oauth");
            const rightOAuth = right.authMethods.includes("oauth");
            if (leftOAuth !== rightOAuth) return leftOAuth ? -1 : 1;
            return left.name.localeCompare(right.name);
        });
}

export function createSettingsRouter(): Hono {
    const router = new Hono();

    router.get("/settings/llm/status", async (c) => {
        const current = await settingsRepository.getLlmSettings();
        const model = current.provider && current.model ? modelRegistry.find(current.provider, current.model) : null;
        return c.json({
            ready: Boolean(model && modelRegistry.hasConfiguredAuth(model)),
            provider: current.provider,
            model: current.model,
        });
    });

    router.get("/settings/llm", async (c) => {
        return c.json({ providers: listProviders(), current: await settingsRepository.getLlmSettings() });
    });

    router.patch("/settings/llm", async (c) => {
        const body = llmPatchSchema.safeParse(await c.req.json().catch(() => null));
        if (!body.success) throw new HTTPException(400, { message: "Invalid LLM settings" });
        const current = await settingsRepository.getLlmSettings();
        const updated = { ...current, ...body.data };
        if (!updated.provider && !updated.model) {
            return c.json(await settingsRepository.updateLlmSettings(updated));
        }
        requireProvider(updated.provider);
        if (!modelRegistry.find(updated.provider, updated.model)) {
            throw new HTTPException(400, { message: "Unknown model for this provider" });
        }
        return c.json(await settingsRepository.updateLlmSettings(updated));
    });

    router.put("/settings/llm/providers/:provider", async (c) => {
        const provider = c.req.param("provider");
        requireProvider(provider);
        const body = apiKeySchema.safeParse(await c.req.json().catch(() => null));
        if (!body.success) throw new HTTPException(400, { message: "apiKey is required" });
        removeProviderOAuthSessions(provider);
        llmAuth.set(provider, { type: "api_key", key: body.data.apiKey });
        modelRegistry.refresh();
        return c.json({ ok: true });
    });

    router.delete("/settings/llm/providers/:provider", (c) => {
        const provider = c.req.param("provider");
        requireProvider(provider);
        removeProviderOAuthSessions(provider);
        llmAuth.remove(provider);
        modelRegistry.refresh();
        return c.json({ ok: true });
    });

    router.post("/settings/llm/providers/:provider/oauth/start", (c) => {
        const provider = requireOAuthProvider(c.req.param("provider"));
        requireProvider(provider);
        const [sessionId, session] = createOAuthSession(provider);
        const type = startOAuthLogin(sessionId, session);
        return c.json({ sessionId, type });
    });

    router.post("/settings/llm/providers/:provider/oauth/manual", async (c) => {
        const provider = requireOAuthProvider(c.req.param("provider"));
        if (provider !== "anthropic") throw new HTTPException(400, { message: "Manual input is not supported for this provider" });
        const body = oauthManualSchema.safeParse(await c.req.json().catch(() => null));
        if (!body.success) throw new HTTPException(400, { message: "A valid OAuth session and redirect URL or code are required" });
        const session = oauthSessions.get(body.data.sessionId);
        if (!session || session.provider !== provider || session.status !== "pending") {
            throw new HTTPException(404, { message: "OAuth session not found" });
        }
        if (session.resolveManualInput) session.resolveManualInput(body.data.input);
        else session.manualInput = body.data.input;
        return c.json({ ok: true });
    });

    router.get("/settings/llm/providers/:provider/oauth/poll", (c) => {
        const provider = requireOAuthProvider(c.req.param("provider"));
        const sessionId = c.req.query("sessionId");
        if (!sessionId) throw new HTTPException(400, { message: "Missing sessionId" });
        const session = oauthSessions.get(sessionId);
        if (!session || session.provider !== provider) {
            throw new HTTPException(404, { message: "OAuth session not found" });
        }
        const response = {
            status: session.status,
            ...(session.url ? { url: session.url } : {}),
            ...(session.userCode ? { userCode: session.userCode } : {}),
            ...(session.verificationUri ? { verificationUri: session.verificationUri } : {}),
            ...(session.error ? { error: session.error } : {}),
        };
        if (session.status !== "pending") removeOAuthSession(sessionId, false);
        return c.json(response);
    });

    return router;
}
