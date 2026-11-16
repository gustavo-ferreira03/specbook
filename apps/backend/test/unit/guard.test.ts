import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";

import { runNodeCli, withRunSlot } from "@specbook/runtime/process";
import {
  createGuard,
  createSecret,
  isSafeRelativePath,
  isSecret,
  parseRuntime,
  unwrap,
} from "@specbook/runtime/specbook/guard";
import type {
  RawPage,
  ApiRequestEvidence,
  RawRequest,
} from "@specbook/runtime/specbook/guard";

import { requireValue } from "../../src/core/utils/require-value";
import { tempDir } from "../helpers/storage";

const fakePage = function fakePage(
  options: {
    url?: string;
    frameOfElement?: "main" | "child";
    activeIframe?: boolean;
  } = {}
) {
  const calls: Call[] = [];
  const marks: { target: string; kind: string; value: string }[] = [];
  const element = (target: string) => ({
    tagName: "INPUT",
    classList: {
      add: (value: string) => {
        marks.push({ target, kind: "class", value });
      },
    },
    setAttribute: (value: string) => {
      marks.push({ target, kind: "attribute", value });
    },
  });
  const mainFrame = { name: "main" };
  const childFrame = { name: "child" };
  let currentUrl = options.url ?? "https://app.example.com/shop/login";
  const locator = (description: string): Record<string, unknown> => {
    const record =
      (method: string) =>
      (...args: unknown[]) => {
        calls.push({ target: description, method, args });
        if (
          [
            "getByRole",
            "getByLabel",
            "getByText",
            "locator",
            "first",
            "last",
            "nth",
            "filter",
            "and",
            "or",
          ].includes(method)
        ) {
          return locator(`${description}.${method}`);
        }
        return Promise.resolve("raw-result");
      };
    return new Proxy(
      {},
      {
        get(_target, property: string) {
          if (property === "evaluate") {
            // oxlint-disable-next-line promise/prefer-await-to-callbacks -- This handler models the callback interface exercised by the test.
            return (callback: (node: unknown) => unknown) => {
              try {
                // oxlint-disable-next-line promise/prefer-await-to-callbacks -- This handler models the callback interface exercised by the test.
                return Promise.resolve(callback(element(description)));
              } catch (error) {
                return Promise.reject(error);
              }
            };
          }
          if (property === "elementHandle") {
            return () => {
              try {
                return Promise.resolve({
                  ownerFrame: () => {
                    try {
                      return Promise.resolve(
                        options.frameOfElement === "child"
                          ? childFrame
                          : mainFrame
                      );
                    } catch (error) {
                      return Promise.reject(error);
                    }
                  },
                  dispose: () => {
                    try {
                      return Promise.resolve(undefined);
                    } catch (error) {
                      return Promise.reject(error);
                    }
                  },
                });
              } catch (error) {
                return Promise.reject(error);
              }
            };
          }
          return record(property);
        },
      }
    );
  };
  const page: RawPage = {
    url: () => currentUrl,
    mainFrame: () => mainFrame,
    keyboard: {
      press: (...args: unknown[]) => {
        try {
          return Promise.resolve(
            calls.push({ target: "keyboard", method: "press", args })
          );
        } catch (error) {
          return Promise.reject(error);
        }
      },
      type: (...args: unknown[]) => {
        try {
          return Promise.resolve(
            calls.push({ target: "keyboard", method: "type", args })
          );
        } catch (error) {
          return Promise.reject(error);
        }
      },
    },
    mouse: Object.fromEntries(
      ["move", "down", "up", "click", "dblclick", "wheel"].map((method) => [
        method,
        (...args: unknown[]) => {
          try {
            return Promise.resolve(
              calls.push({ target: "mouse", method, args })
            );
          } catch (error) {
            return Promise.reject(error);
          }
        },
      ])
    ) as RawPage["mouse"],
    // oxlint-disable-next-line promise/prefer-await-to-callbacks -- This handler models the callback interface exercised by the test.
    evaluate: (callback: () => unknown) => {
      try {
        const document = Object.getOwnPropertyDescriptor(
          globalThis,
          "document"
        );
        Object.defineProperty(globalThis, "document", {
          configurable: true,
          value: {
            activeElement: options.activeIframe
              ? { tagName: "IFRAME" }
              : element("keyboard"),
          },
        });
        try {
          // oxlint-disable-next-line promise/prefer-await-to-callbacks -- This handler models the callback interface exercised by the test.
          return Promise.resolve(callback());
        } finally {
          if (document) {
            Object.defineProperty(globalThis, "document", document);
          } else {
            Reflect.deleteProperty(globalThis, "document");
          }
        }
      } catch (error) {
        return Promise.reject(error);
      }
    },
    goto: (...args: unknown[]) => {
      try {
        calls.push({ target: "page", method: "goto", args });
        currentUrl = String(args[0]);
        return Promise.resolve({ request: () => "raw-response" });
      } catch (error) {
        return Promise.reject(error);
      }
    },
    reload: (...args: unknown[]) => {
      try {
        return Promise.resolve(
          calls.push({ target: "page", method: "reload", args })
        );
      } catch (error) {
        return Promise.reject(error);
      }
    },
    getByRole: (...args: unknown[]) => {
      calls.push({ target: "page", method: "getByRole", args });
      return locator("role");
    },
    getByLabel: (...args: unknown[]) => {
      calls.push({ target: "page", method: "getByLabel", args });
      return locator("label");
    },
    locator: (...args: unknown[]) => {
      calls.push({ target: "page", method: "locator", args });
      return locator("css");
    },
    context: () => "raw-context",
  };
  return { page, calls, marks, setUrl: (url: string) => (currentUrl = url) };
};

