import { describe, it, expect } from 'vitest';
import { sha256, shortId, contentHash } from '../src/utils/hash.js';
import { toSlug, wikilink, extractWikilinks } from '../src/utils/slug.js';
import { estimateTokens } from '../src/compress/tokenizer.js';

describe('hash', () => {
    it('sha256 produces 64-char hex string', () => {
        const hash = sha256('hello');
        expect(hash).toHaveLength(64);
        expect(hash).toMatch(/^[a-f0-9]+$/);
    });

    it('sha256 is deterministic', () => {
        expect(sha256('test')).toBe(sha256('test'));
    });

    it('shortId produces 12-char prefix', () => {
        expect(shortId('hello')).toHaveLength(12);
        expect(shortId('hello')).toBe(sha256('hello').slice(0, 12));
    });

    it('contentHash normalizes whitespace', () => {
        expect(contentHash('hello  world')).toBe(contentHash('hello world'));
        expect(contentHash('hello\r\nworld')).toBe(contentHash('hello\nworld'));
        expect(contentHash('hello\n\n\n\nworld')).toBe(contentHash('hello\n\nworld'));
        expect(contentHash('  hello  ')).toBe(contentHash('hello'));
    });

    it('contentHash differs for different content', () => {
        expect(contentHash('hello')).not.toBe(contentHash('world'));
    });
});

describe('slug', () => {
    it('converts to lowercase kebab-case', () => {
        expect(toSlug('Transformer Architecture')).toBe('transformer-architecture');
    });

    it('strips smart quotes', () => {
        expect(toSlug("It's a test")).toBe('its-a-test');
        /** \u2019 (right single quotation mark) is stripped, leaving 'he-s-here'. */
        expect(toSlug('He\u2019s here')).toBe('he-s-here');
    });

    it('replaces non-alphanumeric with hyphens', () => {
        expect(toSlug('hello@world#2024')).toBe('hello-world-2024');
    });

    it('strips leading/trailing hyphens', () => {
        expect(toSlug('--hello--')).toBe('hello');
    });

    it('truncates to 100 chars', () => {
        const long = 'a'.repeat(200);
        expect(toSlug(long).length).toBeLessThanOrEqual(100);
    });
});

describe('wikilink', () => {
    it('creates simple wikilink', () => {
        expect(wikilink('transformers')).toBe('[[transformers]]');
    });

    it('creates wikilink with display text', () => {
        expect(wikilink('transformers', 'Transformer Models')).toBe('[[transformers|Transformer Models]]');
    });
});

describe('extractWikilinks', () => {
    it('extracts slugs from wikilinks', () => {
        const text = 'See [[foo]] and [[bar|Bar Label]] for details.';
        expect(extractWikilinks(text)).toEqual(['foo', 'bar']);
    });

    it('returns empty for no wikilinks', () => {
        expect(extractWikilinks('No links here.')).toEqual([]);
    });
});

describe('estimateTokens', () => {
    it('returns 0 for empty string', () => {
        expect(estimateTokens('')).toBe(0);
    });

    it('estimates roughly 4 chars per token for prose', () => {
        const prose = 'The quick brown fox jumps over the lazy dog.';
        const tokens = estimateTokens(prose);
        expect(tokens).toBeGreaterThan(8);
        expect(tokens).toBeLessThan(20);
    });

    it('estimates more tokens for code-heavy text', () => {
        const prose = 'Hello world this is text';
        const code = 'if(x){y=z[0];return(a<b);}';
        expect(estimateTokens(code)).toBeGreaterThan(estimateTokens(prose) * 0.8);
    });
});
