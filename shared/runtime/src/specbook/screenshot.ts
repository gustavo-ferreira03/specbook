import fs from "node:fs/promises";
import type { Frame, JSHandle, Locator, Page } from "@playwright/test";
import { withEvidenceTimeout } from "./evidence-timeout.ts";

function remaining(deadline: number): number { return Math.max(1, deadline - Date.now()); }

async function captureWebP(page: Page, file: string, deadline: number): Promise<void> {
    const session = await withEvidenceTimeout(() => page.context().newCDPSession(page), remaining(deadline));
    try {
        const result = await withEvidenceTimeout(async () => {
            await Promise.all(page.frames().map((frame) => frame.evaluate(() => document.fonts.ready.then(() => undefined))));
            return session.send("Page.captureScreenshot", { format: "webp", quality: 80, fromSurface: true, captureBeyondViewport: false });
        }, remaining(deadline));
        await fs.writeFile(file, Buffer.from(result.data, "base64"));
    } finally {
        await withEvidenceTimeout(() => session.detach(), 1000).catch(() => undefined);
    }
}

const SAVED_STYLE = "data-specbook-evidence-style";

// Keep input lengths while hiding their values.
async function addMasks(mask: Locator, deadline: number): Promise<void> {
    await mask.evaluateAll((elements, { deadline, saved }) => {
        if (Date.now() > deadline) throw new Error("Browser evidence timed out");
        for (const element of elements as HTMLElement[]) {
            element.setAttribute(saved, JSON.stringify(element.getAttribute("style")));
            element.style.setProperty("-webkit-text-security", "disc", "important");
        }
    }, { deadline, saved: SAVED_STYLE });
}

async function removeMasks(frames: Frame[], marker: string, attribute: string): Promise<void> {
    // Failed navigations can leave a frame without an execution context.
    await withEvidenceTimeout(() => Promise.all(frames.map((frame) => frame.evaluate(({ marker, attribute, saved }) => {
        const roots: (Document | ShadowRoot)[] = [document];
        for (const root of roots) for (const element of root.querySelectorAll("*")) {
            if (element.shadowRoot) roots.push(element.shadowRoot);
            if (!element.getAttribute(attribute)?.startsWith(marker + "-")) continue;
            const style = element.getAttribute(saved);
            if (style !== null) {
                const previous = JSON.parse(style) as string | null;
                if (previous === null) element.removeAttribute("style");
                else element.setAttribute("style", previous);
                element.removeAttribute(saved);
            }
            element.removeAttribute(attribute);
        }
    }, { marker, attribute, saved: SAVED_STYLE }).catch(() => undefined))).then(() => undefined), 1000).catch(() => undefined);
}

export async function captureStepScreenshot(page: Page, file: string, secrets: string[]): Promise<{ file: string; contentType: "image/webp" | "image/png" }> {
    const attribute = "data-specbook-evidence-mask";
    const marker = crypto.randomUUID();
    const frames = page.frames();
    const deadline = Date.now() + 5000;
    const textMasks: JSHandle<{ node: Text; value: string }[]>[] = [];
    try {
        if (secrets.length) await withEvidenceTimeout(() => Promise.all(frames.map(async (frame) => {
            const saved = await frame.evaluateHandle(({ secrets, deadline }) => {
                const saved: { node: Text; value: string }[] = [];
                const roots: (Document | ShadowRoot)[] = [document];
                for (const root of roots) {
                    for (const element of root.querySelectorAll("*")) if (element.shadowRoot) roots.push(element.shadowRoot);
                    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
                    while (walker.nextNode()) {
                        if (Date.now() > deadline) break;
                        const node = walker.currentNode as Text;
                        if (node.parentElement?.closest("script, style, textarea")) continue;
                        const value = node.data;
                        const masked = secrets.reduce((text, secret) => secret ? text.split(secret).join("••••") : text, value);
                        if (masked === value) continue;
                        saved.push({ node, value });
                        node.data = masked;
                    }
                }
                return saved;
            }, { secrets, deadline });
            textMasks.push(saved);
        })).then(() => undefined), remaining(deadline));
        const masks = await withEvidenceTimeout(() => Promise.all(frames.map(async (frame) => {
            const state = await frame.evaluateHandle(() => {
                const roots: (Document | ShadowRoot)[] = [document];
                const elements: Element[] = [];
                const candidates: { index: number; sensitive: boolean; value: string }[] = [];
                for (const root of roots) for (const element of root.querySelectorAll("*")) {
                    if (element.shadowRoot) roots.push(element.shadowRoot);
                    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) continue;
                    elements.push(element);
                    candidates.push({ index: candidates.length,
                        sensitive: element.matches("input[type=password], .__specbookSecret, [data-specbook-secret]"),
                        value: element.value });
                }
                return { elements, candidates };
            });
            try {
                const candidates = await state.evaluate(({ candidates }) => candidates);
                const indices = candidates.filter((candidate) => candidate.sensitive || secrets.some((secret) => candidate.value.includes(secret)))
                    .map((candidate) => candidate.index);
                await state.evaluate(({ elements }, { indices, attribute, marker, deadline }) => {
                    if (Date.now() > deadline) return;
                    for (const index of indices) elements[index].setAttribute(attribute, `${marker}-${index}`);
                }, { indices, attribute, marker, deadline });
                return indices.length ? frame.locator(indices.map((index) => `[${attribute}="${marker}-${index}"]`).join(",")) : null;
            } finally { await withEvidenceTimeout(() => state.dispose(), remaining(deadline)).catch(() => undefined); }
        })), remaining(deadline));
        const selected = masks.filter((mask) => mask !== null);
        await withEvidenceTimeout(() => Promise.all(selected.map((mask) => addMasks(mask, deadline))).then(() => undefined), remaining(deadline));
        try {
            const target = `${file}.webp`;
            await captureWebP(page, target, deadline);
            return { file: target, contentType: "image/webp" };
        } catch {
            const target = `${file}.png`;
            await page.screenshot({ path: target, timeout: 5000 });
            return { file: target, contentType: "image/png" };
        }
    } finally {
        await withEvidenceTimeout(() => Promise.all(textMasks.map(async (saved) => {
            await saved.evaluate((items) => { for (const { node, value } of items) if (node.isConnected) node.data = value; }).catch(() => undefined);
            await saved.dispose().catch(() => undefined);
        })).then(() => undefined), 1000).catch(() => undefined);
        await removeMasks(frames, marker, attribute);
    }
}