const guarded = function guarded(
  options: Parameters<typeof fakePage>[0] = {},
  secretOverrides?: Record<string, string>
) {
  const fake = fakePage(options);
  const secrets = secretOverrides ?? {
    SPECBOOK_SECRET_ADMIN_PASSWORD: "hunter22",
  };
  const guard = createGuard({ runtime, readSecret: (name) => secrets[name] });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const page = guard.wrapPage(fake.page) as any;
  return { ...fake, wrapped: page };
};

const BASE = "https://app.example.com/shop/";
const runtime = {
  baseURL: BASE,
  secretOrigins: {
    defaultOrigins: ["https://app.example.com"],
    byRef: {
      SPECBOOK_SECRET_ADMIN_PASSWORD: [
        "https://app.example.com",
        "https://login.example.com",
      ],
    },
  },
};

interface Call {
  target: string;
  method: string;
  args: unknown[];
}

describe("specbook page proxy", () => {
  test("exposes only allowlisted methods on a frozen, prototype-less object", () => {
    const { wrapped, page } = guarded();
    assert.equal(Object.getPrototypeOf(wrapped), null);
    assert.ok(Object.isFrozen(wrapped));
    for (const name of [
      "evaluate",
      "context",
      "route",
      "request",
      "exposeFunction",
      "setContent",
      "mainFrame",
      "constructor",
      "__proto__",
    ]) {
      assert.equal(wrapped[name], undefined, name);
    }
    assert.throws(() => {
      wrapped.evaluate = () => 1;
    });
    assert.equal(unwrap(wrapped), page);
    assert.equal(unwrap({}), undefined);
  });

  test("goto appends the path to the base URL and never returns the Response", async () => {
    const { wrapped, calls } = guarded();
    assert.equal(
      await wrapped.goto("/login?next=%2F", { waitUntil: "load" }),
      undefined
    );
    assert.deepEqual(calls.at(-1), {
      target: "page",
      method: "goto",
      args: [
        "https://app.example.com/shop/login?next=%2F",
        { waitUntil: "load" },
      ],
    });
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (const target of [
      "https://evil.example/",
      "//evil.example/",
      "/\\evil.example",
      "login",
      "",
      1,
      "/a\u0000b",
    ]) {
      await assert.rejects(
        wrapped.goto(target),
        /takes a path starting with/u,
        String(target)
      );
    }
    /* oxlint-enable no-await-in-loop */
  });

  test("locators are wrapped too and actions return nothing", async () => {
    const { wrapped, calls } = guarded();
    const button = wrapped.getByRole("button", { name: "Save" }).first();
    assert.equal(Object.getPrototypeOf(button), null);
    assert.equal(button.evaluate, undefined);
    assert.equal(button.elementHandle, undefined);
    assert.equal(await button.click({ force: true }), undefined);
    assert.deepEqual(calls.at(-1), {
      target: "role.first",
      method: "click",
      args: [{ force: true }],
    });
    const filtered = wrapped
      .locator("li")
      .filter({ has: wrapped.getByLabel("x"), hasText: /a/u });
    assert.ok(filtered);
    const filterCall = calls.find((call) => call.method === "filter");
    assert.equal(
      typeof (requireValue(filterCall).args[0] as { has: unknown }).has,
      "object"
    );
    assert.notEqual(
      (requireValue(filterCall).args[0] as { has: unknown }).has,
      undefined
    );
    assert.throws(
      () => wrapped.locator("internal:control=enter-frame"),
      /internal:/u
    );
    assert.throws(
      () => wrapped.getByRole("button").and("css"),
      /takes a locator/u
    );
    assert.throws(
      () => wrapped.getByRole("button", { name: () => 1 }),
      /Only literal values/u
    );
    assert.throws(
      // oxlint-disable-next-line typescript/no-extraneous-class -- Use a class instance to verify rejection of non-plain locator options.
      () => wrapped.getByRole("button", new (class Options {})()),
      /plain object literals/u
    );
    assert.throws(
      () => wrapped.getByRole("button").filter({ has: wrapped }),
      /Only literal values|plain object/u
    );
  });

  test("fill types a secret only on an allowed origin, into the main frame", async () => {
    const allowed = guarded();
    await allowed.wrapped
      .getByLabel("Password")
      .fill(createSecret("admin", "password"));
    assert.deepEqual(allowed.calls.at(-1), {
      target: "label",
      method: "fill",
      args: ["hunter22", undefined],
    });
    assert.deepEqual(allowed.marks, [
      { target: "label", kind: "class", value: "__specbookSecret" },
      { target: "label", kind: "attribute", value: "data-specbook-secret" },
    ]);

    const otherAllowed = guarded({ url: "https://login.example.com/sso" });
    await otherAllowed.wrapped
      .getByLabel("Password")
      .fill(createSecret("admin", "password"));

    const evil = guarded({ url: "https://evil.example/login" });
    await assert.rejects(
      evil.wrapped
        .getByLabel("Password")
        .fill(createSecret("admin", "password")),
      /origin is not allowed/u
    );
    assert.ok(!evil.calls.some((call) => call.method === "fill"));

    const framed = guarded({ frameOfElement: "child" });
    await assert.rejects(
      framed.wrapped
        .getByLabel("Password")
        .fill(createSecret("admin", "password")),
      /outside the page's main frame/u
    );
    assert.ok(!framed.calls.some((call) => call.method === "fill"));

    const unknown = guarded({}, { SPECBOOK_SECRET_OTHER_PASSWORD: "x1x1x1" });
    await assert.rejects(
      unknown.wrapped
        .getByLabel("Password")
        .fill(createSecret("other", "password")),
      /origin is not allowed/u
    );
    const missing = guarded({}, {});
    await assert.rejects(
      missing.wrapped
        .getByLabel("Password")
        .fill(createSecret("admin", "password")),
      /not configured/u
    );
  });

  test("keyboard.type refuses a secret while focus is inside a frame", async () => {
    const plain = guarded();
    await plain.wrapped.keyboard.type(createSecret("admin", "password"));
    assert.deepEqual(plain.calls.at(-1), {
      target: "keyboard",
      method: "type",
      args: ["hunter22", undefined],
    });
    assert.deepEqual(plain.marks, [
      { target: "keyboard", kind: "class", value: "__specbookSecret" },
      { target: "keyboard", kind: "attribute", value: "data-specbook-secret" },
    ]);
    const framed = guarded({ activeIframe: true });
    await assert.rejects(
      framed.wrapped.keyboard.type(createSecret("admin", "password")),
      /main frame/u
    );
    await assert.rejects(
      plain.wrapped.keyboard.type({ toString: () => "x" }),
      /string literal or secret/u
    );
    assert.equal(Object.getPrototypeOf(plain.wrapped.keyboard), null);
    assert.equal(plain.wrapped.keyboard.down, undefined);
  });

  test("mouse takes literal numbers and plain options, and dragTo takes a wrapped locator", async () => {
    const { wrapped, calls } = guarded();
    const { mouse } = wrapped;
    assert.equal(Object.getPrototypeOf(mouse), null);
    assert.ok(Object.isFrozen(mouse));
    assert.equal(unwrap(mouse), undefined);
    await mouse.move(400, 300);
    await mouse.down();
    await mouse.move(600, 450, { steps: 10 });
    await mouse.up({ button: "left" });
    await mouse.click(1, 2, { clickCount: 2 });
    await mouse.dblclick(1, 2);
    assert.equal(await mouse.wheel(0, 120), undefined);
    assert.deepEqual(
      calls.filter((call) => call.target === "mouse"),
      [
        { target: "mouse", method: "move", args: [400, 300, undefined] },
        { target: "mouse", method: "down", args: [undefined] },
        { target: "mouse", method: "move", args: [600, 450, { steps: 10 }] },
        { target: "mouse", method: "up", args: [{ button: "left" }] },
        { target: "mouse", method: "click", args: [1, 2, { clickCount: 2 }] },
        { target: "mouse", method: "dblclick", args: [1, 2, undefined] },
        { target: "mouse", method: "wheel", args: [0, 120] },
      ]
    );
    await assert.rejects(mouse.move("1", 2), /literal numbers/u);
    await assert.rejects(mouse.click(1, Number.NaN), /literal numbers/u);
    await assert.rejects(mouse.wheel(0), /literal numbers/u);
    await assert.rejects(
      mouse.down({ button: () => 1 }),
      /Only literal values/u
    );
    assert.equal(mouse.drag, undefined);

    const target = wrapped.getByLabel("Done");
    await wrapped.locator("#card").dragTo(target, { steps: 5 });
    const drag = requireValue(calls.at(-1));
    assert.equal(drag.method, "dragTo");
    assert.equal(drag.args[0], unwrap(target));
    assert.deepEqual(drag.args[1], { steps: 5 });
    await assert.rejects(
      wrapped.locator("#card").dragTo("#done"),
      /takes a locator/u
    );
    await assert.rejects(
      wrapped.locator("#card").dragTo(wrapped),
      /takes a locator/u
    );
  });

  test("secret handles carry no value", () => {
    const token = createSecret("admin", "password");
    assert.ok(isSecret(token));
    assert.equal(String(token), "[secret admin.password]");
    assert.equal(
      JSON.stringify({ token }),
      '{"token":"[secret admin.password]"}'
    );
    assert.ok(!Object.values(token).includes("hunter22"));
    assert.throws(() => createSecret("Admin", "password"), /profile name/u);
    assert.throws(() => createSecret("admin", 1), /profile name/u);
  });

  test("paths and runtime configuration", () => {
    assert.ok(isSafeRelativePath("/"));
    assert.ok(isSafeRelativePath("/a/b?c#d"));
    assert.ok(!isSafeRelativePath("//x"));
    assert.ok(!isSafeRelativePath("/\\x"));
    assert.ok(!isSafeRelativePath("/a\\b"));
    assert.ok(!isSafeRelativePath("http://x/"));
    assert.throws(() => parseRuntime(undefined), /only run through Specbook/u);
    assert.equal(parseRuntime(JSON.stringify(runtime)).baseURL, BASE);
  });
});

