import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "./vnc";

const require = createRequire(import.meta.url);
const MCP_CLI = path.join(path.dirname(require.resolve("@playwright/mcp/package.json")), "cli.js");

const ALLOWED_TOOLS = new Set([
    "browser_navigate",
    "browser_navigate_back",
    "browser_snapshot",
    "browser_click",
    "browser_type",
    "browser_fill_form",
    "browser_select_option",
    "browser_hover",
    "browser_press_key",
    "browser_wait_for",
    "browser_handle_dialog",
    "browser_tabs",
]);

export interface BrowserToolPolicy {
    allowedTools?: ReadonlySet<string>;
    beforeCall?: (toolName: string, args: Record<string, unknown>) => Promise<void>;
    afterCall?: (toolName: string, args: Record<string, unknown>, result: string) => Promise<void>;
}

export interface BrowserMcp {
    client: Client;
    tools: { name: string; description?: string; inputSchema: unknown }[];
    ensureBrowser: () => Promise<void>;
    navigate: (url: string) => Promise<void>;
    close: () => Promise<void>;
}

export async function launchBrowserMcp(opts: { workDir: string; display: string }): Promise<BrowserMcp> {
    await fs.mkdir(opts.workDir, { recursive: true });
    const userDataDir = path.join(opts.workDir, "profile");
    const defaultProfileDir = path.join(userDataDir, "Default");
    await fs.mkdir(defaultProfileDir, { recursive: true });
    await fs.writeFile(
        path.join(defaultProfileDir, "Preferences"),
        JSON.stringify({
            browser: { check_default_browser: false, has_seen_welcome_page: true },
            credentials_enable_service: false,
            profile: {
                default_content_setting_values: { notifications: 2 },
                password_manager_enabled: false,
                password_manager_leak_detection: false,
            },
            session: { restore_on_startup: 5, startup_urls: [] },
        }),
        "utf8",
    );
    const config = {
        browser: {
            browserName: "chromium",
            userDataDir,
            launchOptions: {
                headless: false,
                args: [
                    "--disable-dev-shm-usage",
                    "--disable-features=PasswordManagerOnboarding,PasswordManagerLeakDetection,PasswordManagerEnabled",
                    "--disable-notifications",
                    "--disable-session-crashed-bubble",
                    "--no-default-browser-check",
                    "--no-first-run",
                    "--window-position=0,0",
                    `--window-size=${SCREEN_WIDTH},${SCREEN_HEIGHT}`,
                ],
            },
        },
    };
    const configPath = path.join(opts.workDir, "mcp-config.json");
    await fs.writeFile(configPath, JSON.stringify(config), "utf8");
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        DISPLAY: opts.display,
        XDG_SESSION_TYPE: "x11",
    };
    delete env.WAYLAND_DISPLAY;
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [MCP_CLI, "--config", configPath],
        cwd: opts.workDir,
        env: env as Record<string, string>,
        stderr: "ignore",
    });
    const client = new Client({ name: "specbook-agent", version: "1.0.0" });
    try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        const ensureBrowser = async () => {
            await client.callTool({ name: "browser_tabs", arguments: { action: "list" } });
        };
        const navigate = async (url: string) => {
            await client.callTool({ name: "browser_navigate", arguments: { url } });
        };
        await ensureBrowser();
        return {
            client,
            tools: tools as BrowserMcp["tools"],
            ensureBrowser,
            navigate,
            close: async () => {
                await client.close().catch(() => undefined);
            },
        };
    } catch (error) {
        await client.close().catch(() => undefined);
        throw error;
    }
}

function inlineSnapshots(text: string, workDir: string): Promise<string> {
    const refs = [...text.matchAll(/\[Snapshot\]\(([^)]+)\)/g)].map((match) => match[1]);
    if (refs.length === 0) return Promise.resolve(text);
    return Promise.all(
        refs.map(async (ref) => {
            try {
                const root = await fs.realpath(workDir);
                const candidate = path.isAbsolute(ref) ? path.resolve(ref) : path.resolve(root, ref);
                const file = await fs.realpath(candidate);
                const relative = path.relative(root, file);
                if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
                    return null;
                }
                return await fs.readFile(file, "utf8");
            } catch {
                return null;
            }
        }),
    ).then((snapshots) => {
        const body = snapshots.filter(Boolean).join("\n");
        return body ? `${text}\n\nSnapshot:\n${body}` : text;
    });
}

function extractMcpText(result: { content?: unknown }): string {
    const content = Array.isArray(result.content)
        ? (result.content as { type?: string; text?: string }[])
        : [];
    return content
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n")
        .trim();
}

async function renderMcpResult(result: { content?: unknown }, workDir: string): Promise<string> {
    return inlineSnapshots(extractMcpText(result), workDir);
}

export async function getActiveTabUrl(mcp: BrowserMcp): Promise<string | null> {
    try {
        const result = await mcp.client.callTool({ name: "browser_tabs", arguments: { action: "list" } });
        const text = extractMcpText(result as { content?: unknown });
        const pageUrl = text.match(/^- Page URL: (\S+)/m);
        if (pageUrl) return pageUrl[1];
        const currentTab = text.split("\n").find((line) => line.includes("(current)"));
        const listedUrl = currentTab?.match(/\]\((\S+)\)/);
        return listedUrl ? listedUrl[1] : null;
    } catch {
        return null;
    }
}

export function bridgeBrowserTools(
    mcp: BrowserMcp,
    workDir: string,
    policy?: BrowserToolPolicy,
): ReturnType<typeof defineTool>[] {
    return mcp.tools
        .filter((tool) => ALLOWED_TOOLS.has(tool.name))
        .filter((tool) => !policy?.allowedTools || policy.allowedTools.has(tool.name))
        .map((tool) =>
            defineTool({
                name: tool.name,
                label: tool.name,
                description: tool.description ?? tool.name,
                parameters: Type.Unsafe<Record<string, unknown>>(
                    tool.inputSchema as Parameters<typeof Type.Unsafe>[0],
                ),
                async execute(_id, params) {
                    const args = (params ?? {}) as Record<string, unknown>;
                    const toolError = (text: string) => ({
                        content: [{ type: "text" as const, text }],
                        details: undefined,
                        terminate: false,
                    });
                    if (policy?.beforeCall) {
                        try {
                            await policy.beforeCall(tool.name, args);
                        } catch (error) {
                            return toolError(error instanceof Error ? error.message : String(error));
                        }
                    }
                    try {
                        const result = await mcp.client.callTool({ name: tool.name, arguments: args });
                        const text = await renderMcpResult(result as { content?: unknown }, workDir);
                        if (policy?.afterCall) {
                            try {
                                await policy.afterCall(tool.name, args, text);
                            } catch (error) {
                                return toolError(error instanceof Error ? error.message : String(error));
                            }
                        }
                        return {
                            content: [{ type: "text" as const, text: text || "(no output)" }],
                            details: undefined,
                            terminate: false,
                        };
                    } catch (error) {
                        return toolError(`browser tool failed: ${String(error)}`);
                    }
                },
            }),
        );
}
