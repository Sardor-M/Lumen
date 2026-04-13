/**
 * Fast cl100k_base token count approximation.
 * Average ratio is ~4 chars per token for English prose,
 * ~3.5 for code. We use a weighted heuristic.
 */
export function estimateTokens(text: string): number {
    if (!text) return 0;
    /** Code-heavy text has more tokens per char due to symbols. */
    const codeWeight = (text.match(/[{}();=<>[\]]/g)?.length ?? 0) / text.length;
    const charsPerToken = 4 - codeWeight * 1.5; // 4 for prose, ~2.5 for dense code
    return Math.ceil(text.length / charsPerToken);
}
