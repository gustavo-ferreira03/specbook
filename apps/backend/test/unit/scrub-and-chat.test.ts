import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { useTempStorage } from "../helpers/storage";

// scrub.ts reaches the DB through the credential profiles module.
useTempStorage();
const { createSecretScrubber } = await import("../../src/core/credentials/scrub");
const registry = await import("../../src/core/chat/chat-registry");

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
