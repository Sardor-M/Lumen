/**
 * Extractive compression: score sentences by term importance,
 * remove the lowest-scoring ones until within budget.
 */
export function compressExtractive(text: string, targetRatio = 0.6): string {
    const sentences = splitSentences(text);
    if (sentences.length <= 3) return text;

    const targetCount = Math.max(3, Math.ceil(sentences.length * targetRatio));
    if (sentences.length <= targetCount) return text;

    const tf = new Map<string, number>();
    for (const sentence of sentences) {
        for (const term of tokenize(sentence)) {
            tf.set(term, (tf.get(term) ?? 0) + 1);
        }
    }

    const scored = sentences.map((s, i) => {
        const terms = tokenize(s);
        if (terms.length === 0) return { text: s, score: 0, index: i };
        const avgTf = terms.reduce((sum, t) => sum + (tf.get(t) ?? 0), 0) / terms.length;
        const positionBoost = i < 3 || i >= sentences.length - 2 ? 1.5 : 1.0;
        return { text: s, score: avgTf * positionBoost, index: i };
    });

    const sorted = [...scored].sort((a, b) => b.score - a.score);
    const kept = sorted.slice(0, targetCount).sort((a, b) => a.index - b.index);

    return kept.map((s) => s.text).join(' ');
}

function splitSentences(text: string): string[] {
    return text
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2);
}
