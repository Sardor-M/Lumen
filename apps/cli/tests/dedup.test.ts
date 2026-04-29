import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setDataDir, resetDataDir } from '../src/utils/paths.js';
import { getDb, resetDb } from '../src/store/database.js';
import {
    jaccardSimilarity,
    slugEditDistance,
    slugSimilarity,
    findMergeCandidate,
    SLUG_SIM_THRESHOLD,
    CONTENT_SIM_THRESHOLD,
} from '../src/dedup/index.js';
import type { MergeCandidate } from '../src/dedup/index.js';
import {
    upsertConcept,
    getConcept,
    getActiveConcept,
    appendTimeline,
    updateCompiledTruth,
    updateScore,
    retireConcept,
    unretireConcept,
} from '../src/store/concepts.js';
import { recordAlias, resolveAlias, listAliases, countAliases } from '../src/store/aliases.js';
import { recordFeedback, feedbackTotal, listFeedback } from '../src/store/feedback.js';
import { addLink, getBackLinks } from '../src/store/links.js';
import { getEdgesFrom, upsertEdge } from '../src/store/edges.js';

let tempDir: string;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lumen-dedup-'));
    setDataDir(tempDir);
    getDb();
});

afterEach(() => {
    resetDb();
    resetDataDir();
    rmSync(tempDir, { recursive: true, force: true });
});

function seedConcept(slug: string, opts?: { name?: string; truth?: string; scope_key?: string }) {
    const now = new Date().toISOString();
    upsertConcept({
        slug,
        name: opts?.name ?? slug,
        summary: opts?.truth ?? null,
        compiled_truth: opts?.truth ?? null,
        article: null,
        created_at: now,
        updated_at: now,
        mention_count: 1,
        scope_kind: 'codebase',
        scope_key: opts?.scope_key ?? 'repo-a',
    });
}

/** ─── Pure similarity primitives ─── */

describe('jaccardSimilarity', () => {
    it('returns 1 for identical content', () => {
        expect(jaccardSimilarity('hello world test', 'hello world test')).toBe(1);
    });

    it('returns 0 for disjoint token sets', () => {
        expect(jaccardSimilarity('alpha beta gamma', 'foo bar baz')).toBe(0);
    });

    it('returns 0 for empty input on either side', () => {
        expect(jaccardSimilarity('', 'hello world')).toBe(0);
        expect(jaccardSimilarity('hello world', '')).toBe(0);
        expect(jaccardSimilarity('', '')).toBe(0);
    });

    it('handles partial overlap', () => {
        const sim = jaccardSimilarity('alpha beta gamma', 'beta gamma delta');
        expect(sim).toBeCloseTo(2 / 4, 3);
    });

    it('is order-independent', () => {
        const a = jaccardSimilarity('foo bar baz', 'baz foo bar');
        expect(a).toBe(1);
    });
});

describe('slugEditDistance', () => {
    it('is 0 for identical slugs', () => {
        expect(slugEditDistance('attention', 'attention')).toBe(0);
    });

    it('counts single character substitution as 1', () => {
        expect(slugEditDistance('cat', 'bat')).toBe(1);
    });

    it('handles empty inputs', () => {
        expect(slugEditDistance('', 'abc')).toBe(3);
        expect(slugEditDistance('abc', '')).toBe(3);
    });

    it('matches a known reference distance', () => {
        /** kitten -> sitting: 3 edits (k->s, e->i, +g). */
        expect(slugEditDistance('kitten', 'sitting')).toBe(3);
    });
});

describe('slugSimilarity', () => {
    it('returns 1 for identical', () => {
        expect(slugSimilarity('foo', 'foo')).toBe(1);
    });

    it('returns 0 for completely different of same length', () => {
        expect(slugSimilarity('abc', 'xyz')).toBe(0);
    });

    it('is symmetric', () => {
        expect(slugSimilarity('add-route', 'add-routes')).toBe(
            slugSimilarity('add-routes', 'add-route'),
        );
    });
});

/** ─── Policy: findMergeCandidate ─── */

