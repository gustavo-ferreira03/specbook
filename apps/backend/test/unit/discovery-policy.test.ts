import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BrowserMcp } from "../../src/core/browser/mcp";
import { createDiscoveryBrowserPolicy, DISCOVERY_BROWSER_TOOLS } from "../../src/core/chat/discovery-policy";
import type { ProjectContextRevisionRow } from "../../src/infra/repositories/project-contexts";

const START_URL = "https://app.example.com/start";

function fakeMcp(urls: string[]) {
    const calls: { name: string; arguments: unknown }[] = [];
    const navigations: string[] = [];
    let current = 0;
    const mcp = {
        client: {
            callTool: async (request: { name: string; arguments: unknown }) => {
                calls.push(request);
                if (request.name === "browser_navigate_back") current = Math.min(current + 1, urls.length - 1);
                const url = urls[current];
                return { content: [{ type: "text", text: `- Page URL: ${url}` }] };
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

function policyFor(urls: string[] = [START_URL]) {
    const revision = { brief: { goal: "", startUrl: START_URL, safetyNotes: [] } } as unknown as ProjectContextRevisionRow;
    const fake = fakeMcp(urls);
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
        await assert.rejects(policy.beforeCall!("browser_navigate", { url: "https://app.example.com@evil.com/" }), /outside/);
        await assert.rejects(policy.beforeCall!("browser_navigate", { url: "javascript:alert(1)" }), /only HTTP and HTTPS/);
        await assert.rejects(policy.beforeCall!("browser_navigate", { url: "not a url" }), /not a valid URL/);
    });

    test("new tabs are refused", async () => {
        const { policy } = policyFor();
        await assert.rejects(policy.beforeCall!("browser_tabs", { action: "new" }), /new tabs/);
        await policy.beforeCall!("browser_tabs", { action: "list" });
    });

    test("destructive-looking clicks are refused, in English and Portuguese", async () => {
        const { policy } = policyFor();
        for (const element of ["Delete account button", "Salvar alterações", "Excluir", "Log out link", "Place order", "Finalizar compra"]) {
            await assert.rejects(policy.beforeCall!("browser_click", { element }), /Click rejected/, element);
        }
        for (const element of ["Products menu", "Ver detalhes do pedido", "Next page", "Dashboard link"]) {
            await policy.beforeCall!("browser_click", { element });
        }
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
