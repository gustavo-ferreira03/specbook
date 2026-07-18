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
            await browser.mcp.ensureBrowser();
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
            const record: ChatBrowser = { vnc, mcp, workDir, idleTimer, lastHealthCheck: Date.now() };
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
    clearTimeout(record.idleTimer);
    try {
        await record.mcp.close();
    } finally {
        stopVncStack(record.vnc.id);
    }
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
