import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setDataDir, resetDataDir } from '../src/utils/paths.js';
import { getDb, resetDb } from '../src/store/database.js';
import { upsertConcept } from '../src/store/concepts.js';
import { insertSource } from '../src/store/sources.js';
import { contentHash, shortId } from '../src/utils/hash.js';
import {
    addLink,
    addBackLink,
    removeLink,
    getLinksFrom,
    getBackLinks,
    countLinks,
    autoLinkFromCompiledTruth,
} from '../src/store/links.js';
import type { LinkType } from '../src/types/index.js';

// ── Setup / Teardown ─────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lumen-links-'));
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

function seedTwoConcepts(): void {
    insertConcept('transformer-architecture');
    insertConcept('self-attention');
}

/** Insert a minimal source row so source_id FK constraints are satisfied. */
function insertRealSource(id: string): void {
    const content = `source content for ${id}`;
    insertSource({
        id,
        title: `Source ${id}`,
        url: null,
        content,
        content_hash: contentHash(content),
        source_type: 'file',
        added_at: new Date().toISOString(),
        compiled_at: null,
        word_count: 4,
        language: null,
        metadata: null,
    });
}

// ── addLink ───────────────────────────────────────────────────────────────────

describe('addLink', () => {
    it('inserts a link row with correct fields', () => {
        seedTwoConcepts();
        /** source_id is null here; FK to sources is enforced so we skip it in unit tests. */
        addLink('transformer-architecture', 'self-attention', 'reference', 'Uses attention', null);

        const links = getLinksFrom('transformer-architecture');
        expect(links).toHaveLength(1);
        expect(links[0].from_slug).toBe('transformer-architecture');
        expect(links[0].to_slug).toBe('self-attention');
        expect(links[0].link_type).toBe('reference');
        expect(links[0].context).toBe('Uses attention');
        expect(links[0].source_id).toBeNull();
    });

    it('silently ignores duplicate (from, to, type) triples', () => {
        seedTwoConcepts();
        addLink('transformer-architecture', 'self-attention', 'reference');
        addLink('transformer-architecture', 'self-attention', 'reference'); // duplicate

        expect(countLinks()).toBe(1);
    });

    it('allows same pair with a different link_type', () => {
        seedTwoConcepts();
        addLink('transformer-architecture', 'self-attention', 'reference');
        addLink('transformer-architecture', 'self-attention', 'manual');

        expect(countLinks()).toBe(2);
    });

    it('defaults context and source_id to null', () => {
        seedTwoConcepts();
        addLink('transformer-architecture', 'self-attention', 'reference');

        const [link] = getLinksFrom('transformer-architecture');
        expect(link.context).toBeNull();
        expect(link.source_id).toBeNull();
    });

    it('sets created_at to a valid ISO timestamp', () => {
        seedTwoConcepts();
        addLink('transformer-architecture', 'self-attention', 'manual');

        const [link] = getLinksFrom('transformer-architecture');
        expect(() => new Date(link.created_at)).not.toThrow();
        expect(new Date(link.created_at).getFullYear()).toBeGreaterThanOrEqual(2024);
    });
});

// ── addBackLink ───────────────────────────────────────────────────────────────

describe('addBackLink', () => {
    it('creates a reference link AND a back-link in one call', () => {
        seedTwoConcepts();
        addBackLink('transformer-architecture', 'self-attention', 'Context snippet');

        /** Forward reference: transformer → attention */
        const forwardLinks = getLinksFrom('transformer-architecture');
        expect(forwardLinks).toHaveLength(1);
        expect(forwardLinks[0].link_type).toBe('reference');
        expect(forwardLinks[0].to_slug).toBe('self-attention');

        /** Back-link: attention → transformer */
        const backLinks = getLinksFrom('self-attention');
        expect(backLinks).toHaveLength(1);
        expect(backLinks[0].link_type).toBe('back-link');
        expect(backLinks[0].to_slug).toBe('transformer-architecture');
    });

    it('both sides share the same context snippet', () => {
        seedTwoConcepts();
        addBackLink('transformer-architecture', 'self-attention', 'Shared context');

        const ref = getLinksFrom('transformer-architecture', 'reference');
        const back = getLinksFrom('self-attention', 'back-link');

        expect(ref[0].context).toBe('Shared context');
        expect(back[0].context).toBe('Shared context');
    });

    it('creates exactly 2 rows in total', () => {
        seedTwoConcepts();
        addBackLink('transformer-architecture', 'self-attention');
        expect(countLinks()).toBe(2);
    });

    it('is idempotent — calling twice does not create extra rows', () => {
        seedTwoConcepts();
        addBackLink('transformer-architecture', 'self-attention', 'ctx');
        addBackLink('transformer-architecture', 'self-attention', 'ctx');
        expect(countLinks()).toBe(2); // INSERT OR IGNORE on both directions
    });
});

// ── removeLink ────────────────────────────────────────────────────────────────

