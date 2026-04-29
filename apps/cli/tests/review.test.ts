import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setDataDir, resetDataDir } from '../src/utils/paths.js';
import { getDb, resetDb } from '../src/store/database.js';
import { logQuery } from '../src/store/query-log.js';
import {
    extractTrajectory,
    listCandidateSessions,
    loadSessionLog,
    shouldSkip,
    reviewSessions,
    MIN_SESSION_TOOL_CALLS,
    type ChatJsonFn,
    type ProposedTrajectory,
    type SessionLog,
} from '../src/review/index.js';
import {
    recordReview,
    getReview,
    listReviews,
    countReviews,
} from '../src/store/session-reviews.js';
import { getSource, listSources } from '../src/store/sources.js';
import type { LumenConfig } from '../src/types/index.js';

let tempDir: string;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lumen-review-'));
    setDataDir(tempDir);
    getDb();
});

afterEach(() => {
    resetDb();
    resetDataDir();
    rmSync(tempDir, { recursive: true, force: true });
});

const CONFIG_STUB: LumenConfig = {
    data_dir: '/tmp/x',
    llm: { provider: 'anthropic', model: 'm', api_key: 'k', base_url: null },
    chunker: { min_chunk_tokens: 50, max_chunk_tokens: 1000 },
    search: {
        max_results: 10,
        token_budget: 4000,
        bm25_weight: 0.35,
        tfidf_weight: 0.3,
        vector_weight: 0.35,
    },
    embedding: {
        provider: 'none',
        model: 'm',
        dimensions: 0,
        api_key: null,
        base_url: null,
        batch_size: 1,
    },
};

function logRow(
    session: string,
    tool: string,
    opts: {
        skill_hit?: 0 | 1;
        tokens?: number | null;
        query?: string;
        scope?: { kind: 'codebase'; key: string };
    } = {},
): void {
    logQuery({
        tool_name: tool,
        query_text: opts.query ?? null,
        result_count: 1,
        latency_ms: 5,
        session_id: session,
        skill_hit: opts.skill_hit ?? 0,
        tokens_spent: opts.tokens ?? null,
        scope_kind: opts.scope?.kind ?? null,
        scope_key: opts.scope?.key ?? null,
    });
}

/** Build a chat mock that always returns the same canned response. */
function mockChat(payload: unknown): ChatJsonFn {
    return async <T>() => payload as T;
}

/** Build a chat mock that throws a given error. */
function mockChatThrowing(error: Error): ChatJsonFn {
    return async <T>(): Promise<T> => {
        throw error;
    };
}

/** ─── Schema v14 ─── */

describe('schema v14', () => {
    it('reports user_version >= 14', () => {
        const v = getDb().pragma('user_version', { simple: true }) as number;
        expect(v).toBeGreaterThanOrEqual(14);
    });

    it('creates session_review table with the expected columns', () => {
        const cols = getDb().pragma('table_info(session_review)') as Array<{ name: string }>;
        expect(cols.map((c) => c.name).sort()).toEqual(
            ['notes', 'outcome', 'reviewed_at', 'session_id', 'trajectory_id'].sort(),
        );
    });

    it('rejects an invalid outcome via CHECK constraint', () => {
        expect(() =>
            getDb()
                .prepare(
                    `INSERT INTO session_review (session_id, reviewed_at, outcome) VALUES ('s', '2026-01-01', 'bogus')`,
                )
                .run(),
        ).toThrow(/CHECK constraint failed/);
    });
});

/** ─── Session walker ─── */

