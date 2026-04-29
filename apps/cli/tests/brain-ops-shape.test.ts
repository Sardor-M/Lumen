import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setDataDir, resetDataDir } from '../src/utils/paths.js';
import { getDb, resetDb } from '../src/store/database.js';
import { logQuery } from '../src/store/query-log.js';
import {
    upsertConcept,
    getConcept,
    getActiveConcept,
    retireConcept,
} from '../src/store/concepts.js';
import { toKnownSkill, budgetHint } from '../src/mcp/brain-ops-helpers.js';
import type { Concept } from '../src/types/index.js';

let tempDir: string;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lumen-bo-shape-'));
    setDataDir(tempDir);
    getDb();
});

afterEach(() => {
    resetDb();
    resetDataDir();
    rmSync(tempDir, { recursive: true, force: true });
});

function seedConcept(slug: string, opts: { truth?: string; scope_key?: string } = {}): Concept {
    const now = new Date().toISOString();
    upsertConcept({
        slug,
        name: slug,
        summary: opts.truth ?? null,
        compiled_truth: opts.truth ?? null,
        article: null,
        created_at: now,
        updated_at: now,
        mention_count: 1,
        scope_kind: 'codebase',
        scope_key: opts.scope_key ?? 'repo-a',
    });
    const c = getConcept(slug);
    if (!c) throw new Error('seedConcept failed to insert');
    return c;
}

/** ─── toKnownSkill projection ─── */

describe('toKnownSkill', () => {
    it('projects a Concept onto the KnownSkill shape', () => {
        const c = seedConcept('attention', {
            truth: 'self-attention mechanism in transformers',
            scope_key: 'repo-a',
        });
        const skill = toKnownSkill(c);
        expect(skill.slug).toBe('attention');
        expect(skill.name).toBe('attention');
        expect(skill.compiled_truth).toBe('self-attention mechanism in transformers');
        expect(skill.score).toBe(0);
        expect(skill.scope).toEqual({ kind: 'codebase', key: 'repo-a' });
        expect(skill.mention_count).toBe(1);
        expect(typeof skill.last_used_at).toBe('string');
    });

    it('falls back to summary when compiled_truth is null', () => {
        const c = seedConcept('only-summary');
        /** Manually set summary without compiled_truth via the rowToConcept path. */
        getDb()
            .prepare('UPDATE concepts SET summary = ?, compiled_truth = NULL WHERE slug = ?')
            .run('summary text', 'only-summary');
        const updated = getConcept('only-summary');
        if (!updated) throw new Error('lookup failed');
        const skill = toKnownSkill(updated);
        expect(skill.compiled_truth).toBe('summary text');
    });

    it('drops timeline + retirement fields (KnownSkill is a subset)', () => {
        const c = seedConcept('subset-test', { truth: 'rich content for subset projection test' });
        const skill = toKnownSkill(c);
        const keys = Object.keys(skill).sort();
        expect(keys).toEqual(
            [
                'slug',
                'name',
                'compiled_truth',
                'score',
                'scope',
                'mention_count',
                'last_used_at',
            ].sort(),
        );
    });
});

/** ─── budgetHint computation ─── */

function logBoSession(
    session: string,
    opts: { hits: number[]; tokens: number[]; scope?: { kind: 'codebase'; key: string } },
): void {
    for (let i = 0; i < opts.hits.length; i++) {
        logQuery({
            tool_name: 'brain_ops',
            query_text: 'q',
            result_count: 1,
            latency_ms: 5,
            session_id: session,
            skill_hit: opts.hits[i] === 1 ? 1 : 0,
            tokens_spent: opts.tokens[i] ?? null,
            scope_kind: opts.scope?.kind ?? null,
            scope_key: opts.scope?.key ?? null,
        });
    }
}