describe('findMergeCandidate', () => {
    function candidate(over: Partial<MergeCandidate>): MergeCandidate {
        return {
            slug: 'ref',
            content: 'ref content',
            score: 0,
            mention_count: 1,
            retired_at: null,
            ...over,
        };
    }

    it('returns no_candidates when the candidate list is empty', () => {
        const d = findMergeCandidate({ slug: 'foo', content: 'x' }, []);
        expect(d.merge).toBe(false);
        if (!d.merge) expect(d.reason).toBe('no_candidates');
    });

    it('returns no_candidates when the only candidate is the same slug', () => {
        const d = findMergeCandidate(
            { slug: 'attention', content: 'self-attention is all you need' },
            [candidate({ slug: 'attention', content: 'self-attention is all you need' })],
        );
        expect(d.merge).toBe(false);
    });

    it('skips retired candidates', () => {
        const d = findMergeCandidate(
            { slug: 'add-route', content: 'register a new route in the express app' },
            [
                candidate({
                    slug: 'add-routes',
                    content: 'register a new route in the express app',
                    retired_at: '2026-04-25T00:00:00Z',
                }),
            ],
        );
        expect(d.merge).toBe(false);
    });

    it('merges when slug + content both clear thresholds', () => {
        const d = findMergeCandidate(
            { slug: 'add-route', content: 'register a new route in the express app server' },
            [
                candidate({
                    slug: 'add-routes',
                    content: 'register a new route in the express app server',
                }),
            ],
        );
        expect(d.merge).toBe(true);
        if (d.merge) {
            expect(d.canonical.slug).toBe('add-routes');
            expect(d.slug_sim).toBeGreaterThanOrEqual(SLUG_SIM_THRESHOLD);
            expect(d.content_sim).toBeGreaterThanOrEqual(CONTENT_SIM_THRESHOLD);
        }
    });

    it('does NOT merge when slugs are similar but content diverges', () => {
        /** react-hooks vs react-router: similar slug, completely different content. */
        const d = findMergeCandidate(
            {
                slug: 'react-hooks',
                content: 'useState useEffect useMemo functional state management',
            },
            [
                candidate({
                    slug: 'react-router',
                    content: 'navigation routing path matching browser history nested routes',
                }),
            ],
        );
        expect(d.merge).toBe(false);
        if (!d.merge) expect(d.reason).toBe('below_threshold');
    });

    it('does NOT merge when content matches but slugs are very different', () => {
        const d = findMergeCandidate(
            { slug: 'completely-different-slug', content: 'shared identical content body' },
            [candidate({ slug: 'totally-other-name', content: 'shared identical content body' })],
        );
        expect(d.merge).toBe(false);
    });

    it('picks the higher-scored canonical when multiple candidates clear', () => {
        const d = findMergeCandidate(
            { slug: 'add-route', content: 'register a new route in the express app' },
            [
                candidate({
                    slug: 'add-routes',
                    content: 'register a new route in the express app',
                    score: 1,
                    mention_count: 5,
                }),
                candidate({
                    slug: 'add-route-v2',
                    content: 'register a new route in the express app',
                    score: 7,
                    mention_count: 2,
                }),
            ],
        );
        expect(d.merge).toBe(true);
        if (d.merge) expect(d.canonical.slug).toBe('add-route-v2');
    });
});

/** ─── Aliases store ─── */

