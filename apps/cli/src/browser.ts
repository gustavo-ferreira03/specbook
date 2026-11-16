import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { inspectElement, redactUrls } from "@specbook/runtime/browser";
import { createRunProxy } from "@specbook/runtime/network/proxy";
import {
  httpTarget,
  localNetworkPolicy,
} from "@specbook/runtime/network/targets";
import { chromium } from "playwright-core";
import type { Browser, Locator, Page } from "playwright-core";
import { z } from "zod";

import { ensureChromium } from "./browsers.js";
import { resolveSecret, scrub, secretOrigins } from "./credentials.js";
import { checkPageLocators } from "./locators.js";
import type { LocatorCheck } from "./locators.js";
import { requiredValue } from "./values";

const requestSchema = z
  .object({
    action: z.enum([
      "open",
      "snapshot",
      "click",
      "fill",
      "inspect",
      "close",
      "check",
    ]),
    baseUrl: z.string().max(4096).optional(),
    url: z.string().max(4096).optional(),
    ref: z.string().max(500).optional(),
    value: z.string().max(20_000).optional(),
    secret: z.string().max(300).optional(),
    source: z.string().max(200_000).optional(),
  })
  .strict();

export interface BrowseArgs {
  workspace: string;
  baseUrl: string;
  url?: string;
  ref?: string;
  value?: string;
  secret?: string;
  headed?: boolean;
}

