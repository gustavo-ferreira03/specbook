import fs from "node:fs/promises";
import type { Frame, Locator, Page } from "@playwright/test";
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

async function addMasks(mask: Locator, marker: string, deadline: number): Promise<void> {
    await mask.evaluateAll((elements, { marker, deadline }) => {
        if (Date.now() > deadline) return;
        const overlay = document.createElement("div");
        overlay.id = marker;
        overlay.className = "__specbookSecret";
        overlay.setAttribute("popover", "manual");
        overlay.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;margin:0;padding:0;border:0;background:transparent;pointer-events:none;z-index:2147483647";
        for (const element of elements) {
            const rect = element.getBoundingClientRect();
            if (!rect.width || !rect.height) continue;
            const cover = document.createElement("div");
            cover.style.cssText = `position:absolute;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;background:#777777`;
            overlay.appendChild(cover);
        }
        document.documentElement.appendChild(overlay);
        // The top layer also covers secret fields inside dialogs.
        overlay.showPopover();
    }, { marker, deadline });
}

async function removeMasks(frames: Frame[], marker: string, attribute?: string): Promise<void> {
    // Failed navigations can leave a frame without an execution context.
    await withEvidenceTimeout(() => Promise.all(frames.map((frame) => frame.evaluate(({ marker, attribute }) => {
        document.getElementById(marker)?.remove();
        if (!attribute) return;
        const roots: (Document | ShadowRoot)[] = [document];
        for (const root of roots) for (const element of root.querySelectorAll("*")) {
            if (element.shadowRoot) roots.push(element.shadowRoot);
            if (element.getAttribute(attribute)?.startsWith(marker + "-")) element.removeAttribute(attribute);
        }
    }, { marker, attribute }).catch(() => undefined))).then(() => undefined), 1000).catch(() => undefined);
}

export async function captureStepScreenshot(page: Page, file: string, secrets: string[]): Promise<{ file: string; contentType: "image/webp" | "image/png" }> {
    const attribute = "data-specbook-evidence-mask";
    const marker = crypto.randomUUID();
    const frames = page.frames();
    const deadline = Date.now() + 5000;
    try {
        const masks = await withEvidenceTimeout(() => Promise.all(frames.map(async (frame) => {
            const state = await frame.evaluateHandle(() => {
                const roots: (Document | ShadowRoot)[] = [document];
                const elements: Element[] = [];
                const candidates: { index: number; sensitive: boolean; value: string; text: string; children: string[]; alt: string }[] = [];
                for (const root of roots) for (const element of root.querySelectorAll("*")) {
                    if (element.shadowRoot) roots.push(element.shadowRoot);
                    elements.push(element);
                    candidates.push({ index: candidates.length,
                        sensitive: element.matches("input[type=password], .__specbookSecret, [data-specbook-secret]"),
                        value: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? element.value : "",
                        text: element.textContent ?? "", children: [...element.children].map((child) => child.textContent ?? ""),
                        alt: element.getAttribute("alt") ?? "" });
                }
                return { elements, candidates };
            });
            try {
                const candidates = await state.evaluate(({ candidates }) => candidates);
                const indices = candidates.filter((candidate) => candidate.sensitive || secrets.some((secret) => candidate.value.includes(secret) || candidate.alt.includes(secret)
                    || candidate.text.includes(secret) && !candidate.children.some((text) => text.includes(secret))))
                    .map((candidate) => candidate.index);
                await state.evaluate(({ elements }, { indices, attribute, marker, deadline }) => {
                    if (Date.now() > deadline) return;
                    for (const index of indices) elements[index].setAttribute(attribute, `${marker}-${index}`);
                }, { indices, attribute, marker, deadline });
                return indices.length ? frame.locator(indices.map((index) => `[${attribute}="${marker}-${index}"]`).join(",")) : null;
            } finally { await withEvidenceTimeout(() => state.dispose(), remaining(deadline)).catch(() => undefined); }
        })), remaining(deadline));
        const selected = masks.filter((mask) => mask !== null);
        try {
            await withEvidenceTimeout(() => Promise.all(selected.map((mask) => addMasks(mask, marker, deadline))).then(() => undefined), remaining(deadline));
            const target = `${file}.webp`;
            await captureWebP(page, target, deadline);
            return { file: target, contentType: "image/webp" };
        } catch {
            await removeMasks(frames, marker);
            const target = `${file}.png`;
            await page.screenshot({ path: target, timeout: 5000, mask: selected, maskColor: "#777777" });
            return { file: target, contentType: "image/png" };
        }
    } finally {
        await removeMasks(frames, marker, attribute);
    }
}
