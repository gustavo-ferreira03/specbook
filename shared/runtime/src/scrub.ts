export function scrubJson<T>(value: T, scrub: (text: string) => string): T {
    if (typeof value === "string") return scrub(value) as T;
    if (Array.isArray(value)) return value.map((item) => scrubJson(item, scrub)) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubJson(item, scrub)])) as T;
    return value;
}

export function scrubJsonText(text: string, scrub: (text: string) => string): string {
    let value: unknown;
    try { value = JSON.parse(text); } catch { return scrub(text); }
    if (value === null || typeof value !== "object") return scrub(text);
    return JSON.stringify(scrubJson(value, scrub));
}