describe('listCandidateSessions', () => {
    it('returns nothing when query_log is empty', () => {
        expect(listCandidateSessions()).toEqual([]);
    });

    it('skips sessions with fewer than MIN_SESSION_TOOL_CALLS rows', () => {
        for (let i = 0; i < MIN_SESSION_TOOL_CALLS - 1; i++) {
            logRow('short', 'read');
        }
        expect(listCandidateSessions()).toEqual([]);
    });

    it('returns sessions that meet the threshold', () => {
        for (let i = 0; i < MIN_SESSION_TOOL_CALLS; i++) {
            logRow('long-enough', 'read');
        }
        expect(listCandidateSessions()).toContain('long-enough');
    });

    it('excludes sessions that already have a review record', () => {
        for (let i = 0; i < MIN_SESSION_TOOL_CALLS; i++) {
            logRow('already-reviewed', 'edit');
        }
        recordReview({ session_id: 'already-reviewed', outcome: 'no_skill' });
        expect(listCandidateSessions()).not.toContain('already-reviewed');
    });

    it('honors the scope filter', () => {
        for (let i = 0; i < MIN_SESSION_TOOL_CALLS; i++) {
            logRow('a', 'edit', { scope: { kind: 'codebase', key: 'repo-a' } });
        }
        for (let i = 0; i < MIN_SESSION_TOOL_CALLS; i++) {
            logRow('b', 'edit', { scope: { kind: 'codebase', key: 'repo-b' } });
        }
        const aOnly = listCandidateSessions({ scope: { kind: 'codebase', key: 'repo-a' } });
        expect(aOnly).toContain('a');
        expect(aOnly).not.toContain('b');
    });
});

describe('loadSessionLog', () => {
    it('returns null for an unknown session', () => {
        expect(loadSessionLog('nope')).toBeNull();
    });

    it('aggregates skill_hits and total_tokens', () => {
        logRow('s', 'read', { tokens: 100 });
        logRow('s', 'edit', { tokens: 200, skill_hit: 1 });
        logRow('s', 'bash', { tokens: null });
        const session = loadSessionLog('s');
        expect(session).not.toBeNull();
        expect(session?.rows.length).toBe(3);
        expect(session?.total_skill_hits).toBe(1);
        expect(session?.total_tokens).toBe(300);
    });

    it('infers scope from the first scoped row', () => {
        logRow('s', 'read');
        logRow('s', 'edit', { scope: { kind: 'codebase', key: 'repo-x' } });
        const session = loadSessionLog('s');
        expect(session?.inferred_scope).toEqual({ kind: 'codebase', key: 'repo-x' });
    });
});

describe('shouldSkip heuristic', () => {
    function fakeSession(rows: Array<{ tool_name: string }>): SessionLog {
        return {
            session_id: 'fake',
            rows: rows.map((r) => ({
                tool_name: r.tool_name,
                query_text: null,
                result_count: 1,
                skill_hit: 0,
                tokens_spent: null,
                timestamp: '2026-01-01',
            })),
            started_at: '2026-01-01',
            ended_at: '2026-01-01',
            total_skill_hits: 0,
            total_tokens: 0,
            inferred_scope: null,
        };
    }

    it('skips sessions below the call threshold', () => {
        const reason = shouldSkip(fakeSession([{ tool_name: 'edit' }]));
        expect(reason).toMatch(/too few/);
    });

    it('skips sessions with only read-like calls', () => {
        const reason = shouldSkip(
            fakeSession([{ tool_name: 'search' }, { tool_name: 'read' }, { tool_name: 'concept' }]),
        );
        expect(reason).toMatch(/no write-like/);
    });

    it('passes sessions with at least one write-like call', () => {
        expect(
            shouldSkip(
                fakeSession([
                    { tool_name: 'search' },
                    { tool_name: 'read' },
                    { tool_name: 'edit' },
                ]),
            ),
        ).toBeNull();
    });
});

/** ─── extractTrajectory (with mock LLM) ─── */

