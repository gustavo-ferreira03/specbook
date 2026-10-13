import fs from "node:fs/promises";
import type { Frame, Locator, Page } from "@playwright/test";

async function captureWebP(page: Page, file: string): Promise<void> {
    const session = await page.context().newCDPSession(page);
    let timer: NodeJS.Timeout | undefined;
    try {
        const result = await Promise.race([
            (async () => {
                await Promise.all(page.frames().map((frame) => frame.evaluate(() => document.fonts.ready.then(() => undefined))));
                return session.send("Page.captureScreenshot", { format: "webp", quality: 80, fromSurface: true, captureBeyondViewport: false });
            })(),
            new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Screenshot timed out")), 5000); }),
        ]);
        await fs.writeFile(file, Buffer.from(result.data, "base64"));
    } finally {
        clearTimeout(timer);
        await session.detach().catch(() => undefined);
    }
}

async function addMasks(mask: Locator, marker: string): Promise<void> {
    await mask.evaluateAll((elements, marker) => {
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
    }, marker);
}

async function removeMasks(frames: Frame[], marker: string): Promise<void> {
    await Promise.all(frames.map((frame) => frame.evaluate((marker) => document.getElementById(marker)?.remove(), marker).catch(() => undefined)));
}

export async function captureStepScreenshot(page: Page, file: string, secrets: string[]): Promise<{ file: string; contentType: "image/webp" | "image/png" }> {
    const attribute = "data-specbook-evidence-mask";
    const marker = crypto.randomUUID();
    const frames = page.frames();
    try {
        const masks = await Promise.all(frames.map(async (frame) => {
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
                await state.evaluate(({ elements }, { indices, attribute, marker }) => {
                    for (const index of indices) elements[index].setAttribute(attribute, `${marker}-${index}`);
                }, { indices, attribute, marker });
                return indices.length ? frame.locator(indices.map((index) => `[${attribute}="${marker}-${index}"]`).join(",")) : null;
            } finally { await state.dispose(); }
        }));
        const selected = masks.filter((mask) => mask !== null);
        try {
            await Promise.all(selected.map((mask) => addMasks(mask, marker)));
            const target = `${file}.webp`;
            await captureWebP(page, target);
            return { file: target, contentType: "image/webp" };
        } catch {
            await removeMasks(frames, marker);
            const target = `${file}.png`;
            await page.screenshot({ path: target, timeout: 5000, mask: selected, maskColor: "#777777" });
            return { file: target, contentType: "image/png" };
        }
    } finally {
        await removeMasks(frames, marker);
        await Promise.all(frames.map((frame) => frame.evaluate(({ attribute, marker }) => {
            const roots: (Document | ShadowRoot)[] = [document];
            for (const root of roots) for (const element of root.querySelectorAll("*")) {
                if (element.shadowRoot) roots.push(element.shadowRoot);
                if (element.getAttribute(attribute)?.startsWith(marker + "-")) element.removeAttribute(attribute);
            }
        }, { attribute, marker }).catch(() => undefined)));
    }
}
