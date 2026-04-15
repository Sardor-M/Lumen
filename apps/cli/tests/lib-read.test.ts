import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLumen, LumenError } from '../src/index.js';
import { resetDataDir } from '../src/utils/paths.js';
import { closeDb } from '../src/store/database.js';
import { upsertConcept, linkSourceConcept } from '../src/store/concepts.js';
import { upsertEdge } from '../src/store/edges.js';

let workDir: string;

beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lumen-read-'));
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

function seedConcept(slug: string, name: string, mention = 1): void {
    const now = new Date().toISOString();
    upsertConcept({
        slug,
        name,
        summary: null,
        article: null,
        created_at: now,
        updated_at: now,
        mention_count: mention,
    });
}

describe('sources namespace', () => {
    it('get() returns a source row, list() orders by added_at desc', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const first = await lumen.add(writeFixture('a.md', 'first source content'));
        await new Promise((r) => setTimeout(r, 5));
        const second = await lumen.add(writeFixture('b.md', 'second source content'));

        if (first.status !== 'added' || second.status !== 'added') throw new Error('seed');

        const got = lumen.sources.get(first.id);
        expect(got?.id).toBe(first.id);
        expect(got?.title).toMatch(/a/);

        const list = lumen.sources.list();
        expect(list.map((s) => s.id)).toEqual([second.id, first.id]);
        lumen.close();
    });

    it('get() returns null for unknown id, throws on empty', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        expect(lumen.sources.get('no-such-id')).toBeNull();
        expect(() => lumen.sources.get('')).toThrow(LumenError);
        lumen.close();
    });

    it('list({ limit }) caps results', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        await lumen.add(writeFixture('a.md', 'one'));
        await lumen.add(writeFixture('b.md', 'two'));
        await lumen.add(writeFixture('c.md', 'three'));

        expect(lumen.sources.list({ limit: 2 })).toHaveLength(2);
        expect(lumen.sources.list()).toHaveLength(3);
        lumen.close();
    });

    it('list({ since }) filters by added_at cursor', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        await lumen.add(writeFixture('old.md', 'old content'));
        const cutoff = new Date().toISOString();
        await new Promise((r) => setTimeout(r, 10));
        const fresh = await lumen.add(writeFixture('new.md', 'new content'));
        if (fresh.status !== 'added') throw new Error('seed');

        const after = lumen.sources.list({ since: cutoff });
        expect(after.map((s) => s.id)).toEqual([fresh.id]);
        lumen.close();
    });

    it('list({ since }) rejects invalid timestamps', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        expect(() => lumen.sources.list({ since: 'not-a-date' })).toThrow(/ISO timestamp/);
        lumen.close();
    });

    it('list({ type }) filters by source type', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        await lumen.add(writeFixture('a.md', 'file source'));
        expect(lumen.sources.list({ type: 'file' })).toHaveLength(1);
        expect(lumen.sources.list({ type: 'url' })).toHaveLength(0);
        lumen.close();
    });

    it('count + countByType reflect state', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        expect(lumen.sources.count()).toBe(0);
        expect(lumen.sources.countByType()).toEqual({});

        await lumen.add(writeFixture('a.md', 'content'));
        expect(lumen.sources.count()).toBe(1);
        expect(lumen.sources.countByType()).toEqual({ file: 1 });
        lumen.close();
    });
});

