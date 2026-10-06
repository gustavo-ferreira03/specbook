import { getActiveTabUrl, type BrowserMcp, type BrowserToolPolicy } from "../browser/mcp";
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

const DESTRUCTIVE_CLICK_PATTERN =
    /\b(add|create|delete|edit|remove|erase|destroy|save|confirm|pay|payment|purchase|buy|checkout|refund|unsubscribe|cancel|logout|log out|sign out|publish|submit|send|place order|adicionar|criar|editar|salvar|confirmar|excluir|apagar|remover|deletar|pagar|pagamento|comprar|estornar|reembolso|cancelar|sair|desconectar|encerrar|publicar|enviar|submeter|finalizar)\b/i;

function isWithinDiscoveryOrigin(url: string, origin: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return parsed.origin === origin;
}

export function createDiscoveryBrowserPolicy(
    revision: ProjectContextRevisionRow,
    mcp: BrowserMcp,
): BrowserToolPolicy {
    const origin = new URL(revision.brief.startUrl).origin;
    return {
        allowedTools: DISCOVERY_BROWSER_TOOLS,
        beforeCall: async (toolName, args) => {
            if (toolName === "browser_navigate") {
                const target = String(args.url ?? "");
                let parsed: URL;
                try {
                    parsed = new URL(target);
                } catch {
                    throw new Error(`Navigation rejected: "${target}" is not a valid URL.`);
                }
                if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                    throw new Error("Navigation rejected: only HTTP and HTTPS URLs are allowed during discovery.");
                }
                if (parsed.origin !== origin) {
                    throw new Error(
                        `Navigation rejected: ${parsed.origin} is outside the discovery origin ${origin}.`,
                    );
                }
            }
            if (toolName === "browser_tabs" && args.action === "new") {
                throw new Error("Opening new tabs is not allowed during discovery.");
            }
            if (toolName === "browser_click") {
                const description = String(args.element ?? "");
                const match = description.match(DESTRUCTIVE_CLICK_PATTERN);
                if (match) {
                    throw new Error(
                        `Click rejected: "${description}" looks like a destructive or irreversible action ("${match[0]}"). Discovery must not trigger it.`,
                    );
                }
            }
        },
        afterCall: async () => {
            const active = await getActiveTabUrl(mcp);
            if (!active || isWithinDiscoveryOrigin(active, origin)) return;
            await mcp.client.callTool({ name: "browser_navigate_back", arguments: {} }).catch(() => undefined);
            const afterBack = await getActiveTabUrl(mcp);
            if (afterBack && !isWithinDiscoveryOrigin(afterBack, origin)) {
                await mcp.navigate(revision.brief.startUrl).catch(() => undefined);
            }
            throw new Error(
                `The page left the discovery origin ${origin} (it reached ${active}). The browser returned to the allowed origin; the external destination was not inspected.`,
            );
        },
    };
}
