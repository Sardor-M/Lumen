import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setDataDir, resetDataDir } from '../src/utils/paths.js';
import { getDb, resetDb } from '../src/store/database.js';
import { logQuery, explorationCostAvoided } from '../src/store/query-log.js';
import { getProfile } from '../src/profile/cache.js';
import { invalidateProfile } from '../src/profile/invalidate.js';

let tempDir: string;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lumen-telemetry-'));
    setDataDir(tempDir);
    getDb();
});

afterEach(() => {
    resetDb();
    resetDataDir();
    rmSync(tempDir, { recursive: true, force: true });
});

/** ─── Schema v13 ─── */

describe('schema v13', () => {
    it('reports user_version >= 13', () => {
        const v = getDb().pragma('user_version', { simple: true }) as number;
        expect(v).toBeGreaterThanOrEqual(13);
    });

    it('adds tokens_spent / skill_hit / exploration_depth / scope_kind / scope_key to query_log', () => {
        const cols = getDb().pragma('table_info(query_log)') as Array<{
            name: string;
            notnull: number;
            dflt_value: string | null;
        }>;
        const names = cols.map((c) => c.name);
        for (const expected of [
            'tokens_spent',
            'skill_hit',
            'exploration_depth',
            'scope_kind',
            'scope_key',
        ]) {
            expect(names).toContain(expected);
        }
        const skill = cols.find((c) => c.name === 'skill_hit');
        expect(skill?.notnull).toBe(1);
        expect(skill?.dflt_value).toBe('0');
    });

    it('creates skill_hit and scope indexes', () => {
        const idx = getDb()
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_query_log_%'",
            )
            .all() as Array<{ name: string }>;
        const names = idx.map((r) => r.name);
        expect(names).toContain('idx_query_log_skill_hit');
        expect(names).toContain('idx_query_log_scope');
    });
});

/** ─── logQuery shape compatibility ─── */

describe('logQuery accepts new fields without breaking old callers', () => {
    it('writes a row with no telemetry fields (legacy shape)', () => {
        logQuery({
            tool_name: 'search',
            query_text: 'old caller',
            result_count: 3,
            latency_ms: 12,
            session_id: 'sess-old',
        });
        const row = getDb()
            .prepare('SELECT * FROM query_log WHERE session_id = ?')
            .get('sess-old') as {
            tokens_spent: number | null;
            skill_hit: number;
            exploration_depth: number | null;
            scope_kind: string | null;
            scope_key: string | null;
        };
        expect(row.tokens_spent).toBeNull();
        expect(row.skill_hit).toBe(0);
        expect(row.exploration_depth).toBeNull();
        expect(row.scope_kind).toBeNull();
        expect(row.scope_key).toBeNull();
    });

    it('writes a row with all telemetry fields populated', () => {
        logQuery({
            tool_name: 'brain_ops',
            query_text: 'attention mechanism',
            result_count: 1,
            latency_ms: 8,
            session_id: 'sess-new',
            tokens_spent: 1234,
            skill_hit: 1,
            exploration_depth: 2,
            scope_kind: 'codebase',
            scope_key: 'abc123def4567890',
        });
        const row = getDb()
            .prepare('SELECT * FROM query_log WHERE session_id = ?')
            .get('sess-new') as {
            tokens_spent: number;
            skill_hit: number;
            scope_kind: string;
            scope_key: string;
        };
        expect(row.tokens_spent).toBe(1234);
        expect(row.skill_hit).toBe(1);
        expect(row.scope_kind).toBe('codebase');
        expect(row.scope_key).toBe('abc123def4567890');
    });
});

/** ─── explorationCostAvoided aggregator ─── */

function logSession(
    sessionId: string,
    opts: { hits: number[]; tokens: number[]; scope?: { kind: string; key: string } },
): void {
    for (let i = 0; i < opts.hits.length; i++) {
        logQuery({
            tool_name: 'brain_ops',
            query_text: `q${i}`,
            result_count: 1,
            latency_ms: 5,
            session_id: sessionId,
            skill_hit: opts.hits[i] === 1 ? 1 : 0,
            tokens_spent: opts.tokens[i] ?? null,
            scope_kind: (opts.scope?.kind ?? null) as never,
            scope_key: opts.scope?.key ?? null,
        });
    }
}