describe('removeLink', () => {
    it('removes the specified link', () => {
        seedTwoConcepts();
        addLink('transformer-architecture', 'self-attention', 'manual');

        removeLink('transformer-architecture', 'self-attention', 'manual');

        expect(countLinks()).toBe(0);
    });

    it('does not remove links with a different type', () => {
        seedTwoConcepts();
        addLink('transformer-architecture', 'self-attention', 'reference');
        addLink('transformer-architecture', 'self-attention', 'manual');

        removeLink('transformer-architecture', 'self-attention', 'manual');

        expect(countLinks()).toBe(1);
        expect(getLinksFrom('transformer-architecture')[0].link_type).toBe('reference');
    });

    it('is a no-op when link does not exist (no error thrown)', () => {
        seedTwoConcepts();
        expect(() =>
            removeLink('transformer-architecture', 'self-attention', 'reference'),
        ).not.toThrow();
    });
});

// ── getLinksFrom ──────────────────────────────────────────────────────────────

describe('getLinksFrom', () => {
    it('returns all outgoing links for a concept', () => {
        insertConcept('bert');
        insertConcept('self-attention');
        insertConcept('transformer-architecture');

        addLink('bert', 'self-attention', 'reference');
        addLink('bert', 'transformer-architecture', 'manual');

        const links = getLinksFrom('bert');
        expect(links).toHaveLength(2);
        const targets = links.map((l) => l.to_slug).sort();
        expect(targets).toEqual(['self-attention', 'transformer-architecture'].sort());
    });

    it('returns empty array when concept has no outgoing links', () => {
        insertConcept('isolated');
        expect(getLinksFrom('isolated')).toEqual([]);
    });

    it('filters by link_type when provided', () => {
        insertConcept('gpt');
        insertConcept('self-attention');
        insertConcept('transformer-architecture');

        addLink('gpt', 'self-attention', 'reference');
        addLink('gpt', 'transformer-architecture', 'manual');

        const refs = getLinksFrom('gpt', 'reference');
        expect(refs).toHaveLength(1);
        expect(refs[0].to_slug).toBe('self-attention');

        const manuals = getLinksFrom('gpt', 'manual');
        expect(manuals).toHaveLength(1);
        expect(manuals[0].to_slug).toBe('transformer-architecture');

        /** Type with no matches. */
        expect(getLinksFrom('gpt', 'co-occurs')).toHaveLength(0);
    });

    it('returns links ordered by created_at DESC', () => {
        insertConcept('ordered-out');
        insertConcept('alpha');
        insertConcept('beta');

        addLink('ordered-out', 'alpha', 'reference');
        addLink('ordered-out', 'beta', 'reference');

        const links = getLinksFrom('ordered-out');
        /** Most recently inserted should be first. */
        expect(links[0].to_slug).toBe('beta');
        expect(links[1].to_slug).toBe('alpha');
    });
});

// ── getBackLinks ──────────────────────────────────────────────────────────────

describe('getBackLinks', () => {
    it('returns all links pointing TO the given concept', () => {
        insertConcept('attention');
        insertConcept('bert');
        insertConcept('gpt');

        addLink('bert', 'attention', 'reference');
        addLink('gpt', 'attention', 'back-link');

        const backLinks = getBackLinks('attention');
        expect(backLinks).toHaveLength(2);
        const sources = backLinks.map((l) => l.from_slug).sort();
        expect(sources).toEqual(['bert', 'gpt'].sort());
    });

    it('returns empty array for a concept with no back-links', () => {
        insertConcept('leaf-concept');
        expect(getBackLinks('leaf-concept')).toEqual([]);
    });

    it('does not include outgoing links of the concept itself', () => {
        insertConcept('node-a');
        insertConcept('node-b');

        /** node-a → node-b (outgoing) */
        addLink('node-a', 'node-b', 'reference');
        /** node-b has no incoming. */
        expect(getBackLinks('node-a')).toHaveLength(0);
    });
});

// ── countLinks ────────────────────────────────────────────────────────────────

describe('countLinks', () => {
    it('returns 0 for a fresh DB', () => {
        expect(countLinks()).toBe(0);
    });

    it('increments with each new distinct link', () => {
        seedTwoConcepts();
        expect(countLinks()).toBe(0);
        addLink('transformer-architecture', 'self-attention', 'reference');
        expect(countLinks()).toBe(1);
        addLink('self-attention', 'transformer-architecture', 'back-link');
        expect(countLinks()).toBe(2);
    });

    it('does not increment for duplicate inserts', () => {
        seedTwoConcepts();
        addLink('transformer-architecture', 'self-attention', 'reference');
        addLink('transformer-architecture', 'self-attention', 'reference'); // dupe
        expect(countLinks()).toBe(1);
    });
});

// ── autoLinkFromCompiledTruth ─────────────────────────────────────────────────

