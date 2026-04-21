import { describe, it, expect } from 'vitest';
import { compressStructural } from '../src/compress/structural.js';
import { compressDedup } from '../src/compress/dedup.js';
import { compressExtractive } from '../src/compress/extractive.js';
import { compress } from '../src/compress/pipeline.js';
import { estimateTokens } from '../src/compress/tokenizer.js';

describe('estimateTokens', () => {
    it('returns 0 for empty string', () => {
        expect(estimateTokens('')).toBe(0);
    });

    it('estimates prose at roughly 4 chars per token', () => {
        const prose =
            'The transformer architecture uses self-attention mechanisms to process sequences.';
        const tokens = estimateTokens(prose);
        expect(tokens).toBeGreaterThan(10);
        expect(tokens).toBeLessThan(30);
    });

    it('estimates code-heavy text with a lower chars-per-token rate', () => {
        const code = 'function foo(bar: string[]) { return bar.map((x) => x.trim()); }';
        const prose = 'A simple function that trims all strings in an array and returns them.';
        const codeTokens = estimateTokens(code);
        const proseTokens = estimateTokens(prose);
        expect(codeTokens / code.length).toBeGreaterThanOrEqual(proseTokens / prose.length - 0.1);
    });
});

describe('compressStructural', () => {
    it('preserves headings', () => {
        const input = '# Title\n\nSome content.\n\n## Section\n\nMore content.';
        const result = compressStructural(input);
        expect(result).toContain('# Title');
        expect(result).toContain('## Section');
    });

    it('preserves code blocks intact', () => {
        const input = '# Code\n\n```typescript\nconst x = 1;\nconst y = 2;\n```\n\nAfter code.';
        const result = compressStructural(input);
        expect(result).toContain('const x = 1;');
        expect(result).toContain('const y = 2;');
    });

    it('collapses lists longer than 5 items', () => {
        const items = Array.from({ length: 10 }, (_, i) => `- Item ${i + 1}`).join('\n');
        const input = `# List\n\n${items}\n\nAfter list.`;
        const result = compressStructural(input);
        expect(result).toContain('- Item 1');
        expect(result).toContain('- Item 5');
        expect(result).not.toContain('- Item 6');
        expect(result).toContain('5 more items omitted');
    });

    it('keeps short lists intact', () => {
        const input = '- One\n- Two\n- Three';
        const result = compressStructural(input);
        expect(result).toContain('- One');
        expect(result).toContain('- Three');
        expect(result).not.toContain('omitted');
    });
});

describe('compressDedup', () => {
    it('removes near-duplicate sentences', () => {
        const input =
            'The transformer uses attention. ' +
            'The transformer utilizes attention mechanisms. ' +
            'Completely different topic about databases.';
        const result = compressDedup(input, 0.6);
        const sentences = result.split(/[.!?]\s*/).filter(Boolean);
        expect(sentences.length).toBeLessThan(4);
    });

    it('keeps distinct sentences', () => {
        const input =
            'Transformers process sequences in parallel. ' +
            'MongoDB stores documents in BSON format. ' +
            'PageRank measures node importance in graphs.';
        const result = compressDedup(input);
        expect(result).toContain('Transformers');
        expect(result).toContain('MongoDB');
        expect(result).toContain('PageRank');
    });

    it('returns original when only one sentence', () => {
        const input = 'Just one sentence here.';
        expect(compressDedup(input)).toBe(input);
    });
});

describe('compressExtractive', () => {
    it('keeps sentences with high term frequency', () => {
        const sentences = [
            'Attention is the core mechanism.',
            'Attention allows parallel processing.',
            'Attention replaces recurrence entirely.',
            'The weather is nice today.',
            'Databases store information.',
            'Attention mechanisms scale well.',
            'Random filler sentence here.',
        ];
        const input = sentences.join(' ');
        const result = compressExtractive(input, 0.5);
        expect(result).toContain('Attention');
        expect(result.length).toBeLessThan(input.length);
    });

    it('preserves first and last sentences via position boost', () => {
        const sentences = Array.from(
            { length: 10 },
            (_, i) => `Sentence number ${i + 1} about topic.`,
        );
        const input = sentences.join(' ');
        const result = compressExtractive(input, 0.4);
        expect(result).toContain('Sentence number 1');
    });

    it('returns original when 3 or fewer sentences', () => {
        const input = 'First. Second. Third.';
        expect(compressExtractive(input)).toBe(input);
    });
});

describe('compress pipeline', () => {
    it('produces output shorter than input', () => {
        const input = Array.from(
            { length: 20 },
            (_, i) => `This is sentence ${i + 1} about a knowledge graph topic.`,
        ).join(' ');
        const result = compress(input, 0.5);
        expect(result.compressedTokens).toBeLessThan(result.originalTokens);
        expect(result.ratio).toBeLessThan(1);
        expect(result.ratio).toBeGreaterThan(0);
    });

    it('tracks all three stages', () => {
        const input = Array.from(
            { length: 15 },
            (_, i) => `Statement ${i + 1} about compression algorithms.`,
        ).join(' ');
        const result = compress(input);
        expect(result.stages).toHaveLength(3);
        expect(result.stages.map((s) => s.name)).toEqual(['structural', 'dedup', 'extractive']);
    });

    it('returns ratio of 1 for very short text', () => {
        const result = compress('Hello world.');
        expect(result.ratio).toBeCloseTo(1, 1);
    });
});