describe("specbook API proxy", () => {
  test("checks every redirect before sending credentials and records bounded, redacted evidence", async () => {
    const calls: { url: string; options: Record<string, unknown> }[] = [];
    const evidence: ApiRequestEvidence[] = [];
    const raw: RawRequest = {
      fetch(url, options) {
        try {
          calls.push({ url, options });
          const redirect = url.endsWith("/redirect");
          return Promise.resolve({
            status: () => (redirect ? 307 : 200),
            headers: (): Record<string, string> =>
              redirect
                ? { location: "https://api.example.com/echo" }
                : {
                    "content-type": "application/json",
                    "set-cookie": "session=hunter22",
                  },
            body: () => {
              try {
                return Promise.resolve(
                  new TextEncoder().encode(
                    JSON.stringify({
                      token: "hunter22",
                      value: "x".repeat(10_000),
                    })
                  )
                );
              } catch (error) {
                return Promise.reject(error);
              }
            },
            json: () => {
              try {
                return Promise.resolve({ ok: true });
              } catch (error) {
                return Promise.reject(error);
              }
            },
            dispose: () => {
              try {
                return Promise.resolve();
              } catch (error) {
                return Promise.reject(error);
              }
            },
          });
        } catch (error) {
          return Promise.reject(error);
        }
      },
    };
    const guard = createGuard({
      runtime: {
        ...runtime,
        navigationOrigins: [
          "https://app.example.com",
          "https://api.example.com",
        ],
      },
      readSecret: () => "hunter22",
    });
    const request = guard.wrapRequest(
      raw,
      (item) => evidence.push(item)
      // oxlint-disable-next-line typescript/no-explicit-any -- Probe the runtime guard surface, including deliberately unsupported methods.
    ) as any;
    assert.equal(Object.getPrototypeOf(request), null);
    assert.equal(request.fetch, undefined);
    assert.equal(request.storageState, undefined);
    const response = await request.post("/echo", {
      headers: {
        Authorization: createSecret("admin", "password"),
        "x-name": "Specbook",
      },
      data: { token: createSecret("admin", "password") },
    });
    assert.equal(calls[0].url, "https://app.example.com/shop/echo");
    assert.equal(calls[0].options.maxRedirects, 0);
    assert.equal(calls[0].options.maxRetries, 0);
    assert.equal(response.status(), 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(response.body, undefined);
    assert.equal(response.dispose, undefined);
    assert.equal(response.constructor, undefined);
    assert.equal(unwrap(response, ["apiResponse"])?.constructor, Object);
    assert.equal(evidence[0].requestHeaders.Authorization, "••••");
    assert.equal(evidence[0].responseHeaders?.["set-cookie"], "••••");
    assert.ok(!JSON.stringify(evidence).includes("hunter22"));
    assert.equal(evidence[0].responseBody?.length, 4000);
    await assert.rejects(
      request.get("/redirect", {
        headers: { Authorization: createSecret("admin", "password") },
      }),
      /API origin is not allowed for this credential/u
    );
    assert.equal(
      calls.length,
      2,
      "credential-bearing redirect is rejected before a second fetch"
    );
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (const header of [
      "Host",
      "hOsT",
      ":authority",
      "Proxy-Authorization",
      "Proxy-Connection",
    ]) {
      await assert.rejects(
        request.get("/echo", { headers: { [header]: "other.example.com" } }),
        /routing headers/u
      );
    }
    /* oxlint-enable no-await-in-loop */
    assert.equal(
      calls.length,
      2,
      "routing headers cannot bypass the URL's origin policy"
    );
    await assert.rejects(
      request.get("https://evil.example.com/"),
      /origin is not allowed/u
    );
    await assert.rejects(
      request.get("/echo", { ignoreHTTPSErrors: true }),
      /not allowed/u
    );
    await assert.rejects(
      request.get("/echo", { timeout: 0 }),
      /between 1 and 30000/u
    );
    await request.get("/redirect");
    assert.equal(
      calls.at(-1)?.url,
      "https://api.example.com/echo",
      "plain redirects can reach another explicitly allowed API origin"
    );
  });
});

describe("function constructor hardening", () => {
  test("fn.constructor cannot compile code after the specbook module hardens the worker", () => {
    const guardUrl = import.meta.resolve("@specbook/runtime/specbook/guard");
    const script = `
            const { hardenFunctionConstructors } = await import(${JSON.stringify(guardUrl)});
            hardenFunctionConstructors();
            const attempts = [
                () => (0).constructor.constructor("return 1")(),
                () => [].map.constructor("return 1")(),
                () => (async () => {}).constructor("return 1"),
                () => (function* () {}).constructor("return 1"),
            ];
            const results = attempts.map((attempt) => { try { attempt(); return "ran"; } catch (error) { return error.message; } });
            console.log(JSON.stringify(results));
        `;
    const cwd = path.resolve(import.meta.dirname, "../..");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { cwd, encoding: "utf-8" }
    );
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split("\n");
    const outcomes = JSON.parse(requireValue(lines.at(-1))) as string[];
    assert.deepEqual(
      outcomes,
      Array.from(
        { length: 4 },
        () => "Code generation is not available to Specs"
      )
    );
  });
});

