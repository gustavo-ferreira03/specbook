export const slugify = function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replaceAll(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 60)
    .replaceAll(/-+$/gu, "");
  return slug || "untitled";
};

export const uniqueSlug = function uniqueSlug(
  title: string,
  taken: Set<string>,
  id: string
): string {
  const base = slugify(title);
  if (!taken.has(base)) {
    return base;
  }
  return `${base}-${id.slice(0, 6)}`;
};

export const humanizeSlug = function humanizeSlug(slug: string): string {
  const words = slug.replaceAll(/-+/gu, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Untitled";
};
