import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { setDataDir, resetDataDir } from '../src/utils/paths.js';
import { getDb, resetDb } from '../src/store/database.js';
import { getSource, listSources } from '../src/store/sources.js';
import { searchBm25 } from '../src/search/bm25.js';
import {
    captureTrajectory,
    findReplay,
    validateTrajectory,
    TrajectoryValidationError,
    LIMIT_RESULT_SUMMARY_CHARS,
    LIMIT_ARGS_BYTES,
    LIMIT_STEPS,
    TRAJECTORY_FORMAT_VERSION,
} from '../src/trajectory/index.js';
import type { TrajectoryMetadata, TrajectoryStep } from '../src/trajectory/index.js';

let dataDir: string;
let workDir: string;

beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lumen-traj-data-'));
    workDir = mkdtempSync(join(tmpdir(), 'lumen-traj-work-'));
    setDataDir(dataDir);
    getDb();
});

afterEach(() => {
    resetDb();
    resetDataDir();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
});

function initGitRepo(path: string, remoteUrl?: string): void {
    spawnSync('git', ['init', '-q', '--initial-branch=main', path], { stdio: 'ignore' });
    spawnSync('git', ['-C', path, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
    spawnSync('git', ['-C', path, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
    if (remoteUrl) {
        spawnSync('git', ['-C', path, 'remote', 'add', 'origin', remoteUrl], { stdio: 'ignore' });
    }
}

function commitAll(path: string, message: string): string {
    spawnSync('git', ['-C', path, 'add', '-A'], { stdio: 'ignore' });
    spawnSync('git', ['-C', path, 'commit', '-q', '-m', message], { stdio: 'ignore' });
    const sha = spawnSync('git', ['-C', path, 'rev-parse', '--short', 'HEAD'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf-8',
    }).stdout.trim();
    return sha;
}

function step(
    n: number,
    tool: string,
    args: Record<string, unknown>,
    summary: string,
    ok = true,
): TrajectoryStep {
    return {
        n,
        tool,
        args,
        result_summary: summary,
        result_ok: ok,
        elapsed_ms: 100,
    };
}

/* ─── validateTrajectory ─── */

describe('validateTrajectory', () => {
    function metaWith(steps: TrajectoryStep[]): TrajectoryMetadata {
        return {
            v: TRAJECTORY_FORMAT_VERSION,
            task: 'task',
            steps,
            outcome: 'success',
            agent: 'test',
            session_id: 's',
            total_tokens: null,
            total_elapsed_ms: null,
            scope: { kind: 'codebase', key: 'k' },
            inputs: null,
            codebase_revision: null,
        };
    }

    it('rejects empty step list', () => {
        expect(() => validateTrajectory(metaWith([]))).toThrow(TrajectoryValidationError);
    });

    it('rejects > LIMIT_STEPS steps', () => {
        const steps = Array.from({ length: LIMIT_STEPS + 1 }, (_, i) =>
            step(i, 'read', { file_path: 'a' }, 'ok'),
        );
        expect(() => validateTrajectory(metaWith(steps))).toThrow(TrajectoryValidationError);
        try {
            validateTrajectory(metaWith(steps));
        } catch (err) {
            expect((err as TrajectoryValidationError).code).toBe('TOO_MANY_STEPS');
        }
    });

    it('truncates result_summary above LIMIT_RESULT_SUMMARY_CHARS', () => {
        const long = 'x'.repeat(LIMIT_RESULT_SUMMARY_CHARS + 100);
        const out = validateTrajectory(metaWith([step(0, 'bash', {}, long)]));
        expect(out.metadata.steps[0].result_summary.length).toBeLessThanOrEqual(
            LIMIT_RESULT_SUMMARY_CHARS,
        );
        expect(out.metadata.steps[0].result_summary.endsWith('...')).toBe(true);
        expect(out.diagnostics.truncations).toBe(1);
    });

    it('replaces oversized args with a stub and reports bytes dropped', () => {
        const huge = 'a'.repeat(LIMIT_ARGS_BYTES + 100);
        const out = validateTrajectory(metaWith([step(0, 'bash', { input: huge }, 'ok')]));
        expect(out.metadata.steps[0].args).toEqual({
            __truncated: expect.stringMatching(/^<\d+ bytes dropped>$/),
        });
        expect(out.diagnostics.args_bytes_dropped).toBeGreaterThan(LIMIT_ARGS_BYTES);
    });

    it('preserves valid metadata untouched', () => {
        const m = metaWith([step(0, 'read', { file_path: 'src/a.ts' }, 'read 10 lines')]);
        const out = validateTrajectory(m);
        expect(out.metadata.steps[0].result_summary).toBe('read 10 lines');
        expect(out.diagnostics.truncations).toBe(0);
    });
});

/* ─── captureTrajectory ─── */

describe('captureTrajectory', () => {
    it('inserts a source row with source_type=trajectory and metadata JSON', () => {
        writeFileSync(join(workDir, 'package.json'), '{}');
        const result = captureTrajectory({
            task: 'add column to schema',
            steps: [
                step(0, 'read', { file_path: 'schema.ts' }, 'read schema'),
                step(1, 'edit', { file_path: 'schema.ts' }, 'added column'),
                step(2, 'bash', { command: 'pnpm test' }, 'tests passed'),
            ],
            outcome: 'success',
            cwd: workDir,
        });

        expect(result.step_count).toBe(3);
        const source = getSource(result.source_id);
        expect(source).not.toBeNull();
        expect(source?.source_type).toBe('trajectory');
        expect(source?.title).toBe('add column to schema');
        const metadata = JSON.parse(source?.metadata ?? 'null') as TrajectoryMetadata;
        expect(metadata.v).toBe(TRAJECTORY_FORMAT_VERSION);
        expect(metadata.steps.length).toBe(3);
        expect(metadata.outcome).toBe('success');
    });

    it('auto-resolves scope from cwd when not provided', () => {
        writeFileSync(join(workDir, 'package.json'), '{}');
        const result = captureTrajectory({
            task: 't',
            steps: [step(0, 'read', { file_path: 'a' }, 'ok')],
            outcome: 'success',
            cwd: workDir,
        });
        expect(result.scope.kind).toBe('codebase');
        expect(result.scope.key).toMatch(/^[a-f0-9]{16}$/);
    });

    it('honors explicitly provided scope', () => {
        const result = captureTrajectory({
            task: 't',
            steps: [step(0, 'read', { file_path: 'a' }, 'ok')],
            outcome: 'success',
            scope: { kind: 'framework', key: 'next' },
            cwd: workDir,
        });
        expect(result.scope).toEqual({ kind: 'framework', key: 'next' });
        const source = getSource(result.source_id);
        expect(source?.scope_kind).toBe('framework');
        expect(source?.scope_key).toBe('next');
    });

    it('persists git revision when capture happens inside a git repo', () => {
        initGitRepo(workDir, 'https://github.com/test/captured.git');
        writeFileSync(join(workDir, 'a.txt'), 'hello');
        const sha = commitAll(workDir, 'init');

        const result = captureTrajectory({
            task: 't',
            steps: [step(0, 'read', { file_path: 'a' }, 'ok')],
            outcome: 'success',
            cwd: workDir,
        });
        const source = getSource(result.source_id);
        const metadata = JSON.parse(source?.metadata ?? 'null') as TrajectoryMetadata;
        expect(metadata.codebase_revision).toBe(sha);
    });

    it('lands per-step chunks in the FTS index', () => {
        writeFileSync(join(workDir, 'package.json'), '{}');
        captureTrajectory({
            task: 'fix typecheck error',
            steps: [
                step(0, 'bash', { command: 'pnpm lint' }, 'tsc error: Property missing'),
                step(1, 'read', { file_path: 'types.ts' }, 'opened type definition'),
                step(2, 'edit', { file_path: 'types.ts' }, 'added missing property'),
                step(3, 'bash', { command: 'pnpm lint' }, 'OK'),
            ],
            outcome: 'success',
            cwd: workDir,
        });
        const hits = searchBm25('typecheck', 10);
        expect(hits.length).toBeGreaterThan(0);
        expect(hits[0].source_title).toBe('fix typecheck error');
    });

    it('rejects too-many-steps capture with TOO_MANY_STEPS', () => {
        const steps = Array.from({ length: LIMIT_STEPS + 1 }, (_, i) =>
            step(i, 'read', { file_path: 'a' }, 'ok'),
        );
        try {
            captureTrajectory({
                task: 't',
                steps,
                outcome: 'success',
                cwd: workDir,
            });
            throw new Error('expected captureTrajectory to throw TrajectoryValidationError');
        } catch (err) {
            expect(err).toBeInstanceOf(TrajectoryValidationError);
            expect((err as TrajectoryValidationError).code).toBe('TOO_MANY_STEPS');
        }
    });

    it('reports truncation diagnostics in the result', () => {
        const long = 'x'.repeat(LIMIT_RESULT_SUMMARY_CHARS + 50);
        const result = captureTrajectory({
            task: 't',
            steps: [step(0, 'bash', {}, long)],
            outcome: 'success',
            cwd: workDir,
        });
        expect(result.truncations).toBe(1);
    });

    it('touches the scopes registry for codebase scopes', () => {
        writeFileSync(join(workDir, 'package.json'), '{}');
        captureTrajectory({
            task: 't',
            steps: [step(0, 'read', { file_path: 'a' }, 'ok')],
            outcome: 'success',
            cwd: workDir,
        });
        const rows = getDb()
            .prepare("SELECT COUNT(*) AS c FROM scopes WHERE kind = 'codebase'")
            .get() as { c: number };
        expect(rows.c).toBeGreaterThanOrEqual(1);
    });
});

/* ─── findReplay ─── */

describe('findReplay', () => {
    it('returns the matching trajectory in the same scope', () => {
        writeFileSync(join(workDir, 'package.json'), '{}');
        captureTrajectory({
            task: 'add a new MCP tool to the server',
            steps: [
                step(0, 'read', { file_path: 'server.ts' }, 'read mcp server'),
                step(1, 'edit', { file_path: 'server.ts' }, 'inserted tool registration'),
                step(2, 'bash', { command: 'pnpm test' }, 'green'),
            ],
            outcome: 'success',
            cwd: workDir,
        });

        const result = findReplay('add MCP tool', { cwd: workDir });
        expect(result.found).toBe(true);
        expect(result.skill?.metadata.task).toBe('add a new MCP tool to the server');
        expect(result.skill?.metadata.steps.length).toBe(3);
    });

    it('filters out trajectories from other scopes', () => {
        captureTrajectory({
            task: 'add column elsewhere',
            steps: [step(0, 'edit', { file_path: 'schema.ts' }, 'added column')],
            outcome: 'success',
            scope: { kind: 'codebase', key: 'other-codebase-key' },
            cwd: workDir,
        });

        writeFileSync(join(workDir, 'package.json'), '{}');
        const result = findReplay('add column', { cwd: workDir });
        expect(result.found).toBe(false);
        expect(result.candidates.length).toBe(0);
    });

    it('flags revision_diff when current HEAD differs from captured revision', () => {
        initGitRepo(workDir, 'https://github.com/test/drift.git');
        writeFileSync(join(workDir, 'a.txt'), '1');
        commitAll(workDir, 'first');

        captureTrajectory({
            task: 'unique drift task',
            steps: [step(0, 'read', { file_path: 'a.txt' }, 'ok')],
            outcome: 'success',
            cwd: workDir,
        });

        writeFileSync(join(workDir, 'b.txt'), '2');
        commitAll(workDir, 'second');

        const result = findReplay('unique drift task', { cwd: workDir });
        expect(result.found).toBe(true);
        const revisionCaveat = result.skill?.caveats.find((c) => c.type === 'revision_diff');
        expect(revisionCaveat).toBeDefined();
    });

    it('flags missing_file when a step references a file that no longer exists', () => {
        writeFileSync(join(workDir, 'package.json'), '{}');
        const src = join(workDir, 'src');
        mkdirSync(src);
        writeFileSync(join(src, 'gone.ts'), 'temp');

        captureTrajectory({
            task: 'unique missing file task',
            steps: [step(0, 'read', { file_path: 'src/gone.ts' }, 'opened gone.ts')],
            outcome: 'success',
            cwd: workDir,
        });

        rmSync(join(src, 'gone.ts'));

        const result = findReplay('unique missing file task', { cwd: workDir });
        expect(result.found).toBe(true);
        const missing = result.skill?.caveats.find((c) => c.type === 'missing_file');
        expect(missing).toBeDefined();
    });

    it('downweights failure outcomes against successes for the same query', () => {
        writeFileSync(join(workDir, 'package.json'), '{}');
        /** Captured failure first - higher in BM25 if newer, but should lose to success on rerank. */
        captureTrajectory({
            task: 'install dependency',
            steps: [step(0, 'bash', { command: 'pnpm add x' }, 'EREMOTE error', false)],
            outcome: 'failure',
            cwd: workDir,
        });
        captureTrajectory({
            task: 'install dependency',
            steps: [step(0, 'bash', { command: 'pnpm add x --no-frozen' }, 'ok')],
            outcome: 'success',
            cwd: workDir,
        });

        const result = findReplay('install dependency', { cwd: workDir });
        expect(result.skill?.metadata.outcome).toBe('success');
    });

    it('returns found=false when no trajectory matches', () => {
        const result = findReplay('totally unrelated query goes here', { cwd: workDir });
        expect(result.found).toBe(false);
        expect(result.skill).toBeNull();
    });
});

/* ─── Source listing integration ─── */

describe('trajectory source integration', () => {
    it('listSources({type: trajectory}) finds captured trajectories', () => {
        writeFileSync(join(workDir, 'package.json'), '{}');
        captureTrajectory({
            task: 't1',
            steps: [step(0, 'read', { file_path: 'a' }, 'ok')],
            outcome: 'success',
            cwd: workDir,
        });
        captureTrajectory({
            task: 't2',
            steps: [step(0, 'read', { file_path: 'b' }, 'ok')],
            outcome: 'partial',
            cwd: workDir,
        });
        const list = listSources({ type: 'trajectory' });
        expect(list.length).toBe(2);
        expect(list.every((s) => s.source_type === 'trajectory')).toBe(true);
    });
});
