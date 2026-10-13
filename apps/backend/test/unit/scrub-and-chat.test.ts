import { sanitizeTechnicalDetails } from "@specbook/runtime/sanitize";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BrowserMcp } from "../../src/core/browser/mcp";
import { useTempStorage } from "../helpers/storage";

useTempStorage();
const { createSecretScrubber } = await import("../../src/core/credentials/scrub");
const registry = await import("../../src/core/chat/chat-registry");
const { bridgeBrowserTools, getActiveTabUrl } = await import("../../src/core/browser/mcp");
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
        assert.deepEqual(await resolveSecretEnv(project.id, [ref], missing), { env: {}, missing: [ref], publicRefs: [] });
        assert.equal((await resolveSecretEnv(project.id, [ref])).env[ref], "production-password");
        assert.notEqual(production.id, staging.id);
    });

    test("vault fields and run masking follow sensitivity, including effective overrides", async () => {
        const { runMigrations } = await import("../../src/infra/db/migrate");
        const { projectsRepository } = await import("../../src/infra/repositories/projects");
        const { createProfile, getProfileByName, resolveSecretEnv, updateProfile } = await import("../../src/core/credentials/profiles");
        const { projectSecretScrubber } = await import("../../src/core/credentials/scrub");
        const { resolveSecretOriginPolicy } = await import("../../src/core/runner/secrets");
        await runMigrations();
        const project = await projectsRepository.createProject("Field sensitivity", "https://login.example.com");
        const fields = [
            { key: "username", value: "visible-login", sensitive: false },
            { key: "password", value: "hidden-password", sensitive: true },
            { key: "tenant", value: "visible-tenant", sensitive: false },
            { key: "token", value: "hidden-token", sensitive: true },
        ];
        const profile = await createProfile(project.id, { name: "account", allowedOrigins: [project.baseUrl], fields });
        const override = await createProfile(project.id, { name: "preview-account", fields: fields.map((field) => ({ ...field, value: `preview-${field.key}-value`, sensitive: field.key !== "password" })) });
        const refs = ["USERNAME", "PASSWORD", "TENANT", "TOKEN"].map((field) => `SPECBOOK_SECRET_ACCOUNT_${field}`);
        assert.deepEqual((await resolveSecretEnv(project.id, refs)).publicRefs, [refs[0], refs[2]]);
        assert.deepEqual((await resolveSecretOriginPolicy(project.id, refs)).publicRefs, [refs[0], refs[2]]);
        const environment = { id: "preview", name: "Preview", configuredBaseUrl: "https://preview.example.com", baseUrl: "https://preview.example.com", allowedOrigins: [], credentialOverrides: { account: override.id } };
        assert.deepEqual((await resolveSecretEnv(project.id, refs, environment.credentialOverrides)).publicRefs, [refs[1]]);
        assert.deepEqual((await resolveSecretOriginPolicy(project.id, refs, environment)).publicRefs, [refs[1]]);
        const written: string[] = [];
        const controls = [
            { index: 0, formIndex: 0, name: "username", label: "Username", autocomplete: "username", type: "text", maxLength: null },
            { index: 1, formIndex: 0, name: "password", label: "Password", autocomplete: "current-password", type: "password", maxLength: null },
        ];
        const mcp = { client: { async callTool(input: { name: string; arguments: { function?: string } }) {
            if (input.name === "browser_tabs") return { content: [{ type: "text", text: `- Page URL: ${project.baseUrl}` }] };
            const fn = input.arguments.function!;
            if (fn.includes("const fills =")) { written.push(fn); return { content: [{ type: "text", text: '### Result\n{"filled":1}' }] }; }
            return { content: [{ type: "text", text: `### Result\n${JSON.stringify(controls)}` }] };
        } } } as unknown as BrowserMcp;
        const tools = createCredentialTools({ projectId: project.id, chatId: "sensitivity", baseUrl: project.baseUrl, mcp, workDir: "/tmp", scrub: async (value) => (await projectSecretScrubber(project.id))(value), notify: () => {} });
        const list = tools.find((tool) => tool.name === "browser_vault_list")!;
        const result = await list.execute("list", {}, undefined, undefined, {} as never);
        const output = JSON.stringify(result);
        assert.match(output, /visible-login|visible-tenant/);
        assert.doesNotMatch(output, /hidden-password|hidden-token/);
        assert.equal(result.content[0].type, "text");
        const items = JSON.parse((result.content[0] as { text: string }).text).items;
        assert.deepEqual(items.find((item: { handle: string }) => item.handle === "account").login_fields,
            [{ key: "username", value: "visible-login", type: "username" }]);
        const fill = tools.find((tool) => tool.name === "browser_vault_fill")!;
        await fill.execute("fill", { handle: "account" }, undefined, undefined, {} as never);
        assert.match(written[0], /hidden-password/);
        assert.doesNotMatch(written[0], /visible-login/);
        await updateProfile((await getProfileByName(project.id, profile.name))!, { fields: fields.map((field) => ({ key: field.key, sensitive: true })) });
        assert.doesNotMatch(JSON.stringify(await list.execute("list", {}, undefined, undefined, {} as never)), /visible-login/);
        await fill.execute("fill", { handle: "account" }, undefined, undefined, {} as never);
        assert.match(written[1], /visible-login/);
        const scrub = await projectSecretScrubber(project.id);
        assert.doesNotMatch(scrub("hidden-password hidden-token"), /hidden-password|hidden-token/);
        await updateProfile((await getProfileByName(project.id, profile.name))!, {
            fields: fields.map((field) => ({ key: field.key, sensitive: field.key !== "password" })),
        });
        const publicPassword = await fill.execute("fill", { handle: "account" }, undefined, undefined, {} as never);
        assert.match(written[2], /visible-login/);
        assert.doesNotMatch(written[2], /hidden-password/);
        assert.match(JSON.stringify(publicPassword), /Submit/);
    });

    test("the secure login form saves a public login field and a sensitive password", async () => {
        const { runMigrations } = await import("../../src/infra/db/migrate");
        const { projectsRepository } = await import("../../src/infra/repositories/projects");
        const { createProfile, getProfileByName, publicProfile } = await import("../../src/core/credentials/profiles");
        const { registerCredentialRequest } = await import("../../src/core/chat/credential-requests");
        const { submitChatCredentials } = await import("../../src/core/chat/credential-submit");
        const { projectSecretScrubber } = await import("../../src/core/credentials/scrub");
        await runMigrations();
        const project = await projectsRepository.createProject("Secure login", "https://login.example.com");
        await createProfile(project.id, { name: "account", fields: [
            { key: "email", value: "old@example.com", sensitive: false },
            { key: "password", value: "old-password", sensitive: true },
            { key: "tenant", value: "public-tenant", sensitive: false },
        ] });
        const request = registerCredentialRequest("secure-login", project.id, "account", [
            { key: "username", sensitive: false }, { key: "password", sensitive: true },
        ], "login", project.baseUrl);
        await submitChatCredentials("secure-login", request.id, { action: "submit", values: { username: "new@example.com", password: "new-password" } });
        const saved = publicProfile((await getProfileByName(project.id, "account"))!);
        assert.deepEqual(saved.fields, [
            { key: "email", sensitive: false, value: "new@example.com" },
            { key: "password", sensitive: true, hasValue: true },
            { key: "tenant", sensitive: false, value: "public-tenant" },
        ]);
        const scrub = await projectSecretScrubber(project.id);
        assert.equal(scrub("new@example.com new-password public-tenant"), "new@example.com •••• public-tenant");
    });
});