describe("run cancellation", () => {
  test(
    "cancels a queued run without occupying or losing a concurrency slot",
    { timeout: 5000 },
    async () => {
      const previous = process.env.SPECBOOK_MAX_CONCURRENT_RUNS;
      process.env.SPECBOOK_MAX_CONCURRENT_RUNS = "1";
      let release!: () => void;
      const held = withRunSlot(
        () =>
          // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
          new Promise<void>((resolve) => {
            release = resolve;
          })
      );
      try {
        const controller = new AbortController();
        let executed = false;
        const cancelled = withRunSlot(() => {
          try {
            executed = true;

            return Promise.resolve();
          } catch (error) {
            return Promise.reject(error);
          }
        }, controller.signal);
        const rejected = assert.rejects(cancelled, /cancelled/u);
        controller.abort(new Error("cancelled"));
        await rejected;
        assert.equal(executed, false);
        let nextStarted = false;
        const next = withRunSlot(() => {
          try {
            nextStarted = true;

            return Promise.resolve();
          } catch (error) {
            return Promise.reject(error);
          }
        });
        await Promise.resolve();
        assert.equal(nextStarted, false);
        release();
        await held;
        await next;
        assert.equal(nextStarted, true);
        assert.equal(
          await withRunSlot(() => {
            try {
              return Promise.resolve("released");
            } catch (error) {
              return Promise.reject(error);
            }
          }),
          "released"
        );
      } finally {
        release();
        await held;
        if (previous === undefined) {
          delete process.env.SPECBOOK_MAX_CONCURRENT_RUNS;
        } else {
          process.env.SPECBOOK_MAX_CONCURRENT_RUNS = previous;
        }
      }
    }
  );

  test(
    "aborting a running process stops it before its configured timeout",
    { timeout: 5000 },
    async () => {
      const directory = tempDir("specbook-abort-");
      const script = path.join(directory, "wait.mjs");
      await fs.writeFile(script, "setInterval(() => {}, 1000);\n");
      const controller = new AbortController();
      const running = runNodeCli(script, [], {
        cwd: directory,
        timeoutMs: 30_000,
        signal: controller.signal,
      });
      controller.abort();
      const result = await running;
      assert.equal(result.timedOut, false);
      assert.equal(result.code, null);
      await assert.rejects(
        () =>
          runNodeCli(script, [], {
            cwd: directory,
            timeoutMs: 30_000,
            signal: controller.signal,
          }),
        /aborted/u
      );
    }
  );
});