describe('extractTrajectory', () => {
    const session: SessionLog = {
        session_id: 's',
        rows: [
            {
                tool_name: 'read',
                query_text: 'q',
                result_count: 1,
                skill_hit: 0,
                tokens_spent: 10,
                timestamp: '2026-01-01T00:00:00Z',
            },
            {
                tool_name: 'edit',
                query_text: 'q',
                result_count: 1,
                skill_hit: 0,
                tokens_spent: 10,
                timestamp: '2026-01-01T00:00:01Z',
            },
            {
                tool_name: 'bash',
                query_text: 'q',
                result_count: 1,
                skill_hit: 0,
                tokens_spent: 10,
                timestamp: '2026-01-01T00:00:02Z',
            },
        ],
        started_at: '2026-01-01T00:00:00Z',
        ended_at: '2026-01-01T00:00:02Z',
        total_skill_hits: 0,
        total_tokens: 30,
        inferred_scope: null,
    };

    it('returns kind=extracted on a valid LLM response', async () => {
        const proposed: ProposedTrajectory = {
            task: 'fix typecheck error',
            outcome: 'success',
            steps: [
                {
                    tool: 'read',
                    args: { file_path: 'a.ts' },
                    result_summary: 'opened',
                    result_ok: true,
                },
                {
                    tool: 'edit',
                    args: { file_path: 'a.ts' },
                    result_summary: 'patched',
                    result_ok: true,
                },
                {
                    tool: 'bash',
                    args: { command: 'pnpm lint' },
                    result_summary: 'ok',
                    result_ok: true,
                },
            ],
        };
        const result = await extractTrajectory(
            session,
            CONFIG_STUB,
            mockChat({ is_skill: true, ...proposed }),
        );
        expect(result.kind).toBe('extracted');
        if (result.kind === 'extracted') {
            expect(result.trajectory.task).toBe('fix typecheck error');
            expect(result.trajectory.steps.length).toBe(3);
        }
    });

    it('returns kind=no_skill when the LLM rejects the session', async () => {
        const result = await extractTrajectory(
            session,
            CONFIG_STUB,
            mockChat({ is_skill: false, reason: 'looked like browsing' }),
        );
        expect(result.kind).toBe('no_skill');
        if (result.kind === 'no_skill') expect(result.reason).toBe('looked like browsing');
    });

    it('returns kind=failed when the LLM throws', async () => {
        const result = await extractTrajectory(
            session,
            CONFIG_STUB,
            mockChatThrowing(new Error('network down')),
        );
        expect(result.kind).toBe('failed');
        if (result.kind === 'failed') expect(result.reason).toMatch(/network down/);
    });

    it('returns kind=failed when the LLM returns is_skill=true but missing task', async () => {
        const result = await extractTrajectory(
            session,
            CONFIG_STUB,
            mockChat({ is_skill: true, outcome: 'success', steps: [] }),
        );
        expect(result.kind).toBe('failed');
        if (result.kind === 'failed') expect(result.reason).toMatch(/missing or empty task/);
    });

    it('returns kind=failed when the LLM omits is_skill flag', async () => {
        const result = await extractTrajectory(session, CONFIG_STUB, mockChat({ task: 'x' }));
        expect(result.kind).toBe('failed');
    });
});

/** ─── session-reviews store CRUD ─── */

describe('session_reviews store', () => {
    it('recordReview inserts and getReview reads it back', () => {
        recordReview({ session_id: 'r1', outcome: 'extracted', trajectory_id: 'src-123' });
        const r = getReview('r1');
        expect(r?.outcome).toBe('extracted');
        expect(r?.trajectory_id).toBe('src-123');
    });

    it('recordReview is idempotent (re-record overwrites)', () => {
        recordReview({ session_id: 'r2', outcome: 'failed' });
        recordReview({ session_id: 'r2', outcome: 'extracted', trajectory_id: 'src-x' });
        const r = getReview('r2');
        expect(r?.outcome).toBe('extracted');
        expect(r?.trajectory_id).toBe('src-x');
        expect(countReviews()).toBe(1);
    });

    it('listReviews returns newest first', async () => {
        recordReview({ session_id: 'a', outcome: 'no_skill' });
        await new Promise((r) => setTimeout(r, 5));
        recordReview({ session_id: 'b', outcome: 'extracted' });
        const list = listReviews();
        expect(list[0].session_id).toBe('b');
    });
});

