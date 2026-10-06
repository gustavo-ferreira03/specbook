import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BrowserMcp } from "../../src/core/browser/mcp";
import { useTempStorage } from "../helpers/storage";

// scrub.ts reaches the DB through the credential profiles module.
useTempStorage();
const { createSecretScrubber } = await import("../../src/core/credentials/scrub");
const registry = await import("../../src/core/chat/chat-registry");
const { bridgeBrowserTools } = await import("../../src/core/browser/mcp");
const { createCredentialTools } = await import("../../src/core/chat/credential-tools");
const { getPendingCredentialRequest } = await import("../../src/core/chat/credential-requests");

describe("environment credential profiles", () => {
    test("requires explicit overrides before a staging browser or request can use Production credentials", async () => {
        const { runMigrations } = await import("../../src/infra/db/migrate");
        const { projectsRepository } = await import("../../src/infra/repositories/projects");
        const { createProfile, resolveSecretEnv } = await import("../../src/core/credentials/profiles");
        const { resolveSecretOriginPolicy } = await import("../../src/core/runner/secrets");
        const { createSessionTools } = await import("../../src/core/chat/session-tools");
        await runMigrations();
        const project = await projectsRepository.createProject("Credential policy", "https://production.example.com");
        const production = await createProfile(project.id, { name: "account", fields: [{ key: "password", value: "production-password" }] });
        const staging = await createProfile(project.id, { name: "staging-account", fields: [{ key: "password", value: "staging-password" }] });
        const environment = { id: "staging", name: "Staging", configuredBaseUrl: "https://staging.example.com", baseUrl: "https://staging.example.com", allowedOrigins: ["https://api.staging.example.com"], credentialOverrides: {} as Record<string, string> };
        let activeUrl = environment.baseUrl;
        const typed: string[] = [];
        const mcp = { client: { async callTool(input: { name: string; arguments: { text?: string } }) {
            if (input.name === "browser_tabs") return { content: [{ type: "text", text: `- Page URL: ${activeUrl}` }] };
            typed.push(input.arguments.text!);
            return { content: [{ type: "text", text: "Credential filled" }] };
        } } } as unknown as BrowserMcp;
        const options = { projectId: project.id, chatId: "policy", baseUrl: project.baseUrl, environment, mcp, workDir: "/tmp", scrub: async (value: string) => createSecretScrubber(["production-password", "staging-password"])(value), notify: () => {} };
        const fill = (input: typeof options) => createCredentialTools(input).find((tool) => tool.name === "fill_secret")!;
        const params = { profile: "account", field: "password", element: "Password", target: "e2" };
        const blocked = await fill(options).execute("call", params, undefined, undefined, {} as never);
        assert.match(JSON.stringify(blocked), /fill_secret refused/);
        assert.deepEqual(typed, []);
        const ref = "SPECBOOK_SECRET_ACCOUNT_PASSWORD";
        assert.deepEqual((await resolveSecretOriginPolicy(project.id, [ref], environment)).byRef[ref], ["https://production.example.com"]);
        const overridden = { ...environment, credentialOverrides: { account: staging.id } };
        await fill({ ...options, environment: overridden }).execute("call", params, undefined, undefined, {} as never);
        assert.deepEqual(typed, ["staging-password"]);
        assert.deepEqual((await resolveSecretEnv(project.id, [ref], overridden.credentialOverrides)).env, { [ref]: "staging-password" });
        assert.deepEqual((await resolveSecretOriginPolicy(project.id, [ref], overridden)).byRef[ref], ["https://staging.example.com"]);
        activeUrl = project.baseUrl;
        assert.match(JSON.stringify(await fill({ ...options, environment: overridden }).execute("call", params, undefined, undefined, {} as never)), /fill_secret refused/);
        assert.equal(typed.length, 1);
        const preview = { ...overridden, baseUrl: "https://preview.example.com", allowedOrigins: [...environment.allowedOrigins, "https://preview.example.com"] };
        activeUrl = preview.baseUrl;
        assert.match(JSON.stringify(await fill({ ...options, environment: preview }).execute("call", params, undefined, undefined, {} as never)), /fill_secret refused/);
        assert.equal(typed.length, 1, "a one-off preview origin does not gain credential access from a navigation allowlist");
        assert.deepEqual((await resolveSecretOriginPolicy(project.id, [ref], preview)).byRef[ref], ["https://staging.example.com"]);
        const session = createSessionTools({ projectId: project.id, baseUrl: environment.baseUrl, productionBaseUrl: project.baseUrl, environment, mcp, workDir: "/tmp" });
        assert.match(JSON.stringify(await session.find((tool) => tool.name === "resume_session")!.execute("call", { profile: "account" }, undefined, undefined, {} as never)), /resume_session refused/);
        assert.match(JSON.stringify(await session.find((tool) => tool.name === "save_session")!.execute("call", { profile: "account" }, undefined, undefined, {} as never)), /save_session refused/);
        assert.equal(typed.length, 1, "saved sessions must not cross into a different environment implicitly");
        const missing = { account: "deleted-profile" };
        assert.deepEqual(await resolveSecretEnv(project.id, [ref], missing), { env: {}, missing: [ref] });
        assert.equal((await resolveSecretEnv(project.id, [ref])).env[ref], "production-password");
        assert.notEqual(production.id, staging.id);
    });
});

