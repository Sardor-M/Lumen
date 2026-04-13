/**
 * Near-duplicate sentence removal via Jaccard similarity.
 * Sentences with similarity above threshold to an earlier sentence are removed.
 */
export function compressDedup(text: string, threshold = 0.8): string {
    const sentences = text
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

    if (sentences.length <= 1) return text;

    const kept: string[] = [];
    const keptSets: Set<string>[] = [];

    for (const sentence of sentences) {
        const tokens = tokenize(sentence);
        const tokenSet = new Set(tokens);

        if (tokens.length < 3) {
            kept.push(sentence);
            keptSets.push(tokenSet);
            continue;
        }

        let isDuplicate = false;
        for (const existingSet of keptSets) {
            if (jaccard(tokenSet, existingSet) >= threshold) {
                isDuplicate = true;
                break;
            }
        }

        if (!isDuplicate) {
            kept.push(sentence);
            keptSets.push(tokenSet);
        }
    }

    return kept.join(' ');
}

function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2);
}

function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1;
    let intersection = 0;
    for (const item of a) {
        if (b.has(item)) intersection++;
    }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
}