describe('aliases store', () => {
    it('recordAlias inserts a row that resolveAlias follows', () => {
        seedConcept('canonical-slug');
        recordAlias({
            alias: 'incoming-slug',
            canonical_slug: 'canonical-slug',
            scope_kind: 'codebase',
            scope_key: 'repo-a',
        });
        expect(resolveAlias('incoming-slug')).toBe('canonical-slug');
        expect(resolveAlias('canonical-slug')).toBe('canonical-slug');
        expect(resolveAlias('not-aliased')).toBe('not-aliased');
    });

    it('recordAlias is idempotent when all fields match', () => {
        seedConcept('a-canon');
        recordAlias({
            alias: 'shared',
            canonical_slug: 'a-canon',
            scope_kind: 'codebase',
            scope_key: 'repo-a',
        });
        /** Exact same params — must not throw. */
        expect(() =>
            recordAlias({
                alias: 'shared',
                canonical_slug: 'a-canon',
                scope_kind: 'codebase',
                scope_key: 'repo-a',
            }),
        ).not.toThrow();
        expect(resolveAlias('shared')).toBe('a-canon');
    });

    it('recordAlias throws when alias is already bound to a different canonical', () => {
        seedConcept('a-canon');
        seedConcept('b-canon');
        recordAlias({
            alias: 'shared',
            canonical_slug: 'a-canon',
            scope_kind: 'codebase',
            scope_key: 'repo-a',
        });
        expect(() =>
            recordAlias({
                alias: 'shared',
                canonical_slug: 'b-canon',
                scope_kind: 'codebase',
                scope_key: 'repo-a',
            }),
        ).toThrow(/already bound to/i);
    });

    it('listAliases returns aliases pointing at a canonical', () => {
        seedConcept('hub');
        recordAlias({
            alias: 'spoke-1',
            canonical_slug: 'hub',
            scope_kind: 'codebase',
            scope_key: 'repo-a',
        });
        recordAlias({
            alias: 'spoke-2',
            canonical_slug: 'hub',
            scope_kind: 'codebase',
            scope_key: 'repo-a',
        });
        const list = listAliases('hub');
        expect(list.length).toBe(2);
        expect(list.map((a) => a.alias).sort()).toEqual(['spoke-1', 'spoke-2']);
    });
});

/** ─── upsertConcept merge-on-write integration ─── */

