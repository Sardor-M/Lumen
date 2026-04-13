import { compressStructural } from './structural.js';
import { compressExtractive } from './extractive.js';
import { compressDedup } from './dedup.js';
import { estimateTokens } from './tokenizer.js';

type CompressionResult = {
    original: string;
    compressed: string;
    originalTokens: number;
    compressedTokens: number;
    ratio: number;
    stages: Array<{ name: string; tokensAfter: number }>;
};

/**
 * Run the full compression pipeline:
 * 1. Structural — preserve headings, collapse long lists
 * 2. Dedup — remove near-duplicate sentences
 * 3. Extractive — prune lowest-importance sentences
 */
export function compress(text: string, targetRatio = 0.5): CompressionResult {
    const originalTokens = estimateTokens(text);
    const stages: Array<{ name: string; tokensAfter: number }> = [];

    let current = text;

    current = compressStructural(current);
    stages.push({ name: 'structural', tokensAfter: estimateTokens(current) });

    current = compressDedup(current);
    stages.push({ name: 'dedup', tokensAfter: estimateTokens(current) });

    current = compressExtractive(current, targetRatio);
    stages.push({ name: 'extractive', tokensAfter: estimateTokens(current) });

    const compressedTokens = estimateTokens(current);

    return {
        original: text,
        compressed: current,
        originalTokens,
        compressedTokens,
        ratio: originalTokens > 0 ? compressedTokens / originalTokens : 1,
        stages,
    };
}
