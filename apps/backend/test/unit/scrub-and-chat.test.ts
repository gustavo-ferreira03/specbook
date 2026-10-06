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
