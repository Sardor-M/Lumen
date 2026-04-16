import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Mock the LLM client BEFORE importing ask/compile so we can test the typed
 * error wrapping around provider + parse failures without hitting a real
 * API. Each test sets `nextChatJson` / `nextChatJsonError` to drive behavior.
 */
let nextChatJsonError: unknown = null;
let nextChatJsonValue: unknown = null;

vi.mock('../src/llm/client.js', () => ({
    chat: async () => {
        throw new Error('chat() unused in these tests');
    },
    chatJson: async () => {
        if (nextChatJsonError) throw nextChatJsonError;
        return nextChatJsonValue;
    },
}));

import { createLumen, LumenError } from '../src/index.js';
import { resetDataDir } from '../src/utils/paths.js';
import { closeDb } from '../src/store/database.js';

let workDir: string;
const savedAnthropic = process.env.ANTHROPIC_API_KEY;
const savedOpenRouter = process.env.OPENROUTER_API_KEY;

beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lumen-err-'));
    nextChatJsonError = null;
    nextChatJsonValue = null;
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
    if (savedOpenRouter) process.env.OPENROUTER_API_KEY = savedOpenRouter;
    else delete process.env.OPENROUTER_API_KEY;
});

function writeFixture(name: string, content: string): string {
    const path = join(workDir, name);
    writeFileSync(path, content, 'utf-8');
    return path;
}

describe('LumenErrorCode — MISSING_API_KEY', () => {
    beforeEach(() => {
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.OPENROUTER_API_KEY;
    });

    it('ask() throws MISSING_API_KEY when no key is configured', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        try {
            await lumen.ask({ question: 'anything' });
            expect.fail('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(LumenError);
            expect((err as LumenError).code).toBe('MISSING_API_KEY');
        }
        lumen.close();
    });

    it('compile() throws MISSING_API_KEY when no key is configured', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        try {
            await lumen.compile();
            expect.fail('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(LumenError);
            expect((err as LumenError).code).toBe('MISSING_API_KEY');
        }
        lumen.close();
    });
});

describe('LumenErrorCode — LLM_ERROR and LLM_PARSE_ERROR', () => {
    beforeEach(() => {
        process.env.ANTHROPIC_API_KEY = 'test-key';
    });

    it('ask() wraps provider failures as LLM_ERROR with cause preserved', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        await lumen.add(writeFixture('n.md', 'context for llm error test'));

        const providerFailure = new Error('429 rate limit');
        nextChatJsonError = providerFailure;

        try {
            await lumen.ask({ question: 'context' });
            expect.fail('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(LumenError);
            const le = err as LumenError;
            expect(le.code).toBe('LLM_ERROR');
            expect(le.hint).toMatch(/retry|network|api key/i);
            /** Native ES2022 `cause` carries the underlying provider error. */
            expect((le as unknown as { cause: unknown }).cause).toBe(providerFailure);
        }
        lumen.close();
    });

    it('ask() surfaces JSON-parse failures as LLM_PARSE_ERROR with a retry hint', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        await lumen.add(writeFixture('p.md', 'context for parse error test'));

        /** Mirrors the exact message thrown by `chatJson()` on bad output. */
        nextChatJsonError = new Error('LLM response is not valid JSON:\n<garbage>');

        try {
            await lumen.ask({ question: 'context' });
            expect.fail('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(LumenError);
            const le = err as LumenError;
            expect(le.code).toBe('LLM_PARSE_ERROR');
            expect(le.hint).toMatch(/retry/i);
        }
        lumen.close();
    });

    it('ask() does NOT wrap when the LLM returns a well-formed response', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        await lumen.add(writeFixture('ok.md', 'good context for the test'));

        nextChatJsonValue = {
            verdict: 'answered',
            answer: 'sure [1]',
            citations: [{ marker: '1', chunk_id: 'C1', quote: 'good context' }],
        };

        const result = await lumen.ask({ question: 'context' });
        expect(result.verdict).toBe('answered');
        lumen.close();
    });
});

describe('LumenErrorCode — INTERNAL', () => {
    it('is exposed as a valid code on the LumenErrorCode union', () => {
        /** Type-level assertion only — if someone removes INTERNAL from the
         *  union this file stops compiling. */
        const err = new LumenError('INTERNAL', 'invariant violation');
        expect(err.code).toBe('INTERNAL');
    });
});
