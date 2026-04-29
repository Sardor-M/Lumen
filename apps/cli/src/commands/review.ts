/**
 * `lumen review trajectories` — walk recently logged sessions, hand each to
 * the LLM extractor, and (with `--auto`) write any extracted trajectory via
 * the existing `captureTrajectory()` path.
 *
 * Without `--auto` the command runs in dry-run mode: review records are
 * written so the same session isn't re-inspected on the next run, but no
 * trajectory rows are created. Useful for inspecting what the extractor
 * would do before letting it write anything.
 */

import type { Command } from 'commander';
import { getDb } from '../store/database.js';
import { reviewSessions } from '../review/index.js';
import { listReviews } from '../store/session-reviews.js';
import { loadConfig } from '../utils/config.js';
import * as log from '../utils/logger.js';

type ReviewOptions = {
    since?: string;
    limit?: string;
    auto?: boolean;
    scope?: string;
    status?: boolean;
};

export function registerReview(program: Command): void {
    const review = program
        .command('review')
        .description('Inspect recently logged sessions and propose / capture trajectories');

    review
        .command('trajectories')
        .description('Run the LLM-driven trajectory extraction over unreviewed sessions')
        .option('--since <duration>', 'Window of recency: 7d, 24h, 30m. Default 14d.', '14d')
        .option('-n, --limit <n>', 'Max sessions to inspect this run. Default 50.', '50')
        .option(
            '--auto',
            'Auto-write any extracted trajectory via captureTrajectory(). Default off (dry-run).',
        )
        .option(
            '--scope <kind:key>',
            'Only review sessions in this scope, e.g. codebase:abc123def4567890.',
        )
        .option('--status', 'Show prior review outcomes without running a new pass.')
        .action(async (opts: ReviewOptions) => {
            try {
                const config = loadConfig();
                getDb();

                if (opts.status) {
                    showStatus();
                    return;
                }

                const sinceMs = parseDuration(opts.since ?? '14d');
                const limit = Number.parseInt(opts.limit ?? '50', 10);
                const scope = parseScope(opts.scope);

                log.info(
                    `Reviewing sessions: since=${opts.since ?? '14d'} limit=${limit}` +
                        (scope ? ` scope=${scope.kind}:${scope.key}` : '') +
                        (opts.auto ? ' (auto-capture ON)' : ' (dry-run)'),
                );

                const summary = await reviewSessions(config, {
                    sinceMs,
                    limit,
                    scope: scope ?? undefined,
                    autoCapture: opts.auto === true,
                });

                log.heading('Review summary');
                log.table({
                    inspected: summary.sessions_inspected,
                    extracted: summary.sessions_extracted,
                    no_skill: summary.sessions_no_skill,
                    failed: summary.sessions_failed,
                    skipped: summary.sessions_skipped,
                });
                if (summary.trajectories_created.length > 0) {
                    log.success(`Captured ${summary.trajectories_created.length} trajectories:`);
                    for (const id of summary.trajectories_created) log.dim(`  ${id}`);
                } else if (summary.sessions_extracted > 0 && !opts.auto) {
                    log.dim(
                        `${summary.sessions_extracted} extractable session${summary.sessions_extracted === 1 ? '' : 's'} found - re-run with --auto to capture.`,
                    );
                }
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });
}

function showStatus(): void {
    const reviews = listReviews(20);
    if (reviews.length === 0) {
        log.dim('No reviews recorded yet. Run `lumen review trajectories` to start.');
        return;
    }
    log.heading(`Recent reviews (${reviews.length})`);
    for (const r of reviews) {
        log.table({
            session: r.session_id,
            outcome: r.outcome,
            trajectory: r.trajectory_id ?? '-',
            notes: r.notes ?? '',
            at: r.reviewed_at,
        });
    }
}

/**
 * Parse a duration string into milliseconds. Supports 7d, 24h, 30m, 60s.
 * Throws on malformed input - caller's try/catch turns it into a CLI error.
 */
function parseDuration(input: string): number {
    const match = /^(\d+)\s*(s|m|h|d)$/i.exec(input.trim());
    if (!match) {
        throw new Error(`Invalid --since value: ${input}. Use 7d, 24h, 30m, or 60s.`);
    }
    const n = Number.parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const multiplier =
        unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    return n * multiplier;
}

/**
 * Parse a `kind:key` scope spec. Returns null when the input is empty or
 * undefined. Throws on a malformed value (missing `:` or empty key).
 */
function parseScope(
    input: string | undefined,
): { kind: 'codebase' | 'framework' | 'language' | 'personal' | 'team'; key: string } | null {
    if (!input) return null;
    const colon = input.indexOf(':');
    if (colon < 1 || colon === input.length - 1) {
        throw new Error(`Invalid --scope value: ${input}. Use kind:key, e.g. codebase:abc123.`);
    }
    const kind = input.slice(0, colon);
    const key = input.slice(colon + 1);
    if (
        kind !== 'codebase' &&
        kind !== 'framework' &&
        kind !== 'language' &&
        kind !== 'personal' &&
        kind !== 'team'
    ) {
        throw new Error(`Invalid scope kind: ${kind}.`);
    }
    return { kind, key };
}