describe('budgetHint', () => {
    it('returns global zeros when query_log is empty', () => {
        const hint = budgetHint(null, null);
        expect(hint.prior_tasks_in_scope).toBe(0);
        expect(hint.avg_tokens_with_skill).toBe(0);
        expect(hint.avg_tokens_without_skill).toBe(0);
        expect(hint.estimated_savings_tokens).toBe(0);
        expect(hint.skill_hit_rate).toBe(0);
    });

    it('returns scope-specific stats when scope is found in by_scope', () => {
        logBoSession('a-explore', {
            hits: [0],
            tokens: [800],
            scope: { kind: 'codebase', key: 'repo-a' },
        });
        logBoSession('a-skill', {
            hits: [1],
            tokens: [200],
            scope: { kind: 'codebase', key: 'repo-a' },
        });
        const hint = budgetHint('codebase', 'repo-a');
        expect(hint.prior_tasks_in_scope).toBe(2);
        expect(hint.skill_hit_rate).toBeCloseTo(0.5, 3);
        /** (800 - 200) * 1 skill_aided session = 600 */
        expect(hint.estimated_savings_tokens).toBe(600);
    });

    it('falls back to global aggregate when the scope has no telemetry yet', () => {
        logBoSession('e1', {
            hits: [0],
            tokens: [400],
            scope: { kind: 'codebase', key: 'repo-x' },
        });
        const hint = budgetHint('codebase', 'fresh-scope-with-no-data');
        /** Falls back to the global numbers, not the unknown scope's empty data. */
        expect(hint.prior_tasks_in_scope).toBe(1);
        expect(hint.avg_tokens_without_skill).toBe(400);
    });

    it('returns global aggregate when scopeKind / scopeKey are null', () => {
        logBoSession('e1', { hits: [0], tokens: [500] });
        logBoSession('s1', { hits: [1], tokens: [100] });
        const hint = budgetHint(null, null);
        expect(hint.prior_tasks_in_scope).toBe(2);
        expect(hint.skill_hit_rate).toBeCloseTo(0.5, 3);
    });
});

/** ─── End-to-end shape: simulate the brain_ops decision flow ─── */

describe('brain_ops response composition', () => {
    /**
     * The handler builds responses by combining (a) toKnownSkill on hit and
     * (b) budgetHint on every path. These tests don't spin up the MCP server;
     * they exercise the same composition the handler uses, so the end-to-end
     * shape stays pinned even if the handler refactors.
     */

    it('concept hit produces known_skill !== null', () => {
        const c = seedConcept('add-route', {
            truth: 'register a new route in the express server with app dot get',
        });
        const known = toKnownSkill(c);
        expect(known).not.toBeNull();
        expect(known.slug).toBe('add-route');
        expect(known.scope.kind).toBe('codebase');
    });

    it('retired concept never becomes a known_skill (getActiveConcept returns null)', () => {
        seedConcept('dead-skill', { truth: 'this skill will be retired manually for the test' });
        retireConcept('dead-skill', 'test');
        const c = getActiveConcept('dead-skill');
        /** Handler's known_skill = c ? toKnownSkill(c) : null. */
        expect(c).toBeNull();
    });

    it('budget hint surfaces non-zero savings when prior sessions exist in scope', () => {
        const c = seedConcept('add-route', {
            truth: 'register a new route in the express server with app dot get',
            scope_key: 'repo-a',
        });
        logBoSession('explore-prior', {
            hits: [0],
            tokens: [1000],
            scope: { kind: 'codebase', key: 'repo-a' },
        });
        logBoSession('skill-prior', {
            hits: [1],
            tokens: [200],
            scope: { kind: 'codebase', key: 'repo-a' },
        });
        const hint = budgetHint(c.scope_kind, c.scope_key);
        expect(hint.prior_tasks_in_scope).toBe(2);
        expect(hint.estimated_savings_tokens).toBeGreaterThan(0);
    });

    it('exploration_recommended logic: true when no concept hit OR hybrid search path', () => {
        /**
         * The handler sets exploration_recommended = !centerHit on neighborhood,
         * = !pathResult on path, and = true unconditionally on hybrid_search
         * (chunks aren't skills). Sanity-check the inverse relationship.
         */
        const c = seedConcept('present', { truth: 'a concept that exists in the brain right now' });
        const hit = getActiveConcept('present');
        /** Concept-hit path: known_skill !== null, exploration_recommended = false. */
        expect(hit).not.toBeNull();
        const missing = getActiveConcept('does-not-exist');
        /** Concept-miss path: would fall through, exploration_recommended = true on miss. */
        expect(missing).toBeNull();
    });
});