describe('upsertConcept merge-on-write', () => {
    it('inserts a fresh concept when no near-duplicates exist in scope', () => {
        seedConcept('attention', { truth: 'self-attention mechanism in transformers' });
        seedConcept('react-hooks', { truth: 'useState useEffect functional state' });
        expect(getConcept('attention')?.slug).toBe('attention');
        expect(getConcept('react-hooks')?.slug).toBe('react-hooks');
        expect(countAliases()).toBe(0);
    });

    it('merges incoming into existing canonical when slug + content cross thresholds', () => {
        /**
         * Both seeded concepts have the same content and end up with score=0
         * + mention_count=1 (no feedback recorded). The merge policy ranks
         * candidates by `(score DESC, mention_count DESC, slug ASC)`, so the
         * tie-breaker on this case is lexicographic on slug - 'add-route' wins
         * over 'add-routes'. Insertion order does NOT determine the canonical.
         */
        seedConcept('add-route', {
            truth: 'register a new route in the express server with app dot get',
        });
        seedConcept('add-routes', {
            truth: 'register a new route in the express server with app dot get',
        });

        /** Second concept should NOT exist as a separate row. */
        const list = getDb()
            .prepare("SELECT slug FROM concepts WHERE slug IN ('add-route', 'add-routes')")
            .all() as Array<{ slug: string }>;
        expect(list.length).toBe(1);
        expect(list[0].slug).toBe('add-route');

        /** And the alias should resolve. */
        expect(resolveAlias('add-routes')).toBe('add-route');
        expect(getConcept('add-routes')?.slug).toBe('add-route');
    });

    it('does NOT merge across scopes', () => {
        seedConcept('add-route', {
            truth: 'register a new route in the express server with app dot get',
            scope_key: 'repo-a',
        });
        seedConcept('add-routes', {
            truth: 'register a new route in the express server with app dot get',
            scope_key: 'repo-b',
        });

        expect(getConcept('add-route')?.slug).toBe('add-route');
        expect(getConcept('add-routes')?.slug).toBe('add-routes');
        expect(countAliases()).toBe(0);
    });

    it('scope-A alias does not redirect a scope-B upsert', () => {
        /**
         * 1. Merge fires in scope-A: 'route-add' is canonical, 'route-adds' is
         *    recorded as its alias.
         * 2. A separate scope-B write arrives with slug 'route-adds'. Without
         *    scope-aware resolution this would silently land on scope-A's
         *    'route-add' row. With the fix it must create a fresh concept.
         */
        seedConcept('route-add', {
            truth: 'register a new route in the express server with app dot get method',
            scope_key: 'repo-a',
        });
        seedConcept('route-adds', {
            truth: 'register a new route in the express server with app dot get method',
            scope_key: 'repo-a',
        });
        /** Sanity: alias was recorded in scope-A. */
        expect(resolveAlias('route-adds')).toBe('route-add');

        /** Now upsert 'route-adds' in scope-B — must NOT follow scope-A's alias. */
        const now = new Date().toISOString();
        upsertConcept({
            slug: 'route-adds',
            name: 'route-adds',
            summary: 'completely different concept in repo-b',
            compiled_truth: 'completely different concept in repo-b',
            article: null,
            created_at: now,
            updated_at: now,
            mention_count: 1,
            scope_kind: 'codebase',
            scope_key: 'repo-b',
        });

        /** scope-B concept must exist as its own row. */
        const scopeBConcept = getConcept('route-adds');
        expect(scopeBConcept?.slug).toBe('route-adds');
        expect(scopeBConcept?.scope_key).toBe('repo-b');

        /** scope-A canonical must be untouched. */
        const scopeAConcept = getConcept('route-add');
        expect(scopeAConcept?.scope_key).toBe('repo-a');
    });

    it('does NOT merge into a retired canonical', () => {
        seedConcept('orig-slug', { truth: 'shared body content for the merge test scenario' });
        /** Drive orig-slug into retirement. */
        recordFeedback({ slug: 'orig-slug', delta: -1 });
        recordFeedback({ slug: 'orig-slug', delta: -1 });
        recordFeedback({ slug: 'orig-slug', delta: -1 });
        expect(getConcept('orig-slug')?.retired_at).not.toBeNull();

        seedConcept('orig-slugs', { truth: 'shared body content for the merge test scenario' });

        /** A new active row should exist; no alias was recorded. */
        expect(getActiveConcept('orig-slugs')?.slug).toBe('orig-slugs');
        expect(resolveAlias('orig-slugs')).toBe('orig-slugs');
    });

    it('preserves the canonical score on merge (no reset)', () => {
        seedConcept('canon', { truth: 'shared identical content body for both' });
        recordFeedback({ slug: 'canon', delta: 1 });
        recordFeedback({ slug: 'canon', delta: 1 });
        expect(getConcept('canon')?.score).toBe(2);

        seedConcept('canons', { truth: 'shared identical content body for both' });
        const c = getConcept('canon');
        expect(c?.score).toBe(2);
        expect(c?.mention_count).toBeGreaterThanOrEqual(2);
    });

    it('exact-slug re-upsert still hits the existing ON CONFLICT path', () => {
        seedConcept('exact', { truth: 'first writing of the concept' });
        const before = getConcept('exact');
        seedConcept('exact', { truth: 'second writing of the same concept' });
        const after = getConcept('exact');
        /** mention_count incremented; no alias created. */
        expect(after?.mention_count).toBe((before?.mention_count ?? 0) + 1);
        expect(countAliases()).toBe(0);
    });

    it('higher-scored existing wins as canonical when multiple near-duplicates exist', () => {
        seedConcept('lower', { truth: 'shared narrative about the same topic identical' });
        seedConcept('highers', { truth: 'shared narrative about the same topic identical' });
        recordFeedback({ slug: 'highers', delta: 1 });
        recordFeedback({ slug: 'highers', delta: 1 });
        /** Now upsert a third near-duplicate — should fold into 'highers' (highest score). */
        seedConcept('higher', { truth: 'shared narrative about the same topic identical' });
        expect(resolveAlias('higher')).toBe('highers');
    });
});

/** ─── getConcept follows aliases ─── */

describe('getConcept transparently follows aliases', () => {
    it('returns the canonical row for an aliased slug', () => {
        seedConcept('canonical-form', { truth: 'rich content describing this concept thoroughly' });
        recordAlias({
            alias: 'aliased-form',
            canonical_slug: 'canonical-form',
            scope_kind: 'codebase',
            scope_key: 'repo-a',
        });
        const c = getConcept('aliased-form');
        expect(c?.slug).toBe('canonical-form');
        expect(c?.compiled_truth).toContain('rich content');
    });

    it('returns null when neither the slug nor any alias resolves', () => {
        expect(getConcept('does-not-exist-slug')).toBeNull();
    });
});

/** ─── recordAlias safety guards ─── */

