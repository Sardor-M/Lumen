import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLumen, LumenError } from '../src/index.js';
import { lumenRetriever, type LumenDocument } from '../src/adapters/langchain.js';
import { resetDataDir } from '../src/utils/paths.js';
import { closeDb } from '../src/store/database.js';

let workDir: string;

beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lumen-langchain-'));
});

afterEach(() => {
    try {
        closeDb();
    } catch {
        /** Already closed. */
    }
    resetDataDir();
    rmSync(workDir, { recursive: true, force: true });
});

function writeFixture(name: string, content: string): string {
    const path = join(workDir, name);
    writeFileSync(path, content, 'utf-8');
    return path;
}

describe('lumenRetriever — defaults', () => {
    it('creates a retriever with default limit=10 and mode=hybrid', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const r = lumenRetriever(lumen);
        expect(r.options.limit).toBe(10);
        expect(r.options.mode).toBe('hybrid');
        lumen.close();
    });

    it('respects custom limit and mode', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const r = lumenRetriever(lumen, { limit: 5, mode: 'bm25' });
        expect(r.options.limit).toBe(5);
        expect(r.options.mode).toBe('bm25');
        lumen.close();
    });
});

describe('lumenRetriever.invoke — document shape', () => {
    it('returns LumenDocument[] matching LangChain Document interface', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const path = writeFixture(
            'paper.md',
            'Graph neural networks propagate information along edges between nodes.',
        );
        await lumen.add(path);

        const r = lumenRetriever(lumen, { limit: 3 });
        const docs = await r.invoke('graph neural');
        expect(docs.length).toBeGreaterThan(0);

        const doc = docs[0];
        expect(typeof doc.pageContent).toBe('string');
        expect(doc.pageContent.length).toBeGreaterThan(0);
        expect(doc.metadata.chunk_id).toBeDefined();
        expect(doc.metadata.source_id).toBeDefined();
        expect(doc.metadata.source_title).toMatch(/paper/);
        expect(typeof doc.metadata.score).toBe('number');
        expect(doc.metadata.rank).toBe(1);
        expect(doc.id).toBe(doc.metadata.chunk_id);
        lumen.close();
    });

    it('returns empty array when nothing matches', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const r = lumenRetriever(lumen);
        const docs = await r.invoke('nonexistent topic xyz');
        expect(docs).toEqual([]);
        lumen.close();
    });

    it('throws LumenError on empty query', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const r = lumenRetriever(lumen);
        await expect(r.invoke('')).rejects.toThrow(LumenError);
        await expect(r.invoke('   ')).rejects.toThrow(LumenError);
        lumen.close();
    });
});

describe('lumenRetriever.batch', () => {
    it('runs multiple queries sequentially and returns matching arrays', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        await lumen.add(
            writeFixture(
                'mixed.md',
                'Transformers use attention. Convolutional networks use kernels. Both are neural architectures.',
            ),
        );

        const r = lumenRetriever(lumen, { limit: 2 });
        const results = await r.batch(['attention', 'kernels']);
        expect(results).toHaveLength(2);
        expect(results[0].length).toBeGreaterThan(0);
        expect(results[1].length).toBeGreaterThan(0);
        lumen.close();
    });

    it('handles an empty batch', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const r = lumenRetriever(lumen);
        const results = await r.batch([]);
        expect(results).toEqual([]);
        lumen.close();
    });
});

describe('lumenRetriever — mode selection', () => {
    it('bm25 mode returns results', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        await lumen.add(
            writeFixture('b.md', 'Dropout regularization prevents neural network overfitting.'),
        );
        const r = lumenRetriever(lumen, { mode: 'bm25' });
        const docs = await r.invoke('dropout');
        expect(docs.length).toBeGreaterThan(0);
        lumen.close();
    });

    it('tfidf mode returns results', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        /** TF-IDF needs multiple documents for non-zero IDF weighting. */
        await lumen.add(
            writeFixture('t.md', 'Batch normalization accelerates training of deep networks.'),
        );
        await lumen.add(
            writeFixture(
                'u.md',
                'Gradient descent converges slowly without proper learning rate scheduling.',
            ),
        );
        const r = lumenRetriever(lumen, { mode: 'tfidf' });
        const docs = await r.invoke('normalization');
        expect(docs.length).toBeGreaterThan(0);
        lumen.close();
    });
});
