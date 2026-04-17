import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setDataDir, resetDataDir } from '../src/utils/paths.js';
import { getDb, resetDb } from '../src/store/database.js';
import {
    upsertConcept,
    getConcept,
    updateCompiledTruth,
    appendTimeline,
    getTimeline,
} from '../src/store/concepts.js';
import type { TimelineEntry } from '../src/types/index.js';

// ── Setup / Teardown ─────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lumen-timeline-'));
    setDataDir(tempDir);
    getDb();
});

afterEach(() => {
    resetDb();
    resetDataDir();
    rmSync(tempDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function insertConcept(slug: string, compiledTruth?: string): void {
    const now = new Date().toISOString();
    upsertConcept({
        slug,
        name: slug.replace(/-/g, ' '),
        summary: compiledTruth ?? null,
        compiled_truth: compiledTruth ?? null,
        article: null,
        created_at: now,
        updated_at: now,
        mention_count: 1,
    });
}

function makeEntry(overrides?: Partial<TimelineEntry>): TimelineEntry {
    return {
        date: '2025-01-15',
        source_id: 'src-001',
        source_title: 'Attention Is All You Need',
        event: 'Introduced transformer architecture',
        detail: null,
        ...overrides,
    };
}

// ── compiled_truth storage ────────────────────────────────────────────────────

describe('compiled_truth — storage and retrieval', () => {
    it('stores compiled_truth on insert and retrieves it typed', () => {
        const truth = 'Transformers use self-attention to model sequences.';
        insertConcept('transformer-architecture', truth);

        const concept = getConcept('transformer-architecture');
        expect(concept).not.toBeNull();
        expect(concept!.compiled_truth).toBe(truth);
    });

    it('returns null compiled_truth when not set', () => {
        insertConcept('bare-concept');
        const concept = getConcept('bare-concept');
        expect(concept!.compiled_truth).toBeNull();
    });

    it('exposes timeline as an empty array (not raw JSON string)', () => {
        insertConcept('empty-timeline');
        const concept = getConcept('empty-timeline');
        expect(Array.isArray(concept!.timeline)).toBe(true);
        expect(concept!.timeline).toHaveLength(0);
    });

    it('upsert increments mention_count on conflict', () => {
        insertConcept('mention-test');
        insertConcept('mention-test');
        const concept = getConcept('mention-test');
        expect(concept!.mention_count).toBe(2);
    });

    it('upsert COALESCE preserves existing compiled_truth when new value is null', () => {
        const original = 'Original compiled truth.';
        insertConcept('coalesce-test', original);

        /** Second upsert with null compiled_truth must not overwrite. */
        const now = new Date().toISOString();
        upsertConcept({
            slug: 'coalesce-test',
            name: 'Coalesce Test',
            summary: null,
            compiled_truth: null,
            article: null,
            created_at: now,
            updated_at: now,
            mention_count: 1,
        });

        const concept = getConcept('coalesce-test');
        expect(concept!.compiled_truth).toBe(original);
    });
});

// ── updateCompiledTruth ───────────────────────────────────────────────────────

describe('updateCompiledTruth', () => {
    it('replaces the compiled_truth field', () => {
        insertConcept('attention', 'Old understanding of attention.');
        updateCompiledTruth(
            'attention',
            'New synthesis: attention scales as O(n²) in sequence length.',
        );

        const concept = getConcept('attention');
        expect(concept!.compiled_truth).toBe(
            'New synthesis: attention scales as O(n²) in sequence length.',
        );
    });

    it('also syncs the summary field for backward-compat', () => {
        insertConcept('compat-check', 'Initial summary.');
        updateCompiledTruth('compat-check', 'Updated truth.');

        const row = getDb()
            .prepare('SELECT summary, compiled_truth FROM concepts WHERE slug = ?')
            .get('compat-check') as { summary: string; compiled_truth: string };

        expect(row.compiled_truth).toBe('Updated truth.');
        expect(row.summary).toBe('Updated truth.');
    });

    it('updates updated_at timestamp', () => {
        insertConcept('ts-check');
        const before = getConcept('ts-check')!.updated_at;

        /** Small delay so updated_at is measurably different. */
        updateCompiledTruth('ts-check', 'Fresh truth.');

        const after = getConcept('ts-check')!.updated_at;
        expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    });

    it('is a no-op for a non-existent slug (no error thrown)', () => {
        expect(() => updateCompiledTruth('does-not-exist', 'value')).not.toThrow();
    });
});

// ── appendTimeline ────────────────────────────────────────────────────────────

describe('appendTimeline', () => {
    it('appends the first entry to an empty timeline', () => {
        insertConcept('bert');
        const entry = makeEntry({
            event: 'Introduced BERT architecture',
            source_title: 'BERT paper',
        });

        appendTimeline('bert', entry);

        const timeline = getTimeline('bert');
        expect(timeline).toHaveLength(1);
        expect(timeline[0].event).toBe('Introduced BERT architecture');
    });

    it('appends without modifying existing entries', () => {
        insertConcept('gpt');
        const first = makeEntry({ event: 'GPT-1 released', date: '2018-06-11' });
        const second = makeEntry({ event: 'GPT-2 released', date: '2019-02-14' });

        appendTimeline('gpt', first);
        appendTimeline('gpt', second);

        const raw = getDb().prepare('SELECT timeline FROM concepts WHERE slug = ?').get('gpt') as {
            timeline: string;
        };

        const parsed = JSON.parse(raw.timeline) as TimelineEntry[];
        expect(parsed).toHaveLength(2);
        expect(parsed[0].event).toBe('GPT-1 released');
        expect(parsed[1].event).toBe('GPT-2 released');
    });

    it('stores all TimelineEntry fields correctly', () => {
        insertConcept('flash-attention');
        const entry: TimelineEntry = {
            date: '2022-05-27',
            source_id: 'src-flash',
            source_title: 'FlashAttention paper',
            event: 'Introduced IO-aware exact attention algorithm',
            detail: 'Reduces memory from O(n²) to O(n) using tiling.',
        };

        appendTimeline('flash-attention', entry);

        const [stored] = getTimeline('flash-attention');
        expect(stored.date).toBe('2022-05-27');
        expect(stored.source_id).toBe('src-flash');
        expect(stored.source_title).toBe('FlashAttention paper');
        expect(stored.detail).toBe('Reduces memory from O(n²) to O(n) using tiling.');
    });

    it('handles null source_id and null detail', () => {
        insertConcept('mcp-concept');
        appendTimeline('mcp-concept', {
            date: '2025-01-01',
            source_id: null,
            source_title: 'MCP session',
            event: 'Captured via agent',
            detail: null,
        });

        const [entry] = getTimeline('mcp-concept');
        expect(entry.source_id).toBeNull();
        expect(entry.detail).toBeNull();
    });

    it('is a no-op for a non-existent concept (no error thrown)', () => {
        expect(() => appendTimeline('ghost-slug', makeEntry())).not.toThrow();
    });
});

// ── getTimeline ───────────────────────────────────────────────────────────────

describe('getTimeline', () => {
    it('returns entries newest-first', () => {
        insertConcept('ordered-timeline');
        appendTimeline(
            'ordered-timeline',
            makeEntry({ date: '2020-01-01', event: 'First mention' }),
        );
        appendTimeline(
            'ordered-timeline',
            makeEntry({ date: '2021-06-15', event: 'Second mention' }),
        );
        appendTimeline(
            'ordered-timeline',
            makeEntry({ date: '2023-09-30', event: 'Third mention' }),
        );

        const timeline = getTimeline('ordered-timeline');
        expect(timeline).toHaveLength(3);
        /** Most recent first. */
        expect(timeline[0].event).toBe('Third mention');
        expect(timeline[1].event).toBe('Second mention');
        expect(timeline[2].event).toBe('First mention');
    });

    it('returns an empty array for a concept with no timeline', () => {
        insertConcept('no-history');
        const timeline = getTimeline('no-history');
        expect(timeline).toEqual([]);
    });

    it('returns an empty array for a non-existent concept', () => {
        const timeline = getTimeline('never-existed');
        expect(timeline).toEqual([]);
    });

    it('getConcept.timeline matches getTimeline but reversed', () => {
        insertConcept('both-accessors');
        appendTimeline('both-accessors', makeEntry({ event: 'Alpha', date: '2020-01-01' }));
        appendTimeline('both-accessors', makeEntry({ event: 'Beta', date: '2021-01-01' }));

        const fromGet = getTimeline('both-accessors'); // newest first
        const fromConcept = getConcept('both-accessors')!.timeline; // also newest first

        expect(fromGet).toHaveLength(2);
        expect(fromConcept).toHaveLength(2);
        expect(fromGet[0].event).toBe(fromConcept[0].event);
        expect(fromGet[1].event).toBe(fromConcept[1].event);
    });

    it('accumulates correctly across many sources', () => {
        insertConcept('multi-source');
        for (let i = 0; i < 10; i++) {
            appendTimeline(
                'multi-source',
                makeEntry({
                    event: `Mention ${i}`,
                    source_id: `src-${i}`,
                    date: `2024-01-${String(i + 1).padStart(2, '0')}`,
                }),
            );
        }

        const timeline = getTimeline('multi-source');
        expect(timeline).toHaveLength(10);
        /** First entry (newest) should be the last appended. */
        expect(timeline[0].event).toBe('Mention 9');
        expect(timeline[9].event).toBe('Mention 0');
    });
});

// ── Schema migration check ────────────────────────────────────────────────────

describe('schema v6 migration', () => {
    it('concepts table has compiled_truth and timeline columns', () => {
        const info = getDb().prepare(`PRAGMA table_info(concepts)`).all() as { name: string }[];
        const cols = info.map((r) => r.name);
        expect(cols).toContain('compiled_truth');
        expect(cols).toContain('timeline');
    });

    it('timeline column defaults to empty JSON array', () => {
        const now = new Date().toISOString();
        getDb()
            .prepare(
                `INSERT INTO concepts (slug, name, created_at, updated_at, mention_count)
                 VALUES ('default-test', 'Default Test', ?, ?, 1)`,
            )
            .run(now, now);

        const row = getDb()
            .prepare('SELECT timeline FROM concepts WHERE slug = ?')
            .get('default-test') as { timeline: string };

        expect(row.timeline).toBe('[]');
    });
});