describe("conversation failure messages", () => {
    test("provider and browser errors give a next step without exposing their raw response", async () => {
        const { providerFailure, oauthFailureMessage, browserFailureMessage, isInfrastructureFailure } = await import("../../src/core/jobs/presentation-errors");
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
        assert.match(oauthFailureMessage(new Error("Sign in with ChatGPT requires a device ID (UUID) for this installation")), /initialize sign-in/);
        assert.match(oauthFailureMessage(new Error("Port 1455 is in use")), /Finish or cancel it/);
        assert.match(oauthFailureMessage(new Error("OAuth state mismatch")), /new link/);
        assert.equal(oauthFailureMessage(new Error("Paste the full callback URL from the browser")), "Paste the complete address from the final sign-in page, then try again.");
        assert.match(oauthFailureMessage(new Error("OAuth session expired")), /Start sign-in again/);
        assert.doesNotMatch(oauthFailureMessage(new Error("OpenAI OAuth token request failed (401): sk-secret /home/server/private")), /sk-secret|\/home\/server|complete this response|global Settings/);
        const details = sanitizeTechnicalDetails("Expected https://example.com/app/profile but got /home/server/storage/run/spec.ts\n    at click (/data/specbook/src/core/runner/guard.ts:1)");
        assert.match(details, /https:\/\/example.com\/app\/profile/);
        assert.doesNotMatch(details, /\/home\/server|\/data\/specbook|at click/);
        for (const failure of [
            "The browser could not confirm the current page address. Navigate to the application before continuing.",
            "The saved standard-user session restored, but the browser could not confirm or inspect the application page address. Could you restore browser access?",
            "The browser could not inspect its open tabs: Browser is already in use for /tmp/profile",
            "browser tool failed: Error: async initializeServer: EROFS: read-only file system, open '/home/server/.cache/ms-playwright/b/browser@123'",
        ]) assert.equal(isInfrastructureFailure(failure), true, failure);
        for (const question of [
            "The saved session expired. Can you provide a valid account for the app?",
            "The app redirected to an external origin. Can you allow this origin for the project?",
            "The application rejected the password for the standard-user profile.",
        ]) assert.equal(isInfrastructureFailure(question), false, question);
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

    test("masks short values and ignores empty values", () => {
        assert.equal(scrub("abc abcd"), "•••• ••••d");
        assert.equal(createSecretScrubber([""])("unchanged"), "unchanged");
        const scrubShort = createSecretScrubber(["1"]);
        assert.equal(scrubShort("1"), "••••");
        assert.deepEqual(JSON.parse(scrubShort(JSON.stringify({ "1": "value1", timestamp: 123, nested: [{ value: "1", duration: 1000 }] }))), {
            "1": "value••••", timestamp: 123, nested: [{ value: "••••", duration: 1000 }],
        });
    });

    test("masks every occurrence", () => {
        assert.equal(createSecretScrubber(["hunter2"])("hunter2 e hunter2"), "•••• e ••••");
    });
});

describe("chat registry", () => {
    test("chat actions keep their place between messages after reload and follow only the active branch", async () => {
        const { projectsRepository } = await import("../../src/infra/repositories/projects");
        const { createChat, openSession, getChatView, branchSessionForTurn, flushSessionFile, TOOL_STEP_TYPE } = await import("../../src/core/chat/session-store");
        const { runMigrations } = await import("../../src/infra/db/migrate");
        await runMigrations();
        const project = await projectsRepository.createProject("Chat chronology", "https://example.com");
        const chat = await createChat(project.id);
        const manager = (await openSession(chat.id))!;
        manager.appendMessage({ role: "user", content: "Inspect the sign-in page.", timestamp: 2000 });
        const introduction = manager.appendMessage({ role: "assistant", content: [
            { type: "text", text: "I will open the sign-in page." },
            { type: "toolCall", id: "navigate", name: "browser_navigate", arguments: { url: "https://example.com" } },
            { type: "toolCall", id: "click", name: "browser_click", arguments: { ref: "secret-ref" } },
        ], timestamp: 1000 } as never);
        for (const [callId, toolName, startedAt] of [["navigate", "browser_navigate", 3000], ["click", "browser_click", 4000]] as const) {
            const step = { id: `${introduction}:${callId}`, toolName, afterMessageId: introduction, startedAt, endedAt: startedAt + 200 };
            manager.appendCustomEntry(TOOL_STEP_TYPE, { ...step, endedAt: null });
            manager.appendMessage({ role: "toolResult", toolCallId: callId, toolName, content: [{ type: "text", text: "Private tool output" }], isError: callId === "click", timestamp: startedAt + 300 });
            manager.appendCustomEntry(TOOL_STEP_TYPE, step);
        }
        const explanation = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "The button could not be clicked. I will inspect the page." }], timestamp: 500 } as never);
        const snapshot = manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "snapshot", name: "browser_snapshot", arguments: {} }], timestamp: 600 } as never);
        manager.appendMessage({ role: "toolResult", toolCallId: "snapshot", toolName: "browser_snapshot", content: [{ type: "text", text: "Private snapshot" }], isError: false, timestamp: 900 });
        manager.appendCustomMessageEntry("specbook-warning", "The page did not respond.", true);
        manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "The sign-in page needs attention." }], timestamp: 100 } as never);
        flushSessionFile(manager);

        const view = (await getChatView(chat.id))!;
        assert.deepEqual(view.messages.map((message) => message.content), [
            "Inspect the sign-in page.", "I will open the sign-in page.",
            "The button could not be clicked. I will inspect the page.",
            "The page did not respond.", "The sign-in page needs attention.",
        ]);
        assert.deepEqual(view.toolSteps, [
            { id: `${introduction}:navigate`, toolName: "browser_navigate", afterMessageId: introduction, startedAt: 3000, endedAt: 3200 },
            { id: `${introduction}:click`, toolName: "browser_click", afterMessageId: introduction, startedAt: 4000, endedAt: 4200 },
            { id: `${snapshot}:snapshot`, toolName: "browser_snapshot", afterMessageId: explanation, startedAt: 600, endedAt: 900 },
        ]);
        assert.doesNotMatch(JSON.stringify(view), /Private tool output|Private snapshot|secret-ref/);
        assert.deepEqual((await getChatView(chat.id))?.toolSteps, view.toolSteps);

        manager.appendMessage({ role: "user", content: "Now inspect the profile.", timestamp: 10_000 });
        const profile = manager.appendMessage({ role: "assistant", content: [
            { type: "text", text: "I will open the profile." },
            { type: "toolCall", id: "snapshot", name: "browser_navigate", arguments: {} },
        ], timestamp: 11_000 } as never);
        manager.appendCustomEntry(TOOL_STEP_TYPE, { id: `${profile}:snapshot`, toolName: "browser_navigate", afterMessageId: profile, startedAt: 12_000, endedAt: 12_200 });
        manager.appendMessage({ role: "toolResult", toolCallId: "snapshot", toolName: "browser_navigate", content: [{ type: "text", text: "Profile page" }], isError: false, timestamp: 12_200 });
        const final = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "The profile is ready." }], timestamp: 13_000 } as never);
        flushSessionFile(manager);
        const secondTurn = (await getChatView(chat.id))!;
        assert.equal(secondTurn.toolSteps.length, 4);
        assert.deepEqual(secondTurn.toolSteps.slice(0, 3), view.toolSteps, "a repeated provider tool call id must not change the earlier action");
        await branchSessionForTurn(chat.id, final);
        const retried = (await getChatView(chat.id))!;
        assert.deepEqual(retried.messages, view.messages, "retry preserves the earlier turn and removes the latest user message and response");
        assert.deepEqual(retried.toolSteps, view.toolSteps, "abandoned tool results and timing entries must not leak into the retried branch");
    });

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