describe('autoLinkFromCompiledTruth', () => {
    it('creates a reference + back-link when compiled_truth contains a target slug', () => {
        insertConcept('transformer-architecture');
        insertConcept('self-attention');

        /** "self-attention" slug appears literally in the truth text. */
        autoLinkFromCompiledTruth(
            'transformer-architecture',
            'Transformer architecture relies on self-attention as its core mechanism.',
            null,
        );

        const refs = getLinksFrom('transformer-architecture', 'reference');
        expect(refs).toHaveLength(1);
        expect(refs[0].to_slug).toBe('self-attention');

        /** The back-link row is self-attention → transformer-architecture (FROM self-attention). */
        const backs = getLinksFrom('self-attention', 'back-link');
        expect(backs).toHaveLength(1);
        expect(backs[0].from_slug).toBe('self-attention');
        expect(backs[0].to_slug).toBe('transformer-architecture');
        expect(backs[0].link_type).toBe('back-link');
    });

    it('matches humanized slug name (hyphens replaced with spaces)', () => {
        insertConcept('transformer-architecture');
        insertConcept('multi-head-attention');

        /** "multi head attention" (no hyphens) matches the slug "multi-head-attention". */
        autoLinkFromCompiledTruth(
            'transformer-architecture',
            'The model uses multi head attention to attend to different positions.',
            null,
        );

        const refs = getLinksFrom('transformer-architecture', 'reference');
        expect(refs.some((r) => r.to_slug === 'multi-head-attention')).toBe(true);
    });

    it('does not self-link (slug never matches itself)', () => {
        insertConcept('transformer-architecture');

        autoLinkFromCompiledTruth(
            'transformer-architecture',
            'transformer-architecture is important in NLP.',
            null,
        );

        const refs = getLinksFrom('transformer-architecture', 'reference');
        expect(refs.every((r) => r.to_slug !== 'transformer-architecture')).toBe(true);
    });

    it('creates no links when no other concepts are mentioned', () => {
        insertConcept('isolated-concept');
        insertConcept('unrelated-slug');

        autoLinkFromCompiledTruth(
            'isolated-concept',
            'This concept discusses something completely different with no overlap.',
            null,
        );

        expect(countLinks()).toBe(0);
    });

    it('limits context to 200 chars in the stored link', () => {
        insertConcept('source-concept');
        insertConcept('target-concept');

        const longTruth = 'target-concept ' + 'x'.repeat(500);
        autoLinkFromCompiledTruth('source-concept', longTruth, null);

        const [link] = getLinksFrom('source-concept', 'reference');
        expect(link.context!.length).toBeLessThanOrEqual(200);
    });

    it('stores the source_id on both directions when a real source exists', () => {
        insertConcept('a');
        insertConcept('b');
        insertRealSource('src-xyz');

        autoLinkFromCompiledTruth('a', 'mentions b here', 'src-xyz');

        const ref = getLinksFrom('a', 'reference')[0];
        const back = getLinksFrom('b', 'back-link')[0];

        expect(ref.source_id).toBe('src-xyz');
        expect(back.source_id).toBe('src-xyz');
    });

    it('is a no-op when there are no other concepts in the DB', () => {
        insertConcept('lone-concept');
        expect(() =>
            autoLinkFromCompiledTruth('lone-concept', 'Something important', 'src-006'),
        ).not.toThrow();
        expect(countLinks()).toBe(0);
    });
});

// ── Schema v7 check ───────────────────────────────────────────────────────────

describe('schema v7 migration', () => {
    it('concept_links table exists', () => {
        const tables = getDb()
            .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='concept_links'`)
            .all() as { name: string }[];
        expect(tables).toHaveLength(1);
    });

    it('concept_links has the expected columns', () => {
        const info = getDb().prepare('PRAGMA table_info(concept_links)').all() as {
            name: string;
        }[];
        const cols = info.map((r) => r.name);
        expect(cols).toEqual(
            expect.arrayContaining([
                'id',
                'from_slug',
                'to_slug',
                'link_type',
                'context',
                'source_id',
                'created_at',
            ]),
        );
    });

    it('enforces UNIQUE(from_slug, to_slug, link_type)', () => {
        seedTwoConcepts();
        getDb()
            .prepare(
                `INSERT INTO concept_links (from_slug, to_slug, link_type, created_at)
                 VALUES ('transformer-architecture', 'self-attention', 'manual', datetime('now'))`,
            )
            .run();

        expect(() =>
            getDb()
                .prepare(
                    `INSERT INTO concept_links (from_slug, to_slug, link_type, created_at)
                     VALUES ('transformer-architecture', 'self-attention', 'manual', datetime('now'))`,
                )
                .run(),
        ).toThrow(); // UNIQUE constraint
    });

    it('idx_links_from, idx_links_to, idx_links_type indexes exist', () => {
        const indexes = getDb()
            .prepare(
                `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='concept_links'`,
            )
            .all() as { name: string }[];
        const names = indexes.map((r) => r.name);
        expect(names).toContain('idx_links_from');
        expect(names).toContain('idx_links_to');
        expect(names).toContain('idx_links_type');
    });
});