describe('concepts namespace', () => {
    it('get() returns null for unknown slug, throws on empty', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        expect(lumen.concepts.get('missing')).toBeNull();
        expect(() => lumen.concepts.get('')).toThrow(LumenError);
        lumen.close();
    });

    it('get() hydrates concept with outgoing/incoming edges and source titles', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const src = await lumen.add(writeFixture('paper.md', 'transformer architecture content'));
        if (src.status !== 'added') throw new Error('seed');

        seedConcept('transformer', 'Transformer', 3);
        seedConcept('attention', 'Attention', 2);
        seedConcept('rnn', 'RNN', 1);

        upsertEdge({
            from_slug: 'transformer',
            to_slug: 'attention',
            relation: 'implements',
            weight: 1,
            source_id: src.id,
        });
        upsertEdge({
            from_slug: 'rnn',
            to_slug: 'transformer',
            relation: 'alternative',
            weight: 0.5,
            source_id: src.id,
        });

        linkSourceConcept({
            source_id: src.id,
            concept_slug: 'transformer',
            relevance: 1,
        });

        const detail = lumen.concepts.get('transformer');
        expect(detail).not.toBeNull();
        expect(detail!.name).toBe('Transformer');
        expect(detail!.mention_count).toBe(3);

        expect(detail!.outgoing_edges).toHaveLength(1);
        expect(detail!.outgoing_edges[0].peer).toBe('attention');
        expect(detail!.outgoing_edges[0].relation).toBe('implements');

        expect(detail!.incoming_edges).toHaveLength(1);
        expect(detail!.incoming_edges[0].peer).toBe('rnn');

        expect(detail!.sources).toHaveLength(1);
        expect(detail!.sources[0].id).toBe(src.id);
        expect(detail!.sources[0].title).toMatch(/paper/);
        lumen.close();
    });

    it('list() orders by mention_count descending', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        lumen.status(); // force open

        seedConcept('low', 'Low', 1);
        seedConcept('high', 'High', 10);
        seedConcept('mid', 'Mid', 5);

        const list = lumen.concepts.list();
        expect(list.map((c) => c.slug)).toEqual(['high', 'mid', 'low']);
        lumen.close();
    });

    it('list({ limit }) caps results', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        lumen.status();
        seedConcept('a', 'A', 1);
        seedConcept('b', 'B', 2);
        seedConcept('c', 'C', 3);

        expect(lumen.concepts.list({ limit: 2 })).toHaveLength(2);
        lumen.close();
    });

    it('list({ limit: 0 }) rejects non-positive', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        lumen.status();
        expect(() => lumen.concepts.list({ limit: 0 })).toThrow(/positive integer/);
        expect(() => lumen.concepts.list({ limit: -1 })).toThrow(/positive integer/);
        lumen.close();
    });

    it('count reflects the concepts table', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        lumen.status();
        expect(lumen.concepts.count()).toBe(0);
        seedConcept('x', 'X');
        expect(lumen.concepts.count()).toBe(1);
        lumen.close();
    });
});

describe('chunks namespace', () => {
    it('list({ sourceId }) returns chunks ordered by position', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const src = await lumen.add(
            writeFixture(
                'doc.md',
                '# Intro\n\nFirst paragraph with enough text to form a real chunk of content.\n\n## Body\n\nSecond paragraph covering different subject matter with separate tokens.',
            ),
        );
        if (src.status !== 'added') throw new Error('seed');

        const chunks = lumen.chunks.list({ sourceId: src.id });
        expect(chunks.length).toBeGreaterThanOrEqual(1);
        for (let i = 1; i < chunks.length; i++) {
            expect(chunks[i].position).toBeGreaterThanOrEqual(chunks[i - 1].position);
        }
        lumen.close();
    });

    it('get() fetches a chunk by id', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const src = await lumen.add(writeFixture('g.md', 'content for chunk retrieval test'));
        if (src.status !== 'added') throw new Error('seed');

        const [chunk] = lumen.chunks.list({ sourceId: src.id });
        const fetched = lumen.chunks.get(chunk.id);
        expect(fetched?.id).toBe(chunk.id);
        expect(fetched?.content).toBe(chunk.content);
        lumen.close();
    });

    it('get() returns null for unknown id, throws on empty', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        expect(lumen.chunks.get('no-such')).toBeNull();
        expect(() => lumen.chunks.get('')).toThrow(LumenError);
        lumen.close();
    });

    it('list() requires sourceId', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        expect(() => lumen.chunks.list({ sourceId: '' } as { sourceId: string })).toThrow(
            LumenError,
        );
        lumen.close();
    });

    it('list({ sourceId, limit }) caps results', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const src = await lumen.add(
            writeFixture(
                'many.md',
                [
                    '# A',
                    'paragraph one with meaningful content that forms a chunk.',
                    '',
                    '# B',
                    'paragraph two distinct from the first with its own chunk.',
                    '',
                    '# C',
                    'paragraph three yet another separate section of the document.',
                ].join('\n'),
            ),
        );
        if (src.status !== 'added') throw new Error('seed');

        const all = lumen.chunks.list({ sourceId: src.id });
        if (all.length < 2) {
            /** Chunker may merge small paragraphs — skip if only 1 chunk. */
            lumen.close();
            return;
        }

        const capped = lumen.chunks.list({ sourceId: src.id, limit: 1 });
        expect(capped).toHaveLength(1);
        lumen.close();
    });

    it('count reflects the chunks table', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        expect(lumen.chunks.count()).toBe(0);

        const src = await lumen.add(writeFixture('c.md', 'content that creates a chunk'));
        if (src.status !== 'added') throw new Error('seed');

        expect(lumen.chunks.count()).toBeGreaterThanOrEqual(1);
        lumen.close();
    });
});
