import fs from "node:fs/promises";
import path from "node:path";
import { storageRoot } from "../paths";
import { launchBrowserMcp, type BrowserMcp } from "./mcp";
import { getVncSession, startVncStack, stopVncStack, type VncSession } from "./vnc";

const BROWSER_IDLE_MS = 10 * 60 * 1000;

interface ConversationBrowser {
    vnc: VncSession;
    mcp: BrowserMcp;
    workDir: string;
    idleTimer: NodeJS.Timeout;
    lastHealthCheck: number;
}

const browsers = new Map<string, ConversationBrowser>();
const pending = new Map<string, Promise<ConversationBrowser>>();
const deletingConversations = new Set<string>();

function touchConversationBrowser(conversationId: string, browser: ConversationBrowser): void {
    clearTimeout(browser.idleTimer);
    browser.idleTimer = setTimeout(() => void closeConversationBrowser(conversationId), BROWSER_IDLE_MS);
    browser.idleTimer.unref();
}

export async function getConversationBrowser(conversationId: string): Promise<ConversationBrowser | null> {
    if (deletingConversations.has(conversationId)) return null;
    const browser = browsers.get(conversationId);
    if (!browser) return null;
    if (!getVncSession(browser.vnc.id)) {
        void closeConversationBrowser(conversationId);
        return null;
    }
    if (Date.now() - browser.lastHealthCheck >= 5000) {
        try {
            await browser.mcp.ensureBrowser();
            browser.lastHealthCheck = Date.now();
        } catch {
            await closeConversationBrowser(conversationId);
            return null;
        }
    }
    touchConversationBrowser(conversationId, browser);
    return browser;
}

export async function getOrCreateConversationBrowser(conversationId: string): Promise<ConversationBrowser> {
    if (deletingConversations.has(conversationId)) throw new Error("Conversation is being deleted");
    const existing = browsers.get(conversationId);
    if (existing) {
        if (!getVncSession(existing.vnc.id)) {
            await closeConversationBrowser(conversationId);
        } else {
            try {
                await existing.mcp.client.listTools();
                touchConversationBrowser(conversationId, existing);
                return existing;
            } catch {
                await closeConversationBrowser(conversationId);
            }
        }
    }
    const inFlight = pending.get(conversationId);
    if (inFlight) return inFlight;
    const promise = (async () => {
        const vnc = await startVncStack();
        const workDir = path.join(storageRoot, "chat", "browser", conversationId);
        try {
            const mcp = await launchBrowserMcp({ workDir, display: vnc.display });
            if (deletingConversations.has(conversationId)) {
                await mcp.close();
                stopVncStack(vnc.id);
                throw new Error("Conversation is being deleted");
            }
            const idleTimer = setTimeout(() => undefined, BROWSER_IDLE_MS);
            idleTimer.unref();
            const record: ConversationBrowser = { vnc, mcp, workDir, idleTimer, lastHealthCheck: Date.now() };
            browsers.set(conversationId, record);
            touchConversationBrowser(conversationId, record);
            return record;
        } catch (error) {
            stopVncStack(vnc.id);
            throw error;
        }
    })();
    pending.set(conversationId, promise);
    try {
        return await promise;
    } finally {
        pending.delete(conversationId);
    }
}

export async function closeConversationBrowser(conversationId: string): Promise<void> {
    const record = browsers.get(conversationId);
    if (!record) return;
    browsers.delete(conversationId);
    clearTimeout(record.idleTimer);
    try {
        await record.mcp.close();
    } finally {
        stopVncStack(record.vnc.id);
    }
}

export async function blockConversationBrowser(conversationId: string): Promise<void> {
    deletingConversations.add(conversationId);
    await pending.get(conversationId)?.catch(() => undefined);
    await closeConversationBrowser(conversationId);
}

export function cancelConversationBrowserDeletion(conversationId: string): void {
    deletingConversations.delete(conversationId);
}

export async function removeConversationBrowserData(conversationId: string): Promise<void> {
    const root = path.resolve(storageRoot, "chat", "browser");
    const directory = path.resolve(root, conversationId);
    if (path.dirname(directory) !== root) throw new Error("Invalid conversation browser directory");
    await fs.rm(directory, { recursive: true, force: true });
}

export async function closeAllConversationBrowsers(): Promise<void> {
    await Promise.allSettled([...pending.values()]);
    await Promise.all([...browsers.keys()].map(closeConversationBrowser));
}
