export function slugify(value: string): string {
    const slug = value
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60)
        .replace(/-+$/g, "");
    return slug || "untitled";
}

export function uniqueSlug(title: string, taken: Set<string>, id: string): string {
    const base = slugify(title);
    if (!taken.has(base)) return base;
    return `${base}-${id.slice(0, 6)}`;
}

export function humanizeSlug(slug: string): string {
    const words = slug.replace(/-+/g, " ").trim();
    return words ? words[0].toUpperCase() + words.slice(1) : "Untitled";
}