/** ─── reviewSessions orchestrator ─── */

describe('reviewSessions orchestrator', () => {
    function seedReviewableSession(name: string, scope?: { kind: 'codebase'; key: string }): void {
        logRow(name, 'read', { scope });
        logRow(name, 'edit', { scope });
        logRow(name, 'bash', { scope });
    }

    it('records "skipped" for sessions that fail the heuristic', async () => {
        logRow('readonly', 'read');
        logRow('readonly', 'search');
        logRow('readonly', 'concept');
        const summary = await reviewSessions(CONFIG_STUB, {
            chat: mockChat({ is_skill: true, task: 't', outcome: 'success', steps: [] }),
        });
        expect(summary.sessions_skipped).toBe(1);
        expect(getReview('readonly')?.outcome).toBe('skipped');
    });

    it('records "no_skill" when the extractor rejects', async () => {
        seedReviewableSession('rejected');
        const summary = await reviewSessions(CONFIG_STUB, {
            chat: mockChat({ is_skill: false, reason: 'thrashing' }),
        });
        expect(summary.sessions_no_skill).toBe(1);
        expect(getReview('rejected')?.outcome).toBe('no_skill');
    });

    it('dry-run records "extracted" without creating a trajectory row', async () => {
        seedReviewableSession('dry');
        const summary = await reviewSessions(CONFIG_STUB, {
            chat: mockChat({
                is_skill: true,
                task: 'unique-dry-task',
                outcome: 'success',
                steps: [
                    { tool: 'read', args: {}, result_summary: 'ok', result_ok: true },
                    { tool: 'edit', args: {}, result_summary: 'ok', result_ok: true },
                    { tool: 'bash', args: {}, result_summary: 'ok', result_ok: true },
                ],
            }),
            autoCapture: false,
        });
        expect(summary.sessions_extracted).toBe(1);
        expect(summary.trajectories_created).toEqual([]);
        const review = getReview('dry');
        expect(review?.trajectory_id).toBeNull();
        expect(review?.notes).toMatch(/proposed/);
        const trajs = listSources({ type: 'trajectory' });
        expect(trajs).toEqual([]);
    });

    it('auto-capture writes the trajectory and records the source_id', async () => {
        seedReviewableSession('auto', { kind: 'codebase', key: 'repo-a' });
        const summary = await reviewSessions(CONFIG_STUB, {
            chat: mockChat({
                is_skill: true,
                task: 'unique-auto-task',
                outcome: 'success',
                steps: [
                    { tool: 'read', args: {}, result_summary: 'ok', result_ok: true },
                    { tool: 'edit', args: {}, result_summary: 'patched', result_ok: true },
                    { tool: 'bash', args: {}, result_summary: 'ok', result_ok: true },
                ],
            }),
            autoCapture: true,
            cwd: tempDir,
        });
        expect(summary.sessions_extracted).toBe(1);
        expect(summary.trajectories_created.length).toBe(1);
        const id = summary.trajectories_created[0];
        const source = getSource(id);
        expect(source).not.toBeNull();
        expect(source?.source_type).toBe('trajectory');
        expect(getReview('auto')?.trajectory_id).toBe(id);
    });

    it('idempotency: re-running skips sessions with existing review records', async () => {
        seedReviewableSession('idem');
        const chat = mockChat({ is_skill: false, reason: 'first pass' });
        const first = await reviewSessions(CONFIG_STUB, { chat });
        expect(first.sessions_inspected).toBe(1);
        const second = await reviewSessions(CONFIG_STUB, { chat });
        expect(second.sessions_inspected).toBe(0);
    });

    it('records "failed" when extractor throws and surfaces the reason in notes', async () => {
        seedReviewableSession('failing');
        await reviewSessions(CONFIG_STUB, { chat: mockChatThrowing(new Error('boom')) });
        const review = getReview('failing');
        expect(review?.outcome).toBe('failed');
        expect(review?.notes).toMatch(/boom/);
    });
});
