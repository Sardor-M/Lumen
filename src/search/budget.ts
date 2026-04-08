import { getChunk } from '../store/chunks.js';
import { estimateTokens } from '../compress/tokenizer.js';

type BudgetItem = {
    chunk_id: string;
    source_id: string;
    score: number;
};

type SelectedChunk = {
    chunk_id: string;
    source_id: string;
    content: string;
    score: number;
    token_count: number;
};

/**
 * Greedy selection by relevance density (score / token_count).
 * Fills a token budget with the highest-value-per-token chunks.
 */
export function selectByBudget(items: BudgetItem[], tokenBudget: number): SelectedChunk[] {
    /** Resolve chunk content and compute relevance density. */
    const candidates: (SelectedChunk & { density: number })[] = [];

    for (const item of items) {
        const chunk = getChunk(item.chunk_id);
        if (!chunk) continue;

        const tokens = chunk.token_count || estimateTokens(chunk.content);
        candidates.push({
            chunk_id: item.chunk_id,
            source_id: item.source_id,
            content: chunk.content,
            score: item.score,
            token_count: tokens,
            density: tokens > 0 ? item.score / tokens : 0,
        });
    }

    /** Sort by density (value per token), not raw score. */
    candidates.sort((a, b) => b.density - a.density);

    /** Greedily fill the budget. */
    const selected: SelectedChunk[] = [];
    let remaining = tokenBudget;

    for (const candidate of candidates) {
        if (candidate.token_count > remaining) continue;
        selected.push({
            chunk_id: candidate.chunk_id,
            source_id: candidate.source_id,
            content: candidate.content,
            score: candidate.score,
            token_count: candidate.token_count,
        });
        remaining -= candidate.token_count;
        if (remaining <= 0) break;
    }

    return selected;
}
