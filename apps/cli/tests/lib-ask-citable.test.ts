import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Mock the LLM client BEFORE importing anything that loads `lib/ask.js`.
 * `chatJson` is what the citable ask() calls; `chat` is mocked too so any
 * other code paths that touch it during the test stay deterministic.
 *
 * Each test sets `nextResponse` to control what `chatJson` returns.
 */
let nextResponse: unknown = null;
let chatJsonCalls = 0;

vi.mock('../src/llm/client.js', () => ({
    chat: async () => {
        throw new Error('chat() should not be called by the citable ask flow');
    },
    chatJson: async () => {
        chatJsonCalls++;
        return nextResponse;
    },
}));

import { createLumen } from '../src/index.js';
import { resetDataDir } from '../src/utils/paths.js';
import { closeDb } from '../src/store/database.js';

let workDir: string;
const savedAnthropic = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lumen-ask-'));
    /** Inject a key so the API-key guard passes — `chatJson` is mocked
     *  so the value never reaches a real provider. */
    process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
    nextResponse = null;
    chatJsonCalls = 0;
});

afterEach(() => {
    try {
        closeDb();
    } catch {
        /** Already closed. */
    }
    resetDataDir();
    rmSync(workDir, { recursive: true, force: true });
    if (savedAnthropic) process.env.ANTHROPIC_API_KEY = savedAnthropic;
    else delete process.env.ANTHROPIC_API_KEY;
});

function writeFixture(name: string, content: string): string {
    const path = join(workDir, name);
    writeFileSync(path, content, 'utf-8');
    return path;
}

describe('ask() — no-evidence short-circuit', () => {
    it('returns verdict=no_evidence and skips the LLM when retrieval is empty', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const result = await lumen.ask({ question: 'what is attention?' });

        expect(result.found).toBe(false);
        expect(result.verdict).toBe('no_evidence');
        expect(result.answer).toBe('');
        expect(result.citations).toEqual([]);
        expect(result.sources).toEqual([]);
        expect(chatJsonCalls).toBe(0);
        lumen.close();
    });
});

describe('ask() — happy path', () => {
    it('returns answer with citations resolved from aliases', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const path = writeFixture(
            'attn.md',
            'Self-attention computes a weighted sum over all positions in the input sequence. The weights come from a softmax over query-key dot products.',
        );
        const added = await lumen.add(path);
        if (added.status !== 'added') throw new Error('seed failed');

        nextResponse = {
            verdict: 'answered',
            answer: 'Self-attention is a weighted sum over all input positions [1].',
            citations: [
                {
                    marker: '1',
                    chunk_id: 'C1',
                    quote: 'Self-attention computes a weighted sum',
                },
            ],
        };

        const result = await lumen.ask({ question: 'attention' });
        expect(chatJsonCalls).toBe(1);
        expect(result.found).toBe(true);
        expect(result.verdict).toBe('answered');
        expect(result.answer).toMatch(/\[1\]/);
        expect(result.citations).toHaveLength(1);
        expect(result.citations[0].marker).toBe('1');
        expect(result.citations[0].chunk_id).not.toBe('C1');
        /** The resolved chunk_id should be a real ID present in `sources`. */
        expect(result.sources.map((s) => s.source_id)).toContain(added.id);
        expect(result.citations[0].source_id).toBe(added.id);
        expect(result.citations[0].source_title).toMatch(/attn/);
        expect(result.citations[0].quote).toMatch(/weighted sum/);
        expect(result.sources.length).toBeGreaterThan(0);
        lumen.close();
    });
});

describe('ask() — hallucinated chunk_id', () => {
    it('drops citations referencing aliases not in the prompt', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        await lumen.add(
            writeFixture(
                'note.md',
                'Transformers introduced self-attention. Batch normalization stabilizes training.',
            ),
        );

        nextResponse = {
            verdict: 'answered',
            answer: 'Transformers use self-attention [1] and rely on batch norm [2].',
            citations: [
                { marker: '1', chunk_id: 'C1', quote: 'Transformers introduced self-attention' },
                { marker: '2', chunk_id: 'C99', quote: 'never appeared in any chunk' },
            ],
        };

        const result = await lumen.ask({ question: 'transformers' });
        expect(result.citations).toHaveLength(1);
        expect(result.citations[0].marker).toBe('1');
        /** The answer still references [2] but no citation backs it →
         *  verdict downgraded to 'uncertain' so callers don't over-trust. */
        expect(result.verdict).toBe('uncertain');
        lumen.close();
    });
});

describe('ask() — verdict propagation', () => {
    it('passes through a "partial" verdict from the LLM', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        await lumen.add(
            writeFixture('p.md', 'Convolutional layers extract local features from images.'),
        );

        nextResponse = {
            verdict: 'partial',
            answer: 'CNNs extract local features [1]; pooling is inferred but not stated.',
            citations: [
                {
                    marker: '1',
                    chunk_id: 'C1',
                    quote: 'Convolutional layers extract local features',
                },
            ],
        };

        const result = await lumen.ask({ question: 'convolutional' });
        expect(result.verdict).toBe('partial');
        lumen.close();
    });

    it('coerces an unknown verdict to "uncertain"', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        await lumen.add(
            writeFixture('q.md', 'RLHF fine-tunes language models with human preferences.'),
        );

        nextResponse = {
            verdict: 'definitely_correct',
            answer: 'RLHF uses human preferences [1].',
            citations: [
                {
                    marker: '1',
                    chunk_id: 'C1',
                    quote: 'RLHF fine-tunes language models with human preferences',
                },
            ],
        };

        const result = await lumen.ask({ question: 'rlhf' });
        expect(result.verdict).toBe('uncertain');
        lumen.close();
    });
});

describe('ask() — malformed responses', () => {
    it('uses chunk content as fallback quote when the LLM omits it', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        await lumen.add(
            writeFixture('m.md', 'Diffusion models learn to reverse a noising process.'),
        );

        nextResponse = {
            verdict: 'answered',
            answer: 'Diffusion models reverse noise [1].',
            citations: [{ marker: '1', chunk_id: 'C1' /** no quote */ }],
        };

        const result = await lumen.ask({ question: 'diffusion' });
        expect(result.citations).toHaveLength(1);
        expect(result.citations[0].quote.length).toBeGreaterThan(0);
        lumen.close();
    });

    it('returns empty answer + uncertain when the LLM returns nothing usable', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        await lumen.add(
            writeFixture('z.md', 'lumen knowledge graph compiles articles into concepts.'),
        );

        nextResponse = {};

        const result = await lumen.ask({ question: 'lumen' });
        expect(result.found).toBe(true);
        expect(result.answer).toBe('');
        expect(result.verdict).toBe('uncertain');
        expect(result.citations).toEqual([]);
        lumen.close();
    });

    it('treats a non-array citations field as empty', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        await lumen.add(writeFixture('n.md', 'Mamba uses selective state-space models.'));

        nextResponse = { verdict: 'answered', answer: 'It uses SSMs.', citations: 'not-an-array' };
        const result = await lumen.ask({ question: 'mamba' });
        expect(result.citations).toEqual([]);
        lumen.close();
    });
});

describe('ask() — guards', () => {
    it('still throws on empty question', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        await expect(lumen.ask({ question: '' })).rejects.toThrow(/non-empty/);
        lumen.close();
    });
});
