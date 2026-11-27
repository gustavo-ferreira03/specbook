import { CodedError } from "@specbook/runtime/errors";

import type { RunEnvironment } from "../../infra/db/schema";
import type { ProjectContextRevisionRow } from "../../infra/repositories/project-contexts";
import { getActiveTabUrl, readBrowserSnapshot } from "../browser/mcp";
import type { BrowserMcp, BrowserToolPolicy } from "../browser/mcp";
import { requireValue } from "../utils/require-value";
import { consumeVaultSubmit } from "./credential-tools";

const withinOrigins = function withinOrigins(
  url: string,
  origins: Set<string>
): boolean {
  try {
    const parsed = new URL(url);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      origins.has(parsed.origin)
    );
  } catch {
    return false;
  }
};

export const snapshotClickTarget = function snapshotClickTarget(
  snapshot: string,
  target: unknown
): string {
  const ref =
    typeof target === "string"
      ? /^(?:aria-ref=)?(?<capture1>[a-z]+\d+)$/u.exec(target)?.[1]
      : undefined;
  if (!ref) {
    throw new Error(
      "Click rejected: use an element reference from a fresh browser snapshot, not a selector or description."
    );
  }
  const lines = snapshot.split("\n");
  const matches = lines
    .map((line, index) => (line.includes(`[ref=${ref}]`) ? index : -1))
    .filter((index) => index >= 0);
  if (matches.length !== 1) {
    throw new Error(
      "Click rejected: the element reference is missing or ambiguous. Take a fresh browser snapshot."
    );
  }
  const index = requireValue(matches[0]);
  let indent = requireValue(lines[index]).search(/\S/u);
  const labels: string[] = [];
  for (let i = index; i >= 0; i -= 1) {
    const line = requireValue(lines[i]);
    const level = line.search(/\S/u);
    if (i !== index && (level < 0 || level >= indent)) {
      continue;
    }
    indent = level;
    const element =
      /^\s*-\s+(?<capture1>\w+)(?:\s+"(?<capture2>(?:\\.|[^"\\])*)")?/u.exec(
        line
      );
    if (
      !element ||
      (i !== index &&
        !/^(?<capture1>button|link|menuitem|checkbox|switch|radio|option|tab)$/u.test(
          requireValue(element[1])
        ))
    ) {
      continue;
    }
    if (element[2]) {
      let name: string;
      try {
        name = JSON.parse(`"${element[2]}"`);
      } catch {
        ({ 2: name } = element);
      }
      labels.push(`${element[1]} ${name}`);
    }
  }
  if (!labels.length) {
    throw new Error(
      "Click rejected: this element has no accessible name to verify. Ask the human how to proceed."
    );
  }
  return labels.join("; ");
};

export const chatNavigationOrigins = function chatNavigationOrigins(
  startUrl: string,
  environment: Pick<RunEnvironment, "executor" | "allowedOrigins"> | undefined,
  profiles: { allowedOrigins: string[] }[]
): string[] {
  if (environment?.executor === "tunnel") {
    return environment.allowedOrigins;
  }
  return [
    ...new Set([
      new URL(startUrl).origin,
      ...(environment?.allowedOrigins ?? []),
      ...profiles.flatMap((profile) => profile.allowedOrigins),
    ]),
  ];
};

export const createOriginBrowserPolicy = function createOriginBrowserPolicy(
  startUrl: string,
  mcp: BrowserMcp,
  allowedOrigins: string[] = [],
  scope = "project"
): BrowserToolPolicy {
  const { origin } = new URL(startUrl);
  const origins = new Set([origin, ...allowedOrigins]);
  return {
    beforeCall: async (name, args, signal) => {
      signal?.throwIfAborted();
      if (name === "browser_navigate") {
        let parsed: URL;
        try {
          parsed = new URL(String(args.url ?? ""));
        } catch {
          throw new Error(
            "Navigation rejected: the destination is not a valid URL."
          );
        }
        if (
          !["http:", "https:"].includes(parsed.protocol) ||
          parsed.username ||
          parsed.password
        ) {
          throw new Error(
            "Navigation rejected: only HTTP and HTTPS URLs without embedded credentials are allowed."
          );
        }
        if (!origins.has(parsed.origin)) {
          throw new Error(
            `Navigation rejected: ${parsed.origin} is outside the ${scope} origin policy. Add a trusted origin in project Credentials settings if access is required.`
          );
        }
        return;
      }
      const active = await getActiveTabUrl(mcp, signal);
      if (
        active === "about:blank" &&
        ["browser_snapshot", "browser_tabs"].includes(name)
      ) {
        return;
      }
      if (!active || !withinOrigins(active, origins)) {
        throw new Error(
          `Navigate to the ${scope} origin before inspecting or interacting with this page.`
        );
      }
    },
    afterCall: async (_name, _args, _result, signal) => {
      signal?.throwIfAborted();
      const active = await getActiveTabUrl(mcp, signal);
      if (
        active === "about:blank" ||
        (active && withinOrigins(active, origins))
      ) {
        return;
      }
      if (!active) {
        throw new CodedError(
          "infrastructure",
          "The browser could not confirm the current page address. Navigate to the application before continuing."
        );
      }
      await mcp.client
        .callTool({ name: "browser_navigate_back", arguments: {} }, undefined, {
          signal,
        })
        .catch(() => {
          /* No action is needed until this callback is replaced or invoked by its owner. */
        });
      const afterBack = await getActiveTabUrl(mcp, signal);
      if (!afterBack || !withinOrigins(afterBack, origins)) {
        await mcp.navigate(startUrl, signal).catch(() => {
          /* No action is needed until this callback is replaced or invoked by its owner. */
        });
      }
      signal?.throwIfAborted();
      throw new Error(
        `The page left the ${scope} origin policy. Its content was withheld; return to an allowed application address before continuing.`
      );
    },
  };
};

