export function toSlug(name: string): string {
    return name
        .toLowerCase()
        .replace(/['']/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 100);
}

export function wikilink(slug: string, display?: string): string {
    return display ? `[[${slug}|${display}]]` : `[[${slug}]]`;
}

export function extractWikilinks(text: string): string[] {
    const matches = text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g);
    return [...matches].map((m) => m[1]);
}