describe("conversation failure messages", () => {
    test("provider and browser errors give a next step without exposing their raw response", async () => {
        const { providerFailure, browserFailureMessage, sanitizeTechnicalDetails, isInfrastructureFailure } = await import("../../src/core/jobs/presentation-errors");
        for (const [input, code] of [["429 quota exceeded", "provider_limit"], ["401 invalid API key sk-secret", "provider_auth"], ["model_not_found", "provider_model"], ["ETIMEDOUT /home/server/private", "provider_connection"]]) {
            const failure = providerFailure(input);
            assert.equal(failure.code, code);
            assert.ok(failure.nextStep);
            assert.equal(isInfrastructureFailure(failure.message), true);
            assert.doesNotMatch(JSON.stringify(failure), /sk-secret|\/home\/server/);
        }
        assert.match(browserFailureMessage(new Error("spawn Xvfb ENOENT")), /required program is missing/);
        assert.match(browserFailureMessage(new Error("Server is already active for display 118")), /display is already in use/);
        assert.match(browserFailureMessage(new Error("EACCES /var/private")), /denied permission/);
        assert.doesNotMatch(browserFailureMessage(new Error("Xvfb failed")), /retry automatically/);
        const details = sanitizeTechnicalDetails("Expected https://example.com/app/profile but got /home/server/storage/run/spec.ts\n    at click (/data/specbook/src/core/runner/guard.ts:1)");
        assert.match(details, /https:\/\/example.com\/app\/profile/);
        assert.doesNotMatch(details, /\/home\/server|\/data\/specbook|at click/);
    });

    test("a timed out turn aborts its work before releasing the conversation", async () => {
        const { withTurnTimeout, ChatTurnTimeoutError } = await import("../../src/core/chat/deadline");
        const id = "timed-out-chat";
        const controller = new AbortController();
        let stopped = false;
        assert.equal(registry.tryReserveChatTurn(id), true);
        try {
            await assert.rejects(withTurnTimeout(() => new Promise<void>((_resolve, reject) => {
                controller.signal.addEventListener("abort", () => { stopped = true; reject(controller.signal.reason); }, { once: true });
            }), async () => { controller.abort(); }, 5), ChatTurnTimeoutError);
            assert.equal(stopped, true);
        } finally { registry.releaseChatTurn(id); }
        assert.equal(registry.isChatBusy(id), false);
        assert.equal(await withTurnTimeout(async () => "finished", async () => { assert.fail("completed turns must not be aborted"); }, 50), "finished");
    });

    test("unexpected HTTP failures expose an error ID and keep details in server logs", async () => {
        const { Hono } = await import("hono");
        const { handleRequestError } = await import("../../src/infra/web/errors");
        const app = new Hono();
        app.onError(handleRequestError);
        app.get("/broken", () => { throw new Error("sqlite error at /home/server/storage/private.db"); });
        const response = await app.request("/broken");
        assert.equal(response.status, 500);
        const body = await response.json();
        assert.match(body.errorId, /^[a-f0-9-]{36}$/);
        assert.match(body.error, /Try again/);
        assert.doesNotMatch(JSON.stringify(body), /sqlite|private.db|\/home\/server/);
    });
});

describe("createSecretScrubber", () => {
    const secret = `p&ss<"w'rd>\\1`;
    const scrub = createSecretScrubber([secret, "abc"]);

    test("masks the plain value", () => {
        assert.equal(scrub(`senha=${secret}!`), "senha=••••!");
    });

    test("masks XML-escaped encodings (with and without quotes escaped)", () => {
        assert.equal(scrub(`<msg>p&amp;ss&lt;"w'rd&gt;\\1</msg>`), "<msg>••••</msg>");
        assert.equal(scrub(`value="p&amp;ss&lt;&quot;w&#x27;rd&gt;\\1"`), 'value="••••"');
    });

    test("masks the JSON-escaped and URL-encoded forms", () => {
        const json = JSON.stringify({ password: secret });
        assert.equal(json.includes(secret), false, "the JSON form differs from the raw value");
        assert.equal(scrub(json), '{"password":"••••"}');
        assert.equal(scrub(`?p=${encodeURIComponent(secret)}`), "?p=••••");
    });

    test("ignores values shorter than four characters", () => {
        assert.equal(scrub("abc abcd"), "abc abcd");
    });

    test("masks every occurrence", () => {
        assert.equal(createSecretScrubber(["hunter2"])("hunter2 e hunter2"), "•••• e ••••");
    });
});