const socketPath = async function socketPath(
  workspace: string
): Promise<string> {
  const root = await fs.realpath(workspace);
  const user = process.getuid?.() ?? os.userInfo().username;
  const key = createHash("sha256")
    .update(`${root}\0${process.env.SPECBOOK_HOME ?? ""}`)
    .digest("hex")
    .slice(0, 32);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\specbook-${user}-${key}`;
  }
  const directory = path.join(os.tmpdir(), `specbook-browser-${user}`);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.()
  ) {
    throw new Error("The browser socket directory is not owned by this user");
  }
  await fs.chmod(directory, 0o700);
  return path.join(directory, `${key}.sock`);
};

const send = async function send(
  socket: string,
  request: z.infer<typeof requestSchema>
): Promise<unknown> {
  // oxlint-disable-next-line promise/avoid-new -- Adapt the existing event or callback lifecycle to a promise, including its cancellation and cleanup.
  return await new Promise((resolve, reject) => {
    const connection = net.createConnection(socket);
    let response = "";
    connection.setTimeout(120_000, () =>
      connection.destroy(new Error("The browser command timed out"))
    );
    connection.once("connect", () =>
      connection.write(`${JSON.stringify(request)}\n`)
    );
    connection.on("data", (chunk) => {
      response += chunk.toString();
      if (response.length > 2_000_000) {
        connection.destroy(new Error("The browser response was too large"));
        return;
      }
      if (!response.includes("\n")) {
        return;
      }
      connection.end();
      try {
        const result = JSON.parse(
          response.slice(0, response.indexOf("\n"))
        ) as { ok: boolean; result?: unknown; error?: string };
        if (result.ok) {
          resolve(result.result);
        } else {
          reject(new Error(result.error ?? "The browser command failed"));
        }
      } catch (error) {
        reject(error);
      }
    });
    connection.once("error", reject);
    connection.once("end", () => {
      if (!response.includes("\n")) {
        reject(new Error("The browser session closed without a response"));
      }
    });
  });
};

const unavailable = function unavailable(error: unknown): boolean {
  return ["ENOENT", "ECONNREFUSED", "EPIPE"].includes(
    (error as NodeJS.ErrnoException)?.code ?? ""
  );
};

export const browse = async function browse(
  action: string,
  args: BrowseArgs
): Promise<unknown> {
  const socket = await socketPath(args.workspace);
  const request = requestSchema.parse({
    action,
    baseUrl: args.baseUrl,
    url: args.url,
    ref: args.ref,
    value: args.value,
    secret: args.secret,
  });
  try {
    return await send(socket, request);
  } catch (error) {
    if (!unavailable(error)) {
      throw error;
    }
    if (action === "close") {
      return { closed: true };
    }
    if (action !== "open") {
      throw new Error(
        "No exploration session is open. Run specbook browse open first.",
        { cause: error }
      );
    }
  }
  await localNetworkPolicy(args.baseUrl);
  await ensureChromium();
  if (process.platform !== "win32") {
    const info = await fs.lstat(socket).catch(() => null);
    if (info && (!info.isSocket() || info.uid !== process.getuid?.())) {
      throw new Error("Unsafe browser socket path");
    }
    if (info) {
      await fs.unlink(socket);
    }
  }
  const child = spawn(
    process.execPath,
    [
      ...process.execArgv,
      requiredValue(process.argv[1]),
      "--browse-daemon",
      args.workspace,
      args.baseUrl,
      ...(args.headed ? ["--headed"] : []),
    ],
    { detached: true, stdio: "ignore", cwd: process.cwd(), env: process.env }
  );
  let startupError: Error | undefined;
  child.once("error", (error) => {
    startupError = error;
  });
  child.unref();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (startupError) {
      throw startupError;
    }
    // oxlint-disable-next-line no-await-in-loop -- Keep dependent retries, browser actions, and state changes in their original order and bound concurrent resource use.
    await wait(100);
    try {
      // oxlint-disable-next-line no-await-in-loop -- Keep dependent retries, browser actions, and state changes in their original order and bound concurrent resource use.
      return await send(socket, request);
    } catch (error) {
      if (!unavailable(error)) {
        throw error;
      }
    }
  }
  throw new Error(
    "The browser session could not start. Check that the CLI installation is complete."
  );
};

export const checkLiveLocators = async function checkLiveLocators(
  workspace: string,
  source: string
): Promise<LocatorCheck[]> {
  try {
    return (await send(await socketPath(workspace), {
      action: "check",
      source,
    })) as LocatorCheck[];
  } catch (error) {
    if (unavailable(error)) {
      return [];
    }
    throw error;
  }
};

export const startBrowserDaemon = async function startBrowserDaemon(
  workspace: string,
  baseUrl: string,
  headed = false
): Promise<void> {
  const socket = await socketPath(workspace);
  const policy = await localNetworkPolicy(baseUrl);
  const { origin } = httpTarget(baseUrl);
  const secrets = new Set<string>();
  let browser: Browser | undefined;
  let page: Page | undefined;
  let proxy: Awaited<ReturnType<typeof createRunProxy>> | undefined;
  let refs = new Set<string>();
  let queue = Promise.resolve();
  let idle: ReturnType<typeof setTimeout>;
  let closing = false;
  let socketRemoved = false;
  const connections = new Set<net.Socket>();
  const safe = async (input: unknown): Promise<unknown> => {
    const value = redactUrls(input);
    if (Array.isArray(value)) {
      return Promise.all(value.map(safe));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        await Promise.all(
          Object.entries(value).map(async ([key, item]) => [
            key,
            await safe(item),
          ])
        )
      );
    }
    if (typeof value !== "string") {
      return value;
    }
    let text = value;
    for (const secret of secrets) {
      for (const spelling of new Set([
        secret,
        JSON.stringify(secret).slice(1, -1),
        encodeURIComponent(secret),
      ])) {
        if (spelling) {
          text = text.split(spelling).join("[redacted]");
        }
      }
    }
    return scrub(text);
  };
  const shutdown = async () => {
    if (closing) {
      return;
    }
    closing = true;
    clearTimeout(idle);
    await browser?.close().catch(() => {
      /* No action is needed until this callback is replaced or invoked by its owner. */
      /* The caller owns cancellation or reports the failure separately. */
    });
    await proxy?.close().catch(() => {
      /* No action is needed until this callback is replaced or invoked by its owner. */
      /* The caller owns cancellation or reports the failure separately. */
    });
    for (const connection of connections) {
      connection.destroy();
    }
    // oxlint-disable-next-line promise/avoid-new -- Adapt the existing event or callback lifecycle to a promise, including its cancellation and cleanup.
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    if (!socketRemoved && process.platform !== "win32") {
      await fs.unlink(socket).catch(() => {
        /* No action is needed until this callback is replaced or invoked by its owner. */
        /* The caller owns cancellation or reports the failure separately. */
      });
    }
  };
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      shutdown();
    }, 30 * 60_000);
    idle.unref();
  };
  const assertOrigin = () => {
    if (!page || page.isClosed()) {
      throw new Error(
        "The exploration browser is closed. Run specbook browse close, then browse open."
      );
    }
    if (new URL(page.url()).origin !== origin) {
      throw new Error(
        "Navigate to the workspace base URL before inspecting or interacting with this page"
      );
    }
    return page;
  };
  const reference = async (ref: string): Promise<Locator> => {
    const clean = ref.replace(/^aria-ref=/u, "");
    if (!/^(?:f\d+)?e\d+$/u.test(clean) || !refs.has(clean)) {
      throw new Error(
        "The element ref is stale or missing. Take a fresh browser snapshot."
      );
    }
    const current = assertOrigin();
    const matches: Locator[] = [];
    for (const frame of current.frames()) {
      const locator = frame.locator(`aria-ref=${clean}`);
      // oxlint-disable-next-line no-await-in-loop -- Keep dependent retries, browser actions, and state changes in their original order and bound concurrent resource use.
      if ((await locator.count().catch(() => 0)) === 1) {
        matches.push(locator);
      }
    }
    if (matches.length !== 1) {
      throw new Error(
        "The element ref is stale or ambiguous. Take a fresh browser snapshot."
      );
    }
    return requiredValue(matches[0]);
  };
  const snapshot = async () => {
    const current = assertOrigin();
    let tree = await current
      .locator("body")
      .ariaSnapshot({ mode: "ai", timeout: 10_000 });
    refs = new Set(
      [...tree.matchAll(/\[ref=(?<segment1>(?:f\d+)?e\d+)\]/gu)].map((match) =>
        requiredValue(match[1])
      )
    );
    for (const line of tree.split("\n")) {
      const ref = line.match(/\[ref=(?<segment1>(?:f\d+)?e\d+)\]/u)?.[1];
      if (!ref || !/\b(?<segment1>textbox|searchbox|combobox)\b/u.test(line)) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- Keep dependent retries, browser actions, and state changes in their original order and bound concurrent resource use.
      const target = await reference(ref).catch(() => null);
      // oxlint-disable-next-line no-await-in-loop -- Keep dependent retries, browser actions, and state changes in their original order and bound concurrent resource use.
      const secretField = await target
        ?.evaluate((element) =>
          Boolean(
            (element as unknown as { __specbookSecret?: boolean })
              .__specbookSecret
          )
        )
        .catch(() => false);
      if (secretField) {
        tree = tree.replace(
          line,
          line.replace(
            /(?<segment1>\[ref=[^\]]+\][^:]*)(?::.*)?$/u,
            "$1: [redacted]"
          )
        );
      }
    }
    const url = current.url();
    const title = await current.title();
    assertOrigin();
    return safe({
      url,
      title,
      snapshot: `### Page\n- Page URL: ${url}\n- Page Title: ${title}\n### Snapshot\n\`\`\`yaml\n${tree}\n\`\`\``,
    });
  };
  const ensureBrowser = async () => {
    if (page && !page.isClosed()) {
      return;
    }
    await browser?.close().catch(() => {
      /* No action is needed until this callback is replaced or invoked by its owner. */
      /* The caller owns cancellation or reports the failure separately. */
    });
    await proxy?.close().catch(() => {
      /* No action is needed until this callback is replaced or invoked by its owner. */
      /* The caller owns cancellation or reports the failure separately. */
    });
    await ensureChromium();
    proxy = await createRunProxy(policy.allowPrivate ? policy.origins : []);
    browser = await chromium.launch({
      headless: !headed,
      proxy: { server: proxy.server },
      args: [
        "--disable-dev-shm-usage",
        "--proxy-bypass-list=<-loopback>",
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ],
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    context.setDefaultTimeout(15_000);
    context.setDefaultNavigationTimeout(30_000);
    await context.route("**/*", async (route) => {
      if (route.request().isNavigationRequest()) {
        try {
          if (
            !policy.origins.includes(httpTarget(route.request().url()).origin)
          ) {
            await route.abort("blockedbyclient");
            return;
          }
        } catch {
          await route.abort("blockedbyclient");
          return;
        }
      }
      await route.continue();
    });
    page = await context.newPage();
    page.on("framenavigated", (frame) => {
      if (frame === page?.mainFrame()) {
        refs.clear();
      }
    });
    page.on("dialog", (dialog) => {
      dialog.dismiss().catch(() => {
        /* No action is needed until this callback is replaced or invoked by its owner. */
        /* Dialogs may close with the browser. */
      });
    });
    context.on("page", (other) => {
      if (other !== page) {
        other.close().catch(() => {
          /* No action is needed until this callback is replaced or invoked by its owner. */
          /* The caller owns cancellation or reports the failure separately. */
        });
      }
    });
  };
  // oxlint-disable-next-line complexity -- Keep the browser decision tree together so state transitions and error ordering remain explicit.
  const execute = async (
    request: z.infer<typeof requestSchema>
  ): Promise<unknown> => {
    touch();
    if (request.action === "close") {
      server.close();
      if (process.platform !== "win32") {
        await fs.unlink(socket).catch(() => {
          /* No action is needed until this callback is replaced or invoked by its owner. */
          /* The caller owns cancellation or reports the failure separately. */
        });
      }
      socketRemoved = true;
      return { closed: true };
    }
    if (request.baseUrl && httpTarget(request.baseUrl).origin !== origin) {
      throw new Error(
        "The workspace base URL changed. Close the exploration session before opening another."
      );
    }
    if (request.action === "open") {
      const destination = httpTarget(
        new URL(request.url ?? baseUrl, baseUrl).toString()
      );
      if (!policy.origins.includes(destination.origin)) {
        throw new Error("Navigation outside the workspace origin is blocked");
      }
      await ensureBrowser();
      refs.clear();
      await requiredValue(page).goto(destination.toString(), {
        waitUntil: "domcontentloaded",
      });
      return snapshot();
    }
    const current = assertOrigin();
    if (request.action === "snapshot") {
      return snapshot();
    }
    if (request.action === "check") {
      return safe(await checkPageLocators(current, request.source ?? ""));
    }
    if (!request.ref) {
      throw new Error(
        `${request.action} requires an element ref or inspection selector`
      );
    }
    if (request.action === "inspect") {
      const target = /^(?:aria-ref=)?(?:f\d+)?e\d+$/u.test(request.ref)
        ? await reference(request.ref)
        : current.locator(request.ref);
      if ((await target.count()) !== 1) {
        throw new Error(
          "Inspection needs one matching element. Use a unique selector or a fresh element ref."
        );
      }
      const inspected = await target.evaluate(inspectElement);
      assertOrigin();
      return safe({
        url: current.url(),
        target: request.ref,
        ...JSON.parse(inspected),
      });
    }
    const target = await reference(request.ref);
    const previousUrl = current.url();
    if (request.action === "click") {
      await target.click();
    } else if (request.action === "fill") {
      if (request.secret && request.value !== undefined) {
        throw new Error("Use either --secret or a value when filling a field");
      }
      if (!request.secret && request.value === undefined) {
        throw new Error("fill requires a value or --secret profile.field");
      }
      const allowedCredentialOrigins = request.secret
        ? await secretOrigins(request.secret, baseUrl)
        : undefined;
      if (
        allowedCredentialOrigins &&
        !allowedCredentialOrigins.includes(new URL(current.url()).origin)
      ) {
        throw new Error(
          "This credential profile does not allow the current page origin"
        );
      }
      const value = request.secret
        ? await resolveSecret(request.secret)
        : requiredValue(request.value);
      if (request.secret) {
        secrets.add(value);
        await target.evaluate((element) => {
          (
            element as unknown as { __specbookSecret: boolean }
          ).__specbookSecret = true;
        });
      }
      await target.fill(value);
    }
    if (new URL(current.url()).origin !== origin) {
      await current
        .goto(previousUrl, { waitUntil: "domcontentloaded" })
        .catch(() => {
          /* No action is needed until this callback is replaced or invoked by its owner. */
          /* The caller owns cancellation or reports the failure separately. */
        });
      throw new Error(
        "Navigation outside the workspace origin was blocked. The previous page was restored."
      );
    }
    return snapshot();
  };
  const server = net.createServer((connection) => {
    connections.add(connection);
    connection.on("close", () => connections.delete(connection));
    connection.on("error", () => {
      /* No action is needed until this callback is replaced or invoked by its owner. */
      /* The caller owns cancellation or reports the failure separately. */
    });
    connection.setTimeout(120_000, () => connection.destroy());
    let input = "";
    connection.on("data", (chunk) => {
      input += chunk.toString();
      if (input.length > 1_000_000) {
        connection.destroy();
        return;
      }
      if (!input.includes("\n")) {
        return;
      }
      connection.removeAllListeners("data");
      queue = queue
        // oxlint-disable-next-line promise/always-return -- This continuation performs a side effect; its fulfilled value is intentionally unused.
        .then(async () => {
          let action: string | undefined;
          try {
            const request = requestSchema.parse(
              JSON.parse(input.slice(0, input.indexOf("\n")))
            );
            ({ action } = request);
            const result = await execute(request);
            connection.end(`${JSON.stringify({ ok: true, result })}\n`);
          } catch (error) {
            const message = await safe(
              error instanceof Error ? error.message : String(error)
            );
            connection.end(
              `${JSON.stringify({ ok: false, error: message })}\n`
            );
          }
          if (action === "close") {
            connection.once("close", () => {
              shutdown();
            });
          }
        })
        .catch(() => {
          connection.destroy();
        });
    });
  });
  // oxlint-disable-next-line promise/avoid-new -- Adapt the existing event or callback lifecycle to a promise, including its cancellation and cleanup.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  if (process.platform !== "win32") {
    await fs.chmod(socket, 0o600);
  }
  touch();
  process.once("SIGTERM", () => {
    shutdown();
  });
  process.once("SIGINT", () => {
    shutdown();
  });
};
