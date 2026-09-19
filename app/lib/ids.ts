/** Filename-safe slug, matching the Healthy Canyons pipeline's slugify. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Sanitize a name for use in a zip entry path (same as the pipeline). */
export function sanitizeFileName(name: string): string {
  return name.replace(/[\/\\:*?"<>|]/g, "-");
}

/** Deck/project ids: short, url-safe, lowercase. */
export function makeId(label: string): string {
  const slug = slugify(label).slice(0, 40);
  return slug || `deck-${Date.now().toString(36)}`;
}

/** Parse a ;- or ·-separated alt-names cell into a list. */
export function parseAltNames(value: string | undefined | null): string[] {
  if (!value) return [];
  return value
    .split(/[;·\n]|, (?=[A-Z(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function formatAltNames(names: string[]): string {
  return names.join("; ");
}
