import fs from "node:fs/promises";
import path from "node:path";
import { storageRoot } from "../paths";
import { isChatBusy, releaseChatTurn, tryReserveChatTurn } from "../chat/chat-registry";
import { launchBrowserMcp, type BrowserMcp } from "./mcp";
import { BrowserUnavailableError, getVncSession, startVncStack, stopVncStack, type VncSession } from "./vnc";

const BROWSER_IDLE_MS = 10 * 60 * 1000;

interface ChatBrowser {
    vnc: VncSession;
    mcp: BrowserMcp;
    workDir: string;
    idleTimer: NodeJS.Timeout;
    lastHealthCheck: number;
    activeTools: Map<string, number>;
    navigationPolicy: string;
}

const browsers = new Map<string, ChatBrowser>();
const pending = new Map<string, Promise<ChatBrowser>>();
const closing = new Map<string, Promise<void>>();
const deletingChats = new Set<string>();

export async function removeInactiveBrowserData(chatId: string, before: number): Promise<boolean> {
    const directory = path.join(storageRoot, "chat", "browser", chatId);
    const stat = await fs.lstat(directory).catch(() => null);
    if (!stat?.isDirectory() || stat.mtimeMs >= before || browsers.has(chatId) || pending.has(chatId) || closing.has(chatId) || deletingChats.has(chatId)) return false;
    if (!tryReserveChatTurn(chatId)) return false;
    try { await fs.rm(directory, { recursive: true, force: true }); return true; }
    finally { releaseChatTurn(chatId); }
}

function touchChatBrowser(chatId: string, browser: ChatBrowser): void {
    clearTimeout(browser.idleTimer);
    browser.idleTimer = setTimeout(() => {
        // A turn may think or run Specs for a long time without browser tool calls.
        // Keep the browser while it is active and re-check after another idle period.
        if (isChatBusy(chatId) || browser.activeTools.size > 0) touchChatBrowser(chatId, browser);
        else void closeChatBrowser(chatId);
    }, BROWSER_IDLE_MS);
    browser.idleTimer.unref();
}

export async function getChatBrowser(chatId: string): Promise<ChatBrowser | null> {
    if (deletingChats.has(chatId)) return null;
    const browser = browsers.get(chatId);
    if (!browser) return null;
    // Never close a browser from a status read while its chat turn is running: the turn
    // owns it and recovers from a dead browser itself (ensureBrowser/getOrCreateChatBrowser).
    const turnActive = isChatBusy(chatId);
    if (!getVncSession(browser.vnc.id)) {
        if (!turnActive) void closeChatBrowser(chatId);
        return null;
    }
    if (!turnActive && Date.now() - browser.lastHealthCheck >= 5000) {
        try {
            await browser.mcp.client.listTools();
            browser.lastHealthCheck = Date.now();
        } catch {
            await closeChatBrowser(chatId);
            return null;
        }
    }
    touchChatBrowser(chatId, browser);
    return browser;
}

export async function getOrCreateChatBrowser(chatId: string, navigationOrigins: string[]): Promise<ChatBrowser> {
    await closing.get(chatId);
    if (deletingChats.has(chatId)) throw new Error("Chat is being deleted");
    const navigationPolicy = [...new Set(navigationOrigins)].sort().join(";");
    const existing = browsers.get(chatId);
    if (existing) {
        if (!getVncSession(existing.vnc.id) || existing.navigationPolicy !== navigationPolicy) {
            await closeChatBrowser(chatId);
        } else {
            try {
                await existing.mcp.client.listTools();
                touchChatBrowser(chatId, existing);
                return existing;
            } catch {
                await closeChatBrowser(chatId);
            }
        }
    }
    const inFlight = pending.get(chatId);
    if (inFlight) return inFlight;
    const promise = (async () => {
        const vnc = await startVncStack();
        const workDir = path.join(storageRoot, "chat", "browser", chatId);
        try {
            await fs.rm(path.join(workDir, "profile"), { recursive: true, force: true });
            const mcp = await launchBrowserMcp({ workDir, display: vnc.display, navigationOrigins });
            if (deletingChats.has(chatId)) {
                await mcp.close();
                await stopVncStack(vnc.id);
                throw new Error("Chat is being deleted");
            }
            const idleTimer = setTimeout(() => undefined, BROWSER_IDLE_MS);
            idleTimer.unref();
            const record: ChatBrowser = {
                vnc,
                mcp,
                workDir,
                idleTimer,
                lastHealthCheck: Date.now(),
                activeTools: new Map(),
                navigationPolicy,
            };
            browsers.set(chatId, record);
            touchChatBrowser(chatId, record);
            return record;
        } catch (error) {
            await stopVncStack(vnc.id);
            if (deletingChats.has(chatId)) throw error;
            throw error instanceof BrowserUnavailableError ? error : new BrowserUnavailableError(error);
        }
    })();
    pending.set(chatId, promise);
    try {
        return await promise;
    } finally {
        pending.delete(chatId);
    }
}

export async function closeChatBrowser(chatId: string): Promise<void> {
    const inFlight = closing.get(chatId);
    if (inFlight) return inFlight;
    const record = browsers.get(chatId);
    if (!record) return;
    browsers.delete(chatId);
    record.activeTools.clear();
    clearTimeout(record.idleTimer);
    const task = (async () => {
        try {
            await record.mcp.close();
        } finally {
            await stopVncStack(record.vnc.id);
        }
    })();
    closing.set(chatId, task);
    try { await task; } finally { closing.delete(chatId); }
}

export function beginChatBrowserTool(chatId: string, toolName: string): void {
    const browser = browsers.get(chatId);
    if (!browser) return;
    browser.activeTools.set(toolName, (browser.activeTools.get(toolName) ?? 0) + 1);
    touchChatBrowser(chatId, browser);
}

export function endChatBrowserTool(chatId: string, toolName: string): void {
    const browser = browsers.get(chatId);
    if (!browser) return;
    const count = browser.activeTools.get(toolName) ?? 0;
    if (count <= 1) browser.activeTools.delete(toolName);
    else browser.activeTools.set(toolName, count - 1);
    touchChatBrowser(chatId, browser);
}

export function getChatBrowserActivity(chatId: string): { sessionId: string; toolName: string } | null {
    const browser = browsers.get(chatId);
    if (!browser) return null;
    const toolName = browser.activeTools.keys().next().value;
    return typeof toolName === "string" ? { sessionId: browser.vnc.id, toolName } : null;
}

export async function blockChatBrowser(chatId: string): Promise<void> {
    deletingChats.add(chatId);
    await pending.get(chatId)?.catch(() => undefined);
    await closeChatBrowser(chatId);
}

export function cancelChatBrowserDeletion(chatId: string): void {
    deletingChats.delete(chatId);
}

export async function removeChatBrowserData(chatId: string): Promise<void> {
    const root = path.resolve(storageRoot, "chat", "browser");
    const directory = path.resolve(root, chatId);
    if (path.dirname(directory) !== root) throw new Error("Invalid chat browser directory");
    await fs.rm(directory, { recursive: true, force: true });
}

export async function closeAllChatBrowsers(): Promise<void> {
    await Promise.allSettled([...pending.values()]);
    await Promise.all([...browsers.keys()].map(closeChatBrowser));
    await Promise.allSettled([...closing.values()]);
}
