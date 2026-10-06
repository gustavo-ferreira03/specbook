import { getActiveTabUrl, readBrowserSnapshot, type BrowserMcp, type BrowserToolPolicy } from "../browser/mcp";
import type { ProjectContextRevisionRow } from "../../infra/repositories/project-contexts";

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
    /\b(add|create|delete|edit|remove|erase|destroy|save|confirm|pay|payment|purchase|buy|checkout|refund|unsubscribe|cancel|logout|log out|sign out|publish|submit|send|place order|adicionar|criar|editar|salvar|confirmar|excluir|apagar|remover|deletar|pagar|pagamento|comprar|estornar|reembolso|cancelar|sair|desconectar|encerrar|publicar|enviar|submeter|finalizar)\b/i;

function withinOrigins(url: string, origins: Set<string>): boolean {
    try {
        const parsed = new URL(url);
        return ["http:", "https:"].includes(parsed.protocol) && origins.has(parsed.origin);
    } catch { return false; }
}

/** A description supplied by the model is never evidence of what a click will do. */
export function snapshotClickTarget(snapshot: string, target: unknown): string {
    const ref = typeof target === "string" ? /^(?:aria-ref=)?([a-z]+\d+)$/.exec(target)?.[1] : undefined;
    if (!ref) throw new Error("Click rejected: use an element reference from a fresh browser snapshot, not a selector or description.");
    const lines = snapshot.split("\n");
    const matches = lines.map((line, index) => line.includes(`[ref=${ref}]`) ? index : -1).filter((index) => index >= 0);
    if (matches.length !== 1) throw new Error("Click rejected: the element reference is missing or ambiguous. Take a fresh browser snapshot.");
    const index = matches[0]!;
    let indent = lines[index]!.search(/\S/);
    const labels: string[] = [];
    for (let i = index; i >= 0; i--) {
        const line = lines[i]!;
        const level = line.search(/\S/);
        if (i !== index && (level < 0 || level >= indent)) continue;
        indent = level;
        const element = /^\s*-\s+(\w+)(?:\s+"((?:\\.|[^"\\])*)")?/.exec(line);
        if (!element || (i !== index && !/^(button|link|menuitem|checkbox|switch|radio|option|tab)$/.test(element[1]!))) continue;
        if (element[2]) {
            let name: string;
            try { name = JSON.parse(`"${element[2]}"`); }
            catch { name = element[2]; }
            labels.push(`${element[1]} ${name}`);
        }
    }
    if (!labels.length) throw new Error("Click rejected: this element has no accessible name to verify. Ask the human how to proceed.");
    return labels.join("; ");
}

export function createOriginBrowserPolicy(startUrl: string, mcp: BrowserMcp, allowedOrigins: string[] = [], scope = "project"): BrowserToolPolicy {
    const origin = new URL(startUrl).origin;
    const origins = new Set([origin, ...allowedOrigins]);
    return {
        beforeCall: async (name, args, signal) => {
            signal?.throwIfAborted();
            if (name === "browser_navigate") {
                let parsed: URL;
                try { parsed = new URL(String(args.url ?? "")); }
                catch { throw new Error("Navigation rejected: the destination is not a valid URL."); }
                if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
                    throw new Error("Navigation rejected: only HTTP and HTTPS URLs without embedded credentials are allowed.");
                }
                if (!origins.has(parsed.origin)) throw new Error(`Navigation rejected: ${parsed.origin} is outside the ${scope} origin policy. Add a trusted origin in project Credentials settings if access is required.`);
                return;
            }
            const active = await getActiveTabUrl(mcp, signal);
            if (active === "about:blank" && ["browser_snapshot", "browser_tabs"].includes(name)) return;
            if (!active || !withinOrigins(active, origins)) throw new Error(`Navigate to the ${scope} origin before inspecting or interacting with this page.`);
        },
        afterCall: async (_name, _args, _result, signal) => {
            signal?.throwIfAborted();
            const active = await getActiveTabUrl(mcp, signal);
            if (active === "about:blank" || active && withinOrigins(active, origins)) return;
            if (!active) throw new Error("The browser could not confirm the current page address. Navigate to the application before continuing.");
            await mcp.client.callTool({ name: "browser_navigate_back", arguments: {} }, undefined, { signal }).catch(() => undefined);
            const afterBack = await getActiveTabUrl(mcp, signal);
            if (!afterBack || !withinOrigins(afterBack, origins)) await mcp.navigate(startUrl, signal).catch(() => undefined);
            signal?.throwIfAborted();
            throw new Error(`The page left the ${scope} origin policy. Its content was withheld; return to an allowed application address before continuing.`);
        },
    };
}

export function createDiscoveryBrowserPolicy(
    revision: Pick<ProjectContextRevisionRow, "brief">,
    mcp: BrowserMcp,
    allowedOrigins: string[] = [],
): BrowserToolPolicy {
    const policy = createOriginBrowserPolicy(revision.brief.startUrl, mcp, allowedOrigins, "discovery");
    return {
        ...policy,
        allowedTools: DISCOVERY_BROWSER_TOOLS,
        beforeCall: async (toolName, args, signal) => {
            await policy.beforeCall?.(toolName, args, signal);
            if (toolName === "browser_tabs" && args.action === "new") throw new Error("Opening new tabs is not allowed during discovery.");
            if (toolName === "browser_type" && args.submit === true) throw new Error("Submitting a form needs a verified button and human authorization. Fill the field without submitting it.");
            if (toolName === "browser_click") {
                const target = snapshotClickTarget(await readBrowserSnapshot(mcp, signal), args.target ?? args.ref);
                const match = target.match(DESTRUCTIVE_CLICK_PATTERN);
                if (match) throw new Error(`Click rejected: the actual ${target} may change application data ("${match[0]}"). Ask the human before proceeding.`);
            }
        },
    };
}

/** Keep the browser capabilities visible; enforce autonomous exploration policy at execution. */
export function createAutonomousBrowserPolicy(startUrl: string, mcp: BrowserMcp, allowedOrigins: string[] = []): BrowserToolPolicy {
    const policy = createDiscoveryBrowserPolicy({ brief: { startUrl } as ProjectContextRevisionRow["brief"] }, mcp, allowedOrigins);
    const allowed = new Set([...DISCOVERY_BROWSER_TOOLS, "browser_console_messages", "browser_network_requests", "browser_take_screenshot"]);
    return {
        beforeCall: async (name, args, signal) => {
            if (!allowed.has(name)) throw new Error("This browser action needs human authorization. Explain the blocker in the Inbox before proceeding.");
            await policy.beforeCall?.(name, args, signal);
        },
        afterCall: policy.afterCall,
    };
}
