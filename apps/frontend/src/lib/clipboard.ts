export async function copyText(text: string): Promise<boolean> {
    if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
        }
    }
    if (typeof document === "undefined") return false;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "0";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    try {
        textarea.select();
        textarea.setSelectionRange(0, text.length);
        return document.execCommand("copy");
    } catch {
        return false;
    } finally {
        textarea.remove();
        previousFocus?.focus();
    }
}

export function selectElementText(element: HTMLElement | null): void {
    if (!element) return;
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
}