describe("browser tool execution", () => {
    test("reads the current MCP tab and preserves browser runtime failures", async () => {
        let result: { content: { type: string; text: string }[]; isError?: boolean } = {
            content: [{ type: "text", text: "### Result\n- 0: [Other tab](https://other.example.com/)\n- 1: (current) [Swag Labs](https://www.saucedemo.com/)" }],
        };
        const mcp = { client: { async callTool() { return result; } } } as unknown as BrowserMcp;
        assert.equal(await getActiveTabUrl(mcp), "https://www.saucedemo.com/");
        result = { content: [{ type: "text", text: "### Page\n- Page URL: about:blank" }] };
        assert.equal(await getActiveTabUrl(mcp), "about:blank");
        result = { content: [{ type: "text", text: "### Result\nNo open tabs" }] };
        assert.equal(await getActiveTabUrl(mcp), null);
        result = { isError: true, content: [{ type: "text", text: "### Error\nError: EROFS: read-only file system, open '/home/server/.cache/ms-playwright/b/browser@123'" }] };
        await assert.rejects(() => getActiveTabUrl(mcp), /could not inspect its open tabs:.*EROFS/s);
        const unavailable = { client: { async callTool() { throw new Error("Request timed out"); } } } as unknown as BrowserMcp;
        await assert.rejects(() => getActiveTabUrl(unavailable), /could not inspect its open tabs: Request timed out/);
        const controller = new AbortController();
        const reason = new Error("User cancelled the conversation");
        const cancelled = { client: { async callTool() { controller.abort(reason); throw new Error("Transport closed"); } } } as unknown as BrowserMcp;
        await assert.rejects(() => getActiveTabUrl(cancelled, controller.signal), (error) => error === reason);
    });

    test("MCP and browser policy errors stay errors after sanitizing and cleanup", async () => {
        const rawError = "Error: EROFS: read-only file system, open '/home/server/.cache/ms-playwright/b/browser@123'; secret-value";
        let cleaned = false;
        let called = false;
        const mcp = {
            tools: [{ name: "browser_navigate", inputSchema: { type: "object", properties: {} } }],
            client: { async callTool() { called = true; return { isError: true, content: [{ type: "text", text: rawError }] }; } },
        } as unknown as BrowserMcp;
        const tool = bridgeBrowserTools(mcp, "/tmp", {
            afterCall: async () => { cleaned = true; throw new Error("The browser could not confirm the current page address."); },
            sanitizeResult: (value) => value.replaceAll("secret-value", "••••"),
        })[0]!;
        const result = await tool.execute("call", {}, undefined, undefined, {} as never);
        assert.equal((result as { isError?: boolean }).isError, true);
        assert.ok(called && cleaned);
        assert.match(JSON.stringify(result), /EROFS/);
        assert.match(JSON.stringify(result), /could not confirm the current page address/);
        assert.doesNotMatch(JSON.stringify(result), /secret-value/);
        called = false;
        const denied = bridgeBrowserTools(mcp, "/tmp", { beforeCall: async () => { throw new Error("Origin is not allowed"); } })[0]!;
        const deniedResult = await denied.execute("call", {}, undefined, undefined, {} as never);
        assert.equal((deniedResult as { isError?: boolean }).isError, true);
        assert.equal(called, false);
        const failed = await bridgeBrowserTools(mcp, "/tmp")[0]!.execute("call", {}, undefined, undefined, {} as never);
        assert.equal((failed as { isError?: boolean }).isError, true);
        assert.match(JSON.stringify(failed), /EROFS/);
    });

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

describe("typed orchestration data", () => {
    test("failure codes take precedence over localized prose", async () => {
        const { CodedError, errorCodeOf, providerErrorCode } = await import("@specbook/runtime/errors");
        const { isInfrastructureFailure, isCredentialFailure, runFailureKind } = await import("../../src/core/jobs/presentation-errors");
        assert.equal(isInfrastructureFailure("Password rejected", "provider_auth"), true);
        assert.equal(isInfrastructureFailure("No LLM model; Xvfb failed", "environment"), false);
        assert.equal(isCredentialFailure("The provider is unavailable", "credentials"), true);
        assert.equal(isCredentialFailure("Session expired", "infrastructure"), false);
        assert.equal(runFailureKind({ status: "failed", failReason: "session expired", errorCode: "assertion" }), "assertion");
        assert.equal(runFailureKind({ status: "failed", failReason: "ECONNREFUSED", errorCode: null }), "environment");
        assert.equal(errorCodeOf(new Error("Localized", { cause: new CodedError("credentials", "Localized") })), "credentials");
        assert.equal(errorCodeOf({ errorCode: "locator" }), "locator");
        assert.equal(providerErrorCode({ status: 401, message: "Localized" }), "provider_auth");
        assert.equal(providerErrorCode({ status: 429, message: "Localized" }), "provider_limit");
        assert.equal(providerErrorCode(new Error("The app password was rejected")), "provider_error");
    });

    test("Inbox accessors tolerate legacy rows and reject malformed decision data", async () => {
        const { payloadOf, specBatchOf, verificationOf } = await import("../../src/core/jobs/schemas");
        const legacy = { payload: { sourceChatId: "chat", specBatch: { candidates: [{ title: "Sign in", jobId: "job" }] }, verification: { status: "passed" }, custom: "kept" } };
        assert.equal(specBatchOf(legacy)?.candidates[0]?.title, "Sign in");
        assert.equal(specBatchOf(legacy)?.candidates[0]?.jobId, "job");
        assert.deepEqual(verificationOf(legacy)?.screenshots, []);
        assert.equal(payloadOf(legacy).custom, "kept");
        const params = { parentId: "parent", title: "Feature", description: "Description" };
        assert.equal(JSON.stringify(payloadOf({ payload: { params } }).params), JSON.stringify(params));
        const malformed = { payload: { sourceChatId: "chat", waitingFor: 42, requiresVerification: "true", verification: { status: "passed", sourceHash: 17 } } };
        assert.equal(payloadOf(malformed).sourceChatId, "chat");
        assert.equal(payloadOf(malformed).waitingFor, undefined);
        assert.equal(payloadOf(malformed).requiresVerification, true);
        assert.equal(verificationOf(malformed), undefined);
        assert.deepEqual(payloadOf({ payload: null }), {});
    });
});