describe("chat registry", () => {
    test("tryReserveChatTurn is exclusive until releaseChatTurn", () => {
        assert.equal(registry.tryReserveChatTurn("chat-1"), true);
        assert.equal(registry.isChatBusy("chat-1"), true);
        assert.equal(registry.tryReserveChatTurn("chat-1"), false);
        assert.equal(registry.tryReserveChatTurn("chat-2"), true, "other chats are independent");
        registry.releaseChatTurn("chat-1");
        assert.equal(registry.isChatBusy("chat-1"), false);
        assert.equal(registry.tryReserveChatTurn("chat-1"), true);
        registry.releaseChatTurn("chat-1");
        registry.releaseChatTurn("chat-2");
    });

    test("deletion and turns exclude each other", () => {
        assert.equal(registry.beginChatDeletion("chat-3"), true);
        assert.equal(registry.tryReserveChatTurn("chat-3"), false);
        registry.cancelChatDeletion("chat-3");
        assert.equal(registry.tryReserveChatTurn("chat-3"), true);
        assert.equal(registry.beginChatDeletion("chat-3"), false);
        registry.releaseChatTurn("chat-3");
    });

    test("releasing drops queued follow-ups and abort requests", async () => {
        assert.equal(registry.tryReserveChatTurn("chat-4"), true);
        await registry.queueChatFollowUp("chat-4", "e depois?");
        assert.deepEqual(registry.getChatQueueState("chat-4"), { steering: 0, followUp: 1 });
        await registry.abortChatTurn("chat-4");
        registry.releaseChatTurn("chat-4");
        assert.deepEqual(registry.takePendingFollowUps("chat-4"), []);
        assert.equal(registry.consumeAbortRequest("chat-4"), false);
        await assert.rejects(registry.queueChatFollowUp("chat-4", "x"), /not currently replying/);
    });
});

describe("browser tool cancellation", () => {
    test("aborts an in-flight MCP request and still runs policy cleanup", async () => {
        const controller = new AbortController();
        let markStarted!: () => void;
        const started = new Promise<void>((resolve) => { markStarted = resolve; });
        let cleaned = false;
        const mcp = {
            tools: [{ name: "browser_wait_for", inputSchema: { type: "object", properties: {} } }],
            client: {
                callTool: async (_params: unknown, _schema: unknown, options?: { signal?: AbortSignal }) => {
                    assert.equal(options?.signal, controller.signal);
                    return new Promise((_resolve, reject) => {
                        options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
                        markStarted();
                    });
                },
            },
        } as unknown as BrowserMcp;
        const tool = bridgeBrowserTools(mcp, "/tmp", {
            afterCall: async (_name, _args, _result, signal) => {
                assert.equal(signal?.aborted, true);
                cleaned = true;
            },
        })[0]!;
        const execution = tool.execute("call", {}, controller.signal, undefined, {} as never);
        const rejected = assert.rejects(execution, /Job budget exhausted/);
        await started;
        controller.abort(new Error("Job budget exhausted"));
        await rejected;
        assert.equal(cleaned, true);
    });

    test("does not start a browser action after cancellation", async () => {
        const mcp = {
            tools: [{ name: "browser_click", inputSchema: { type: "object", properties: {} } }],
            client: { callTool: async () => { assert.fail("Cancelled action reached the browser"); } },
        } as unknown as BrowserMcp;
        const tool = bridgeBrowserTools(mcp, "/tmp")[0]!;
        await assert.rejects(tool.execute("call", {}, AbortSignal.abort(new Error("Cancelled")), undefined, {} as never), /Cancelled/);
    });

    test("cancelling a credential request removes its form and ends the wait", async () => {
        const controller = new AbortController();
        const tool = createCredentialTools({ projectId: "project", chatId: "cancel-credential", baseUrl: "https://example.com", mcp: null, workDir: null, scrub: async (value) => value, notify: () => {} }).find((tool) => tool.name === "request_credential")!;
        const execution = tool.execute("call", { profileName: "admin", fields: [{ key: "password" }] }, controller.signal, undefined, {} as never);
        const rejected = assert.rejects(execution, /Cancelled/);
        assert.notEqual(getPendingCredentialRequest("cancel-credential"), null);
        controller.abort(new Error("Cancelled"));
        await rejected;
        assert.equal(getPendingCredentialRequest("cancel-credential"), null);
    });
});
