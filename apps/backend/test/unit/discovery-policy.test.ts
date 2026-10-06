import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BrowserMcp } from "../../src/core/browser/mcp";
import { createDiscoveryBrowserPolicy, createOriginBrowserPolicy, DISCOVERY_BROWSER_TOOLS, snapshotClickTarget } from "../../src/core/chat/discovery-policy";
import type { ProjectContextRevisionRow } from "../../src/infra/repositories/project-contexts";

const START_URL = "https://app.example.com/start";

function fakeMcp(urls: string[], snapshot = '- button "Products" [ref=e1]') {
    const calls: { name: string; arguments: unknown }[] = [];
    const navigations: string[] = [];
    let current = 0;
    const mcp = {
        client: {
            callTool: async (request: { name: string; arguments: unknown }) => {
                calls.push(request);
                if (request.name === "browser_navigate_back") current = Math.min(current + 1, urls.length - 1);
                const url = urls[current];
                return { content: [{ type: "text", text: request.name === "browser_snapshot" ? snapshot : `- Page URL: ${url}` }] };
            },
        },
        tools: [],
        ensureBrowser: async () => {},
        navigate: async (url: string) => {
            navigations.push(url);
        },
        close: async () => {},
    } as unknown as BrowserMcp;
    return { mcp, calls, navigations };
}

function policyFor(urls: string[] = [START_URL], snapshot?: string) {
    const revision = { brief: { goal: "", startUrl: START_URL, safetyNotes: [] } } as unknown as ProjectContextRevisionRow;
    const fake = fakeMcp(urls, snapshot);
    return { policy: createDiscoveryBrowserPolicy(revision, fake.mcp), ...fake };
}

describe("discovery browser policy", () => {
    test("exposes only read-mostly tools", () => {
        const { policy } = policyFor();
        assert.equal(policy.allowedTools, DISCOVERY_BROWSER_TOOLS);
        assert.ok(!DISCOVERY_BROWSER_TOOLS.has("browser_evaluate"));
        assert.ok(!DISCOVERY_BROWSER_TOOLS.has("browser_file_upload"));
    });

    test("navigation must stay on the discovery origin over HTTP(S)", async () => {
        const { policy } = policyFor();
        await policy.beforeCall!("browser_navigate", { url: "https://app.example.com/other?x=1" });
        await assert.rejects(policy.beforeCall!("browser_navigate", { url: "https://evil.example.com/" }), /outside the discovery origin/);
        await assert.rejects(policy.beforeCall!("browser_navigate", { url: "http://app.example.com/" }), /outside the discovery origin/);
        await assert.rejects(policy.beforeCall!("browser_navigate", { url: "https://app.example.com@evil.com/" }), /without embedded credentials/);
        await assert.rejects(policy.beforeCall!("browser_navigate", { url: "javascript:alert(1)" }), /only HTTP and HTTPS/);
        await assert.rejects(policy.beforeCall!("browser_navigate", { url: "not a url" }), /not a valid URL/);
    });

    test("new tabs are refused", async () => {
        const { policy } = policyFor();
        await assert.rejects(policy.beforeCall!("browser_tabs", { action: "new" }), /new tabs/);
        await policy.beforeCall!("browser_tabs", { action: "list" });
    });

    test("clicks use the actual snapshot target even when the model gives an innocent description", async () => {
        for (const name of ["Delete account", "Salvar alterações", "Excluir", "Log out", "Place order", "Finalizar compra"]) {
            const { policy } = policyFor([START_URL], `- button "${name}" [ref=e1]`);
            await assert.rejects(policy.beforeCall!("browser_click", { target: "aria-ref=e1", element: "Products menu" }), /actual button/, name);
        }
        for (const name of ["Products", "Ver detalhes do pedido", "Next page", "Dashboard"]) {
            const { policy } = policyFor([START_URL], `- link "${name}" [ref=e1]`);
            await policy.beforeCall!("browser_click", { ref: "e1", element: "Delete something" });
        }
        const { policy } = policyFor();
        await assert.rejects(policy.beforeCall!("browser_click", { target: "button", element: "Products" }), /reference/);
        await assert.rejects(policy.beforeCall!("browser_click", { ref: "e999" }), /missing or ambiguous/);
        await assert.rejects(policy.beforeCall!("browser_type", { submit: true, target: "aria-ref=e1", text: "value" }), /Submitting/);
    });

    test("snapshot references include interactive parents and decode escaped names", () => {
        assert.match(snapshotClickTarget('- button "Delete account" [ref=e1]\n  - img "Icon" [ref=e2]', "e2"), /Delete account/);
        assert.equal(snapshotClickTarget('- button "\\u0044elete" [ref=e1]', "e1"), "button Delete");
        assert.throws(() => snapshotClickTarget('- button [ref=e1]', "e1"), /no accessible name/);
        assert.throws(() => snapshotClickTarget('- button "First" [ref=e1]\n- button "Second" [ref=e1]', "e1"), /ambiguous/);
    });

    test("interactive chat keeps tools available but rejects inspecting another origin", async () => {
        const { mcp } = fakeMcp(["https://elsewhere.example/"]);
        const policy = createOriginBrowserPolicy(START_URL, mcp, ["https://login.example.com"]);
        assert.equal(policy.allowedTools, undefined);
        await policy.beforeCall!("browser_navigate", { url: "https://login.example.com/signin" });
        await assert.rejects(policy.beforeCall!("browser_snapshot", {}), /before inspecting/);
        await assert.rejects(policy.beforeCall!("browser_navigate", { url: "https://elsewhere.example/" }), /outside the project origin/);
    });

    test("after a call that left the origin, goes back and reports it", async () => {
        const { policy, calls } = policyFor(["https://evil.example.com/landing", START_URL]);
        await assert.rejects(policy.afterCall!("browser_click", {}, ""), /left the discovery origin/);
        assert.ok(calls.some((call) => call.name === "browser_navigate_back"));
    });

    test("navigates to the start URL when going back is not enough", async () => {
        const { policy, navigations } = policyFor(["https://evil.example.com/a", "https://evil.example.com/b"]);
        await assert.rejects(policy.afterCall!("browser_click", {}, ""), /left the discovery origin/);
        assert.deepEqual(navigations, [START_URL]);
    });

    test("staying on the origin passes", async () => {
        const { policy } = policyFor(["https://app.example.com/deep/page"]);
        await policy.afterCall!("browser_click", {}, "");
    });
});
