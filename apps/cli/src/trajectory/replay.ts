/**
 * Trajectory replay path.
 *
 * BM25 over trajectory chunks, then filtered to the caller's scope. Returns
 * the top scope-matching trajectory plus drift caveats so the agent can
 * decide whether to follow the recipe literally, adapt it, or ignore it.
 *
 * Replay returns a hint, not a contract. Drift detection (codebase revision
 * diff, missing file refs, failure outcomes) lets the agent see what changed
 * since the trajectory was captured.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { searchBm25 } from '../search/bm25.js';
import { getSource } from '../store/sources.js';
import { findProjectRoot } from '../scope/codebase.js';
import { resolveCodebase } from '../scope/index.js';
import type { ScopeKind } from '../types/index.js';
import type { FindReplayResult, ReplayCaveat, ReplayMatch, TrajectoryMetadata } from './types.js';

export type FindReplayOptions = {
    /** Scope to match against. Defaults to `resolveCodebase(cwd)`. */
    scope?: { kind: ScopeKind; key: string };
    /** Working directory used for default scope resolution and drift detection. */
    cwd?: string;
    /** Soft minimum score to consider. Defaults to 0 (return any match). */
    min_score?: number;
    /** How many top candidates to return alongside `skill`. Defaults to 5. */
    limit?: number;
};

/**
 * Find the best replayable trajectory for `task` in the current (or supplied) scope.
 * Returns a typed result with the top match + ranked candidates + drift caveats.
 */
export function findReplay(task: string, opts: FindReplayOptions = {}): FindReplayResult {
    const cwd = opts.cwd ?? process.cwd();
    const scope = opts.scope ?? resolveCodebase(cwd);
    const limit = opts.limit ?? 5;
    const minScore = opts.min_score ?? 0;

    /** Over-fetch and filter by source_type + scope. BM25 alone can't filter. */
    const raw = searchBm25(task, limit * 6);

    const matchesBySource = new Map<string, { score: number; metadata: TrajectoryMetadata }>();

    for (const hit of raw) {
        if (hit.score < minScore) continue;
        const source = getSource(hit.source_id);
        if (!source || source.source_type !== 'trajectory') continue;
        if (source.scope_kind !== scope.kind || source.scope_key !== scope.key) continue;

        const existing = matchesBySource.get(hit.source_id);
        if (existing && existing.score >= hit.score) continue;

        const metadata = parseMetadata(source.metadata);
        if (!metadata) continue;

        matchesBySource.set(hit.source_id, { score: hit.score, metadata });
    }

    const head = readGitRevision(cwd);

    const ranked: ReplayMatch[] = [];
    for (const [source_id, { score, metadata }] of matchesBySource.entries()) {
        const caveats = computeCaveats(metadata, cwd, head);
        ranked.push({ source_id, score, metadata, caveats });
    }
    ranked.sort((a, b) => scoreWithOutcomePenalty(b) - scoreWithOutcomePenalty(a));

    const top = ranked[0] ?? null;
    return {
        found: top !== null,
        skill: top,
        candidates: ranked.slice(0, limit),
    };
}

/**
 * Penalize failure / partial outcomes so a partially-broken trajectory loses
 * to a successful one even when its FTS score is slightly higher.
 */
function scoreWithOutcomePenalty(m: ReplayMatch): number {
    const outcomePenalty =
        m.metadata.outcome === 'success' ? 0 : m.metadata.outcome === 'partial' ? 0.2 : 0.5;
    return m.score - outcomePenalty;
}

function parseMetadata(raw: string | null): TrajectoryMetadata | null {
    if (!raw) return null;
    try {
        return JSON.parse(raw) as TrajectoryMetadata;
    } catch {
        return null;
    }
}

function computeCaveats(
    metadata: TrajectoryMetadata,
    cwd: string,
    head: string | null,
): ReplayCaveat[] {
    const caveats: ReplayCaveat[] = [];

    if (metadata.outcome !== 'success') {
        caveats.push({ type: 'failure_outcome', outcome: metadata.outcome });
    }

    if (metadata.codebase_revision && head && metadata.codebase_revision !== head) {
        caveats.push({
            type: 'revision_diff',
            from: metadata.codebase_revision,
            to: head,
            commits_behind: countCommitsBetween(cwd, metadata.codebase_revision, head),
        });
    }

    const root = findProjectRoot(cwd);
    for (const step of metadata.steps) {
        const filePath = pickFilePath(step.args);
        if (!filePath) continue;
        const absolute = isAbsolute(filePath) ? filePath : join(root, filePath);
        if (!existsSync(absolute)) {
            caveats.push({ type: 'missing_file', step: step.n, file_path: filePath });
        }
    }

    return caveats;
}

/** Common arg-name conventions for file references across coding agents. */
const FILE_PATH_ARG_NAMES = ['file_path', 'path', 'filename', 'file'];

function pickFilePath(args: Record<string, unknown>): string | null {
    for (const name of FILE_PATH_ARG_NAMES) {
        const value = args[name];
        if (typeof value === 'string' && value.length > 0) return value;
    }
    return null;
}

function readGitRevision(cwd: string): string | null {
    const root = findProjectRoot(cwd);
    if (!existsSync(join(root, '.git'))) return null;
    try {
        const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
            cwd: root,
            stdio: ['ignore', 'pipe', 'ignore'],
            encoding: 'utf-8',
            timeout: 2000,
        }).trim();
        return sha || null;
    } catch {
        return null;
    }
}

function countCommitsBetween(cwd: string, from: string, to: string): number | null {
    const root = findProjectRoot(cwd);
    try {
        const out = execFileSync('git', ['rev-list', '--count', `${from}..${to}`], {
            cwd: root,
            stdio: ['ignore', 'pipe', 'ignore'],
            encoding: 'utf-8',
            timeout: 2000,
        }).trim();
        const n = parseInt(out, 10);
        return Number.isFinite(n) ? n : null;
    } catch {
        return null;
    }
}
