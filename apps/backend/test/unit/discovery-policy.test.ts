import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { BrowserMcp } from "../../src/core/browser/mcp";
import {
  chatNavigationOrigins,
  createAutonomousBrowserPolicy,
  createDiscoveryBrowserPolicy,
  createOriginBrowserPolicy,
  DISCOVERY_BROWSER_TOOLS,
  snapshotClickTarget,
} from "../../src/core/chat/discovery-policy";
import { requireValue } from "../../src/core/utils/require-value";
import type { ProjectContextRevisionRow } from "../../src/infra/repositories/project-contexts";

const fakeMcp = function fakeMcp(
  urls: string[],
  snapshot = '- button "Products" [ref=e1]'
) {
  const calls: { name: string; arguments: unknown }[] = [];
  const navigations: string[] = [];
  let current = 0;
  const mcp = {
    client: {
      callTool: (request: { name: string; arguments: unknown }) => {
        try {
          calls.push(request);
          if (request.name === "browser_navigate_back") {
            current = Math.min(current + 1, urls.length - 1);
          }
          const url = urls[current];
          return Promise.resolve({
            content: [
              {
                type: "text",
                text:
                  request.name === "browser_snapshot"
                    ? snapshot
                    : `- Page URL: ${url}`,
              },
            ],
          });
        } catch (error) {
          return Promise.reject(error);
        }
      },
    },
    tools: [],
    ensureBrowser: () => {
      try {
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    },
    navigate: (url: string) => {
      try {
        navigations.push(url);

        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    },
    close: () => {
      try {
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    },
  } as unknown as BrowserMcp;
  return { mcp, calls, navigations };
};

const policyFor = function policyFor(
  urls: string[] = [START_URL],
  snapshot?: string
) {
  const revision = {
    brief: { goal: "", startUrl: START_URL, safetyNotes: [] },
  } as unknown as ProjectContextRevisionRow;
  const fake = fakeMcp(urls, snapshot);
  return { policy: createDiscoveryBrowserPolicy(revision, fake.mcp), ...fake };
};

const START_URL = "https://app.example.com/start";

describe("chat navigation origins", () => {
  const profiles = [
    { allowedOrigins: ["https://login.example.com"] },
    { allowedOrigins: [] },
  ];

  test("a server chat browser may reach the origins its environment trusts", () => {
    const environment = {
      executor: "server" as const,
      allowedOrigins: ["https://app.example.com", "https://sso.example.com"],
    };
    assert.deepEqual(chatNavigationOrigins(START_URL, environment, profiles), [
      "https://app.example.com",
      "https://sso.example.com",
      "https://login.example.com",
    ]);
    assert.deepEqual(chatNavigationOrigins(START_URL, undefined, []), [
      "https://app.example.com",
    ]);
  });

  test("a tunnel chat browser stays on the origins of its environment", () => {
    const environment = {
      executor: "tunnel" as const,
      allowedOrigins: ["https://internal.example.com"],
    };
    assert.deepEqual(chatNavigationOrigins(START_URL, environment, profiles), [
      "https://internal.example.com",
    ]);
  });
});

describe("discovery browser policy", () => {
  test("exposes only read-mostly tools", () => {
    const { policy } = policyFor();
    assert.equal(policy.allowedTools, DISCOVERY_BROWSER_TOOLS);
    assert.ok(!DISCOVERY_BROWSER_TOOLS.has("browser_evaluate"));
    assert.ok(!DISCOVERY_BROWSER_TOOLS.has("browser_file_upload"));
  });

  test("navigation must stay on the discovery origin over HTTP(S)", async () => {
    const { policy } = policyFor();
    await requireValue(policy.beforeCall)("browser_navigate", {
      url: "https://app.example.com/other?x=1",
    });
    await assert.rejects(
      requireValue(policy.beforeCall)("browser_navigate", {
        url: "https://evil.example.com/",
      }),
      /outside the discovery origin/u
    );
    await assert.rejects(
      requireValue(policy.beforeCall)("browser_navigate", {
        url: "http://app.example.com/",
      }),
      /outside the discovery origin/u
    );
    await assert.rejects(
      requireValue(policy.beforeCall)("browser_navigate", {
        url: "https://app.example.com@evil.com/",
      }),
      /without embedded credentials/u
    );
    await assert.rejects(
      requireValue(policy.beforeCall)("browser_navigate", {
        // oxlint-disable-next-line no-script-url -- Exercise rejection of a JavaScript URL without executing it.
        url: "javascript:alert(1)",
      }),
      /only HTTP and HTTPS/u
    );
    await assert.rejects(
      requireValue(policy.beforeCall)("browser_navigate", { url: "not a url" }),
      /not a valid URL/u
    );
  });

  test("new tabs are refused", async () => {
    const { policy } = policyFor();
    await assert.rejects(
      requireValue(policy.beforeCall)("browser_tabs", { action: "new" }),
      /new tabs/u
    );
    await requireValue(policy.beforeCall)("browser_tabs", { action: "list" });
  });

  test("clicks use the actual snapshot target even when the model gives an innocent description", async () => {
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (const name of [
      "Delete account",
      "Salvar alterações",
      "Excluir",
      "Log out",
      "Place order",
      "Finalizar compra",
    ]) {
      const { policy } = policyFor([START_URL], `- button "${name}" [ref=e1]`);
      await assert.rejects(
        requireValue(policy.beforeCall)("browser_click", {
          target: "aria-ref=e1",
          element: "Products menu",
        }),
        /actual button/u,
        name
      );
    }
    /* oxlint-enable no-await-in-loop */
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (const name of [
      "Products",
      "Ver detalhes do pedido",
      "Next page",
      "Dashboard",
    ]) {
      const { policy } = policyFor([START_URL], `- link "${name}" [ref=e1]`);
      await requireValue(policy.beforeCall)("browser_click", {
        ref: "e1",
        element: "Delete something",
      });
    }
    /* oxlint-enable no-await-in-loop */
    const { policy } = policyFor();
    await assert.rejects(
      requireValue(policy.beforeCall)("browser_click", {
        target: "button",
        element: "Products",
      }),
      /reference/u
    );
    await assert.rejects(
      requireValue(policy.beforeCall)("browser_click", { ref: "e999" }),
      /missing or ambiguous/u
    );
    await assert.rejects(
      requireValue(policy.beforeCall)("browser_type", {
        submit: true,
        target: "aria-ref=e1",
        text: "value",
      }),
      /Submitting/u
    );
  });

  test("snapshot references include interactive parents and decode escaped names", () => {
    assert.match(
      snapshotClickTarget(
        '- button "Delete account" [ref=e1]\n  - img "Icon" [ref=e2]',
        "e2"
      ),
      /Delete account/u
    );
    assert.equal(
      snapshotClickTarget('- button "\\u0044elete" [ref=e1]', "e1"),
      "button Delete"
    );
    assert.throws(
      () => snapshotClickTarget("- button [ref=e1]", "e1"),
      /no accessible name/u
    );
    assert.throws(
      () =>
        snapshotClickTarget(
          '- button "First" [ref=e1]\n- button "Second" [ref=e1]',
          "e1"
        ),
      /ambiguous/u
    );
  });

  test("interactive chat keeps tools available but rejects inspecting another origin", async () => {
    const { mcp } = fakeMcp(["https://elsewhere.example/"]);
    const policy = createOriginBrowserPolicy(START_URL, mcp, [
      "https://login.example.com",
    ]);
    assert.equal(policy.allowedTools, undefined);
    await requireValue(policy.beforeCall)("browser_navigate", {
      url: "https://login.example.com/signin",
    });
    await assert.rejects(
      requireValue(policy.beforeCall)("browser_snapshot", {}),
      /before inspecting/u
    );
    await assert.rejects(
      requireValue(policy.beforeCall)("browser_navigate", {
        url: "https://elsewhere.example/",
      }),
      /outside the project origin/u
    );
  });

  test("after a call that left the origin, goes back and reports it", async () => {
    const { policy, calls } = policyFor([
      "https://evil.example.com/landing",
      START_URL,
    ]);
    await assert.rejects(
      requireValue(policy.afterCall)("browser_click", {}, ""),
      /left the discovery origin/u
    );
    assert.ok(calls.some((call) => call.name === "browser_navigate_back"));
  });

  test("navigates to the start URL when going back is not enough", async () => {
    const { policy, navigations } = policyFor([
      "https://evil.example.com/a",
      "https://evil.example.com/b",
    ]);
    await assert.rejects(
      requireValue(policy.afterCall)("browser_click", {}, ""),
      /left the discovery origin/u
    );
    assert.deepEqual(navigations, [START_URL]);
  });

  test("staying on the origin passes", async () => {
    const { policy } = policyFor(["https://app.example.com/deep/page"]);
    await requireValue(policy.afterCall)("browser_click", {}, "");
  });
});

describe("autonomous exploration policy", () => {
  test("refuses changes without asking for an authorization that cannot help", async () => {
    const fake = fakeMcp([START_URL]);
    const policy = createAutonomousBrowserPolicy(START_URL, fake.mcp);
    await assert.rejects(
      async () => {
        await policy.beforeCall?.("browser_fill_form", {}, undefined);
      },
      (error: Error) =>
        /cannot change application data/u.test(error.message) &&
        !/authorization\. Explain|Inbox/u.test(error.message)
    );
  });
});