export const createDiscoveryBrowserPolicy =
  function createDiscoveryBrowserPolicy(
    revision: Pick<ProjectContextRevisionRow, "brief">,
    mcp: BrowserMcp,
    allowedOrigins: string[] = []
  ): BrowserToolPolicy {
    const policy = createOriginBrowserPolicy(
      revision.brief.startUrl,
      mcp,
      allowedOrigins,
      "discovery"
    );
    return {
      ...policy,
      allowedTools: DISCOVERY_BROWSER_TOOLS,
      beforeCall: async (toolName, args, signal) => {
        await policy.beforeCall?.(toolName, args, signal);
        if (toolName === "browser_tabs" && args.action === "new") {
          throw new Error("Opening new tabs is not allowed during discovery.");
        }
        if (toolName === "browser_type" && args.submit === true) {
          throw new Error(
            "Submitting a form needs a verified button and human authorization. Fill the field without submitting it."
          );
        }
        if (toolName === "browser_click") {
          const target = snapshotClickTarget(
            await readBrowserSnapshot(mcp, signal),
            args.target ?? args.ref
          );
          const match = target.match(DESTRUCTIVE_CLICK_PATTERN);
          const active = match ? await getActiveTabUrl(mcp, signal) : null;
          if (
            match &&
            active &&
            /^button\b/u.test(target) &&
            consumeVaultSubmit(mcp, new URL(active).origin)
          ) {
            return;
          }
          if (match) {
            throw new Error(
              `Click rejected: the actual ${target} may change application data ("${match[0]}"). Ask the human before proceeding.`
            );
          }
        }
      },
    };
  };

export const createAutonomousBrowserPolicy =
  function createAutonomousBrowserPolicy(
    startUrl: string,
    mcp: BrowserMcp,
    allowedOrigins: string[] = []
  ): BrowserToolPolicy {
    const policy = createDiscoveryBrowserPolicy(
      { brief: { startUrl } as ProjectContextRevisionRow["brief"] },
      mcp,
      allowedOrigins
    );
    const allowed = new Set([
      ...DISCOVERY_BROWSER_TOOLS,
      "browser_console_messages",
      "browser_network_requests",
      "browser_take_screenshot",
    ]);
    return {
      beforeCall: async (name, args, signal) => {
        if (!allowed.has(name)) {
          throw new Error(
            "This autonomous exploration was not requested by a user and cannot change application data, so this action is unavailable here and no answer or authorization changes that. Continue read-only and report what could not be checked."
          );
        }
        await policy.beforeCall?.(name, args, signal);
      },
      afterCall: policy.afterCall,
    };
  };

export const DISCOVERY_BROWSER_TOOLS: ReadonlySet<string> = new Set([
  "browser_navigate",
  "browser_navigate_back",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_hover",
  "browser_wait_for",
  "browser_tabs",
]);

export const DESTRUCTIVE_CLICK_PATTERN =
  /\b(?<capture1>add|create|delete|edit|remove|erase|destroy|save|confirm|pay|payment|purchase|buy|checkout|refund|unsubscribe|cancel|logout|log out|sign out|publish|submit|send|place order|adicionar|criar|editar|salvar|confirmar|excluir|apagar|remover|deletar|pagar|pagamento|comprar|estornar|reembolso|cancelar|sair|desconectar|encerrar|publicar|enviar|submeter|finalizar)\b/iu;

// A tunnel only reaches the origins its environment lists. Any other chat browser may also follow a
// sign-in to the origins trusted by the environment or bound to a saved credential, such as an identity provider.
