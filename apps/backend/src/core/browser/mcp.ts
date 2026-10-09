import { CodedError, errorCodeOf, type ErrorCode } from "../errors";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SPEC_VIEWPORT } from "../runner/playwright";
import { minimalChildEnv } from "../runner/process";
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
    "browser_drag",
    "browser_take_screenshot",
    "browser_mouse_move_xy",
    "browser_mouse_click_xy",
    "browser_mouse_drag_xy",
    "browser_mouse_down",
    "browser_mouse_up",
    "browser_mouse_wheel",
]);

export interface BrowserToolPolicy {
    allowedTools?: ReadonlySet<string>;
    beforeCall?: (toolName: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<void>;
    afterCall?: (toolName: string, args: Record<string, unknown>, result: string, signal?: AbortSignal) => Promise<void>;
    sanitizeResult?: (text: string) => Promise<string> | string;
    sendScreenshots?: () => Promise<boolean>;
}

export interface BrowserMcp {
    workDir?: string;
    client: Client;
    tools: { name: string; description?: string; inputSchema: unknown }[];
    ensureBrowser: (signal?: AbortSignal) => Promise<void>;
    navigate: (url: string, signal?: AbortSignal) => Promise<void>;
    close: () => Promise<void>;
}

export async function launchBrowserMcp(opts: { workDir: string; display: string; navigationOrigins?: string[] }): Promise<BrowserMcp> {
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
    const initPage = path.join(opts.workDir, "navigation-policy.ts");
    if (opts.navigationOrigins) {
        await fs.writeFile(initPage, `export default async ({ page }) => {
            const allowed = new Set(${JSON.stringify(opts.navigationOrigins)});
            const session = await page.context().newCDPSession(page);
            session.on("Fetch.requestPaused", (event) => {
                let permitted = false;
                try { permitted = allowed.has(new URL(event.request.url).origin); } catch {}
                void session.send(permitted ? "Fetch.continueRequest" : "Fetch.failRequest", {
                    requestId: event.requestId, ...(permitted ? {} : { errorReason: "BlockedByClient" }),
                }).catch(() => undefined);
            });
            await session.send("Fetch.enable", { patterns: [{ resourceType: "Document", requestStage: "Request" }] });
            page.on("close", () => void session.detach().catch(() => undefined));
        };`, "utf8");
    }
    const config = {
        browser: {
            browserName: "chromium",
            ...(opts.navigationOrigins ? { initPage: [initPage] } : {}),
            contextOptions: { viewport: SPEC_VIEWPORT, ...(opts.navigationOrigins ? { serviceWorkers: "block" } : {}) },
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
        capabilities: ["core", "storage", "vision"],
    };
    const configPath = path.join(opts.workDir, "mcp-config.json");
    await fs.writeFile(configPath, JSON.stringify(config), "utf8");
    const env = minimalChildEnv({
        DISPLAY: opts.display,
        XDG_SESSION_TYPE: "x11",
    });
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [MCP_CLI, "--config", configPath],
        cwd: opts.workDir,
        env,
        stderr: "ignore",
    });
    const client = new Client({ name: "specbook-agent", version: "1.0.0" });
    try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        const ensureBrowser = async (signal?: AbortSignal) => {
            const result = await client.callTool({ name: "browser_tabs", arguments: { action: "list" } }, undefined, { signal });
            if (result.isError) throw new CodedError("infrastructure", `The browser could not start: ${extractMcpText(result as { content?: unknown })}`);
        };
        const navigate = async (url: string, signal?: AbortSignal) => {
            const result = await client.callTool({ name: "browser_navigate", arguments: { url } }, undefined, { signal });
            if (result.isError) throw new CodedError("environment", `browser tool failed: ${extractMcpText(result as { content?: unknown })}`);
        };
        return {
            client,
            workDir: opts.workDir,
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

export function extractMcpText(result: { content?: unknown }): string {
    const content = Array.isArray(result.content)
        ? (result.content as { type?: string; text?: string }[])
        : [];
    return content
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n")
        .trim();
}

function mcpImages(result: { content?: unknown }): { type: "image"; data: string; mimeType: string }[] {
    const content = Array.isArray(result.content) ? (result.content as { type?: string; data?: unknown; mimeType?: unknown }[]) : [];
    return content
        .filter((item) => item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string")
        .map((item) => ({ type: "image" as const, data: item.data as string, mimeType: item.mimeType as string }));
}

export async function renderMcpResult(result: { content?: unknown }, workDir: string): Promise<string> {
    return inlineSnapshots(extractMcpText(result), workDir);
}

export async function readBrowserSnapshot(mcp: BrowserMcp, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const result = await mcp.client.callTool({ name: "browser_snapshot", arguments: {} }, undefined, { signal });
    if (result.isError) throw new CodedError("infrastructure", "The current browser snapshot could not be read.");
    const content = result as { content?: unknown };
    return mcp.workDir ? renderMcpResult(content, mcp.workDir) : extractMcpText(content);
}

export async function getActiveTabUrl(mcp: BrowserMcp, signal?: AbortSignal): Promise<string | null> {
    signal?.throwIfAborted();
    const result = await mcp.client.callTool({ name: "browser_tabs", arguments: { action: "list" } }, undefined, { signal }).catch((error) => {
        signal?.throwIfAborted();
        throw new CodedError("infrastructure", `The browser could not inspect its open tabs: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    });
    const text = extractMcpText(result as { content?: unknown });
    if (result.isError) throw new CodedError("infrastructure", `The browser could not inspect its open tabs: ${text}`);
    const pageUrl = text.match(/^- Page URL: (\S+)/m);
    if (pageUrl) return pageUrl[1];
    const currentTab = text.split("\n").find((line) => line.includes("(current)"));
    const listedUrl = currentTab?.match(/\]\((\S+)\)/);
    return listedUrl ? listedUrl[1] : null;
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
                async execute(_id, params, signal) {
                    signal?.throwIfAborted();
                    const args = (params ?? {}) as Record<string, unknown>;
                    if (tool.name === "browser_take_screenshot") delete args.filename;
                    const clean = async (value: string) =>
                        policy?.sanitizeResult ? await policy.sanitizeResult(value) : value;
                    const toolError = async (text: string, errorCode?: ErrorCode) => ({
                        errorCode,
                        content: [{ type: "text" as const, text: await clean(text) }],
                        details: undefined,
                        terminate: false,
                        isError: true,
                    });
                    if (policy?.beforeCall) {
                        try {
                            await policy.beforeCall(tool.name, args, signal);
                        } catch (error) {
                            signal?.throwIfAborted();
                            return toolError(error instanceof Error ? error.message : String(error), errorCodeOf(error) ?? "failed");
                        }
                    }
                    let resultText = "";
                    let callError = "";
                    let callErrorCode: ErrorCode | undefined;
                    let images: { type: "image"; data: string; mimeType: string }[] = [];
                    try {
                        signal?.throwIfAborted();
                        const result = await mcp.client.callTool({ name: tool.name, arguments: args }, undefined, { signal });
                        callErrorCode = errorCodeOf(result) ?? errorCodeOf(result.structuredContent) ?? "failed";
                        resultText = await renderMcpResult(result as { content?: unknown }, workDir);
                        images = mcpImages(result as { content?: unknown });
                        if (result.isError) callError = `browser tool failed: ${resultText || "The browser returned an error without details."}`;
                    } catch (error) {
                        callErrorCode = errorCodeOf(error) ?? "infrastructure";
                        callError = `browser tool failed: ${String(error)}`;
                        resultText = callError;
                    }
                    if (policy?.afterCall) {
                        try {
                            await policy.afterCall(tool.name, args, resultText, signal);
                        } catch (error) {
                            signal?.throwIfAborted();
                            const message = error instanceof Error ? error.message : String(error);
                            return toolError(callError ? `${callError}\n${message}` : message, errorCodeOf(error) ?? callErrorCode ?? "failed");
                        }
                    }
                    signal?.throwIfAborted();
                    if (callError) return toolError(callError, callErrorCode);
                    const sendImages = images.length > 0 && (await policy?.sendScreenshots?.()) === true;
                    if (images.length > 0 && !sendImages) resultText += "\nThe screenshot was withheld: screenshots are not sent to the model in this instance's security settings.";
                    return {
                        content: [{ type: "text" as const, text: (await clean(resultText)) || "(no output)" }, ...(sendImages ? images : [])],
                        details: undefined,
                        terminate: false,
                    };
                },
            }),
        );
}
