import { describe, it, expect } from 'vitest';
import { chunkMarkdown } from '../src/chunker/markdown.js';
import { chunkHtml } from '../src/chunker/html.js';
import { chunkPlain } from '../src/chunker/plain.js';
import { detectFormat, chunk } from '../src/chunker/index.js';

describe('chunkMarkdown', () => {
    it('extracts frontmatter as a separate chunk', () => {
        const md = '---\ntitle: Test\ntags: [a, b]\n---\n\n# Heading\n\nParagraph here.';
        const chunks = chunkMarkdown(md, 0, 5000);
        expect(chunks[0].chunk_type).toBe('frontmatter');
        expect(chunks[0].content).toContain('title: Test');
    });

    it('splits by headings and preserves heading context', () => {
        const md =
            '# Title\n\nIntro paragraph.\n\n## Section A\n\nContent A.\n\n## Section B\n\nContent B.';
        const chunks = chunkMarkdown(md, 0, 5000);

        const headings = chunks.filter((c) => c.chunk_type === 'heading');
        expect(headings).toHaveLength(3);
        expect(headings[0].heading).toBe('Title');
        expect(headings[1].heading).toBe('Section A');

        const contentA = chunks.find((c) => c.content === 'Content A.');
        expect(contentA).toBeDefined();
        expect(contentA!.heading).toBe('Section A');
    });

    it('preserves code blocks as atomic chunks', () => {
        const md = '# Code Example\n\n```python\ndef foo():\n    return 42\n```\n\nAfter code.';
        const chunks = chunkMarkdown(md, 0, 5000);

        const codeChunk = chunks.find((c) => c.chunk_type === 'code');
        expect(codeChunk).toBeDefined();
        expect(codeChunk!.content).toContain('def foo()');
        expect(codeChunk!.content).toContain('```python');
    });

    it('detects lists', () => {
        const md = '# Lists\n\n- Item one\n- Item two\n- Item three';
        const chunks = chunkMarkdown(md, 0, 5000);
        const list = chunks.find((c) => c.chunk_type === 'list');
        expect(list).toBeDefined();
        expect(list!.content).toContain('Item one');
    });

    it('detects blockquotes', () => {
        const md = '# Quote\n\n> This is a blockquote\n> spanning multiple lines.';
        const chunks = chunkMarkdown(md, 0, 5000);
        const bq = chunks.find((c) => c.chunk_type === 'blockquote');
        expect(bq).toBeDefined();
    });

    it('detects tables', () => {
        const md = '# Data\n\n| Col A | Col B |\n|-------|-------|\n| 1 | 2 |\n| 3 | 4 |';
        const chunks = chunkMarkdown(md, 0, 5000);
        const table = chunks.find((c) => c.chunk_type === 'table');
        expect(table).toBeDefined();
    });

    it('merges tiny chunks below minTokens', () => {
        const md = '# Heading\n\nA.\n\nB.\n\nC.';
        const withMerge = chunkMarkdown(md, 200, 5000);
        const withoutMerge = chunkMarkdown(md, 0, 5000);

        /** With merge, tiny paragraphs should be combined. */
        expect(withMerge.length).toBeLessThan(withoutMerge.length);
    });

    it('splits huge chunks at sentence boundaries', () => {
        const sentences = Array.from(
            { length: 50 },
            (_, i) => `Sentence number ${i} with enough words to have some tokens.`,
        );
        const md = '# Big\n\n' + sentences.join(' ');
        const chunks = chunkMarkdown(md, 0, 100);

        /** Should produce multiple paragraph chunks from the split. */
        const paragraphs = chunks.filter((c) => c.chunk_type === 'paragraph');
        expect(paragraphs.length).toBeGreaterThan(1);
    });

    it('never splits code blocks even when huge', () => {
        const bigCode = '```\n' + 'x = 1\n'.repeat(500) + '```';
        const md = '# Code\n\n' + bigCode;
        const chunks = chunkMarkdown(md, 0, 10);

        const codeChunks = chunks.filter((c) => c.chunk_type === 'code');
        expect(codeChunks).toHaveLength(1);
    });
});

describe('chunkHtml', () => {
    it('converts headings and paragraphs', () => {
        const html = '<h1>Title</h1><p>Content here.</p><h2>Section</h2><p>More content.</p>';
        const chunks = chunkHtml(html, 0, 5000);

        const headings = chunks.filter((c) => c.chunk_type === 'heading');
        expect(headings.length).toBeGreaterThanOrEqual(2);
    });

    it('converts code blocks', () => {
        const html = '<pre><code>console.log(42)</code></pre>';
        const chunks = chunkHtml(html, 0, 5000);
        const code = chunks.find((c) => c.chunk_type === 'code');
        expect(code).toBeDefined();
        expect(code!.content).toContain('console.log(42)');
    });

    it('converts lists', () => {
        const html = '<h2>Items</h2><ul><li>Apple</li><li>Banana</li></ul>';
        const chunks = chunkHtml(html, 0, 5000);
        const list = chunks.find((c) => c.chunk_type === 'list');
        expect(list).toBeDefined();
        expect(list!.content).toContain('Apple');
    });
});

describe('chunkPlain', () => {
    it('splits by paragraph boundaries', () => {
        const text =
            'First paragraph with content.\n\nSecond paragraph with content.\n\nThird paragraph with content.';
        const chunks = chunkPlain(text, 0, 5000);
        expect(chunks.length).toBeGreaterThanOrEqual(1);
        expect(chunks.every((c) => c.chunk_type === 'paragraph')).toBe(true);
    });

    it('merges tiny paragraphs', () => {
        const text = 'A.\n\nB.\n\nC.';
        const merged = chunkPlain(text, 200, 5000);
        const unmerged = chunkPlain(text, 0, 5000);
        expect(merged.length).toBeLessThanOrEqual(unmerged.length);
    });
});

describe('detectFormat', () => {
    it('detects markdown by headings', () => {
        expect(detectFormat('# Hello\n\nWorld')).toBe('markdown');
    });

    it('detects markdown by code fences', () => {
        expect(detectFormat('```js\nconst x = 1\n```')).toBe('markdown');
    });

    it('detects markdown by frontmatter', () => {
        expect(detectFormat('---\ntitle: Test\n---\n\nContent')).toBe('markdown');
    });

    it('detects HTML by doctype', () => {
        expect(detectFormat('<!DOCTYPE html><html><body>Hello</body></html>')).toBe('html');
    });

    it('defaults to plain text', () => {
        expect(detectFormat('Just some plain text without any special formatting.')).toBe('plain');
    });
});

describe('chunk router', () => {
    it('produces Chunk objects with IDs and token counts', () => {
        const content = '# Test\n\nA paragraph with content.';
        const chunks = chunk(content, 'test-source-id');

        expect(chunks.length).toBeGreaterThan(0);
        for (const c of chunks) {
            expect(c.id).toBeTruthy();
            expect(c.source_id).toBe('test-source-id');
            expect(c.content_hash).toBeTruthy();
            expect(c.position).toBeGreaterThanOrEqual(0);
            expect(c.token_count).toBeGreaterThan(0);
        }
    });
});