describe('recordAlias chain prevention', () => {
    it('refuses to record an alias whose canonical_slug is itself an alias', () => {
        seedConcept('real-canon', { truth: 'genuine content body that has multiple tokens' });
        recordAlias({
            alias: 'first-alias',
            canonical_slug: 'real-canon',
            scope_kind: 'codebase',
            scope_key: 'repo-a',
        });

        /** Attempting to point a new alias at first-alias must throw. */
        expect(() =>
            recordAlias({
                alias: 'second-alias',
                canonical_slug: 'first-alias',
                scope_kind: 'codebase',
                scope_key: 'repo-a',
            }),
        ).toThrow(/refusing to chain/i);
    });
});

/** ─── Post-merge caller flow (FK resolution at every boundary) ─── */

describe('post-merge caller flow follows aliases', () => {
    /**
     * Set up a merged pair: `route-add` is the canonical (lexicographically
     * earlier wins the score=0 tie-break), `route-adds` folds in as the alias.
     * Every test below calls FK-touching functions with the alias slug and
     * verifies the operation lands on the canonical row.
     */
    function setupMerged(): void {
        seedConcept('route-add', {
            truth: 'register a new route in the express server with app dot get method',
        });
        seedConcept('route-adds', {
            truth: 'register a new route in the express server with app dot get method',
        });
        /** Sanity check: the merge fired. */
        expect(resolveAlias('route-adds')).toBe('route-add');
    }

    it('updateCompiledTruth(alias) writes to the canonical row', () => {
        setupMerged();
        updateCompiledTruth('route-adds', 'updated synthesis written via alias');
        expect(getConcept('route-add')?.compiled_truth).toBe('updated synthesis written via alias');
    });

    it('appendTimeline(alias) appends to the canonical row', () => {
        setupMerged();
        const before = getConcept('route-add')?.timeline.length ?? 0;
        appendTimeline('route-adds', {
            date: '2026-04-28',
            source_id: null,
            source_title: 'via alias',
            event: 'test entry',
            detail: null,
        });
        expect((getConcept('route-add')?.timeline.length ?? 0) - before).toBe(1);
    });

    it('updateScore(alias) writes to the canonical row', () => {
        setupMerged();
        updateScore('route-adds', 5);
        expect(getConcept('route-add')?.score).toBe(5);
    });

    it('retireConcept(alias) retires the canonical row', () => {
        setupMerged();
        retireConcept('route-adds', 'manual cleanup via alias');
        expect(getConcept('route-add')?.retired_at).not.toBeNull();
        expect(getConcept('route-add')?.retire_reason).toBe('manual cleanup via alias');
        unretireConcept('route-adds');
        expect(getConcept('route-add')?.retired_at).toBeNull();
    });

    it('addLink(alias, alias) lands as canonical→canonical edge in concept_links', () => {
        setupMerged();
        seedConcept('other-canon', {
            truth: 'another concept body with sufficient distinct content tokens',
        });
        addLink('route-adds', 'other-canon', 'reference');
        const links = getBackLinks('other-canon');
        expect(links.some((l) => l.from_slug === 'route-add')).toBe(true);
        expect(links.some((l) => l.from_slug === 'route-adds')).toBe(false);
    });

    it('upsertEdge(alias→alias) lands as canonical→canonical in edges', () => {
        setupMerged();
        seedConcept('other-canon', {
            truth: 'a different concept body with several distinct tokens',
        });
        upsertEdge({
            from_slug: 'route-adds',
            to_slug: 'other-canon',
            relation: 'related',
            weight: 1,
            source_id: null,
        });
        const edges = getEdgesFrom('route-adds');
        expect(edges.length).toBe(1);
        expect(edges[0].from_slug).toBe('route-add');
    });

    it('recordFeedback(alias) records on the canonical and bumps its score', () => {
        setupMerged();
        const before = getConcept('route-add')?.score ?? 0;
        recordFeedback({ slug: 'route-adds', delta: 1 });
        recordFeedback({ slug: 'route-adds', delta: 1 });
        expect(getConcept('route-add')?.score).toBe(before + 2);
        expect(feedbackTotal('route-adds')).toBe(2);
        expect(listFeedback('route-adds').length).toBe(2);
    });
});
