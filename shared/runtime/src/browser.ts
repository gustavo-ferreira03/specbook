export function inspectElement(element: Element): string {
    const clean = (node: Element) => {
        const copy = node.cloneNode(true) as Element;
        for (const field of [copy, ...copy.querySelectorAll("*")]) {
            field.removeAttribute("value");
            if (field.matches("input, textarea, select")) field.textContent = "";
        }
        return copy;
    };
    const openingTag = (node: Element) => clean(node.cloneNode(false) as Element).outerHTML.replace(/<\/[^>]+>$/, "").slice(0, 600);
    const ancestors: string[] = [];
    for (let node = element.parentElement; node && ancestors.length < 4; node = node.parentElement) ancestors.push(openingTag(node));
    const style = getComputedStyle(element);
    return JSON.stringify({
        html: clean(element).outerHTML.slice(0, 6000),
        ancestors,
        computed: { color: style.color, backgroundColor: style.backgroundColor, fill: style.fill, stroke: style.stroke },
    });
}

export const INSPECT_ELEMENT = inspectElement.toString();

export function redactUrls(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redactUrls);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactUrls(item)]));
    if (typeof value !== "string") return value;
    return value.replace(/https?:\/\/[^\s"'<>]+/g, (value) => {
        try {
            const url = new URL(value);
            url.username = "";
            url.password = "";
            for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "[redacted]");
            url.hash = "";
            return url.toString();
        } catch { return "[invalid URL]"; }
    });
}