describe('explorationCostAvoided', () => {
    it('returns zeros on an empty window', () => {
        const t = explorationCostAvoided(7);
        expect(t.total_sessions).toBe(0);
        expect(t.skill_aided_sessions).toBe(0);
        expect(t.exploration_sessions).toBe(0);
        expect(t.hit_rate).toBe(0);
        expect(t.baseline_tokens).toBe(0);
        expect(t.with_skill_tokens).toBe(0);
        expect(t.estimated_savings_tokens).toBe(0);
        expect(t.estimated_savings_usd).toBe(0);
        expect(t.by_scope).toEqual([]);
    });

    it('classifies a session as skill-aided when any call has skill_hit=1', () => {
        logSession('s1', { hits: [0, 0, 1], tokens: [100, 100, 100] });
        const t = explorationCostAvoided(7);
        expect(t.skill_aided_sessions).toBe(1);
        expect(t.exploration_sessions).toBe(0);
        expect(t.hit_rate).toBe(1);
    });

    it('classifies a session as exploration when no call has skill_hit=1', () => {
        logSession('s2', { hits: [0, 0, 0], tokens: [200, 200, 200] });
        const t = explorationCostAvoided(7);
        expect(t.skill_aided_sessions).toBe(0);
        expect(t.exploration_sessions).toBe(1);
        expect(t.hit_rate).toBe(0);
    });

    it('computes savings as (baseline - with_skill) * skill_aided_sessions', () => {
        /** 2 exploration sessions averaging 1000 tokens, 3 skill-aided sessions averaging 200 tokens. */
        logSession('explore-1', { hits: [0, 0], tokens: [500, 500] });
        logSession('explore-2', { hits: [0, 0], tokens: [500, 500] });
        logSession('skill-1', { hits: [1, 0], tokens: [100, 100] });
        logSession('skill-2', { hits: [1, 0], tokens: [100, 100] });
        logSession('skill-3', { hits: [1, 0], tokens: [100, 100] });
        const t = explorationCostAvoided(7);
        expect(t.total_sessions).toBe(5);
        expect(t.skill_aided_sessions).toBe(3);
        expect(t.exploration_sessions).toBe(2);
        expect(t.hit_rate).toBeCloseTo(3 / 5, 3);
        expect(t.baseline_tokens).toBe(1000);
        expect(t.with_skill_tokens).toBe(200);
        /** (1000 - 200) * 3 = 2400 */
        expect(t.estimated_savings_tokens).toBe(2400);
    });

    it('clamps savings at 0 when with_skill > baseline', () => {
        logSession('explore', { hits: [0], tokens: [100] });
        logSession('skill', { hits: [1], tokens: [9999] });
        const t = explorationCostAvoided(7);
        expect(t.estimated_savings_tokens).toBe(0);
    });

    it('produces per-scope breakdown sorted by savings descending', () => {
        logSession('a-explore', {
            hits: [0],
            tokens: [800],
            scope: { kind: 'codebase', key: 'repo-a' },
        });
        logSession('a-skill', {
            hits: [1],
            tokens: [200],
            scope: { kind: 'codebase', key: 'repo-a' },
        });
        logSession('b-explore', {
            hits: [0],
            tokens: [200],
            scope: { kind: 'codebase', key: 'repo-b' },
        });
        logSession('b-skill', {
            hits: [1],
            tokens: [100],
            scope: { kind: 'codebase', key: 'repo-b' },
        });
        const t = explorationCostAvoided(7);
        expect(t.by_scope.length).toBe(2);
        expect(t.by_scope[0].scope_key).toBe('repo-a');
        expect(t.by_scope[0].estimated_savings_tokens).toBeGreaterThan(
            t.by_scope[1].estimated_savings_tokens,
        );
    });

    it('excludes sessions with null tokens_spent from the token average but still counts hit_rate', () => {
        logQuery({
            tool_name: 'brain_ops',
            query_text: 'q',
            result_count: 1,
            latency_ms: 5,
            session_id: 'token-null',
            skill_hit: 1,
        });
        logSession('with-tokens', { hits: [0], tokens: [500] });
        const t = explorationCostAvoided(7);
        expect(t.total_sessions).toBe(2);
        expect(t.skill_aided_sessions).toBe(1);
        expect(t.exploration_sessions).toBe(1);
        /** baseline_tokens = 500 (the only session that had a token count); with_skill_tokens = 0 (the hit session had no token count). */
        expect(t.baseline_tokens).toBe(500);
        expect(t.with_skill_tokens).toBe(0);
    });
});

/** ─── profile.learned surfaces telemetry ─── */

describe('profile.learned exposes telemetry fields', () => {
    it('returns zeroed telemetry when query_log is empty', () => {
        const profile = getProfile();
        expect(profile.learned.skill_hit_rate_7d).toBe(0);
        expect(profile.learned.exploration_cost_avoided_7d_tokens).toBe(0);
        expect(profile.learned.exploration_cost_avoided_7d_usd).toBe(0);
        expect(profile.learned.by_scope).toEqual([]);
    });

    it('reflects telemetry after some sessions are logged', () => {
        logSession('e1', { hits: [0], tokens: [800], scope: { kind: 'codebase', key: 'r' } });
        logSession('s1', { hits: [1], tokens: [200], scope: { kind: 'codebase', key: 'r' } });
        invalidateProfile();
        const profile = getProfile(true);
        expect(profile.learned.skill_hit_rate_7d).toBeCloseTo(0.5, 3);
        expect(profile.learned.exploration_cost_avoided_7d_tokens).toBe(600);
        expect(profile.learned.by_scope.length).toBe(1);
    });
});
