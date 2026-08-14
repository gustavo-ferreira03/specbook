import fs from "node:fs/promises";
import path from "node:path";
import { storageRoot } from "../paths";
import { launchBrowserMcp, type BrowserMcp } from "./mcp";
import { getVncSession, startVncStack, stopVncStack, type VncSession } from "./vnc";

const BROWSER_IDLE_MS = 10 * 60 * 1000;

interface ChatBrowser {
    vnc: VncSession;
    mcp: BrowserMcp;
    workDir: string;
    idleTimer: NodeJS.Timeout;
    lastHealthCheck: number;
    activeTools: Map<string, number>;
}

const browsers = new Map<string, ChatBrowser>();
const pending = new Map<string, Promise<ChatBrowser>>();
const deletingChats = new Set<string>();

function touchChatBrowser(chatId: string, browser: ChatBrowser): void {
    clearTimeout(browser.idleTimer);
    browser.idleTimer = setTimeout(() => void closeChatBrowser(chatId), BROWSER_IDLE_MS);
    browser.idleTimer.unref();
}

export async function getChatBrowser(chatId: string): Promise<ChatBrowser | null> {
    if (deletingChats.has(chatId)) return null;
    const browser = browsers.get(chatId);
    if (!browser) return null;
    if (!getVncSession(browser.vnc.id)) {
        void closeChatBrowser(chatId);
        return null;
    }
    if (Date.now() - browser.lastHealthCheck >= 5000) {
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

export async function getOrCreateChatBrowser(chatId: string): Promise<ChatBrowser> {
    if (deletingChats.has(chatId)) throw new Error("Chat is being deleted");
    const existing = browsers.get(chatId);
    if (existing) {
        if (!getVncSession(existing.vnc.id)) {
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
            const mcp = await launchBrowserMcp({ workDir, display: vnc.display });
            if (deletingChats.has(chatId)) {
                await mcp.close();
                stopVncStack(vnc.id);
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
            };
            browsers.set(chatId, record);
            touchChatBrowser(chatId, record);
            return record;
        } catch (error) {
            stopVncStack(vnc.id);
            throw error;
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
    const record = browsers.get(chatId);
    if (!record) return;
    browsers.delete(chatId);
    record.activeTools.clear();
    clearTimeout(record.idleTimer);
    try {
        await record.mcp.close();
    } finally {
        stopVncStack(record.vnc.id);
    }
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
}
