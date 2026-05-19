/**
 * Long-running sync daemon loop.
 *
 * Started by `lumen sync daemon __run` — a hidden subcommand that the
 * launchd/systemd unit invokes. Each tick:
 *
 *   1. Read journal watermark + unpushed count to detect new writes since
 *      the previous tick (#29 push-debounce input).
 *   2. Decide push vs. skip via `shouldPush()` (#29).
 *   3. Run pull always (cheap when nothing is new). Push only when allowed.
 *   4. Record the cycle's pulled count and pick the next sleep duration
 *      via `chooseInterval()` (#28 adaptive interval).
 *   5. setTimeout for the next tick; signal handlers exit cleanly.
 *
 * Mirrors `apps/cli/src/daemon/scheduler.ts` (the connector-watch daemon)
 * for shape — PID file, signal-driven shutdown, single in-flight tick guard.
 */

import { rmSync, writeFileSync } from 'node:fs';
import { getDb } from '../store/database.js';
import { countUnpushed, latestJournalSyncId } from './journal.js';
import { runPush, runPull } from './sync-driver.js';
import { applyPending } from './apply.js';
import { getSyncDaemonPidPath } from '../utils/paths.js';
import { chooseInterval, recordPull, shouldPush, type DaemonState } from './daemon-decisions.js';
import { DEFAULT_SYNC_DAEMON_CONFIG, type SyncDaemonConfig } from './daemon-install.js';

type LoopState = {
    running: boolean;
    timer: NodeJS.Timeout | null;
    decision: DaemonState;
    /** Last sync_id observed on the previous tick — null until the first tick reads the journal. */
    lastSeenWatermark: string | null;
};

const loopState: LoopState = {
    running: false,
    timer: null,
    decision: {
        unpushedCount: 0,
        recentPullCounts: [],
        lastWriteAt: null,
        lastPushAt: null,
    },
    lastSeenWatermark: null,
};

/**
 * Read daemon config from environment variables baked into the launchd /
 * systemd unit by `installSyncDaemon()`. Falls back to defaults when running
 * the daemon outside the managed install (eg. local dev `lumen sync daemon __run`).
 */
export function readConfigFromEnv(): SyncDaemonConfig {
    const num = (key: string, fallback: number): number => {
        const raw = process.env[key];
        if (raw === undefined || raw === '') return fallback;
        const parsed = Number(raw);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    };
    return {
        intervalActiveSec: num(
            'LUMEN_SYNC_DAEMON_INTERVAL_ACTIVE',
            DEFAULT_SYNC_DAEMON_CONFIG.intervalActiveSec,
        ),
        intervalIdleSec: num(
            'LUMEN_SYNC_DAEMON_INTERVAL_IDLE',
            DEFAULT_SYNC_DAEMON_CONFIG.intervalIdleSec,
        ),
        idleAfter: num('LUMEN_SYNC_DAEMON_IDLE_AFTER', DEFAULT_SYNC_DAEMON_CONFIG.idleAfter),
        debounceSec: num('LUMEN_SYNC_DAEMON_DEBOUNCE', DEFAULT_SYNC_DAEMON_CONFIG.debounceSec),
    };
}

/**
 * Run the sync daemon in the current process. Writes a PID file at start,
 * removes it on graceful shutdown. Resolves when SIGTERM/SIGINT arrives.
 *
 * The clock + setTimeout are injectable via opts so tests can drive the loop
 * deterministically without sleeping.
 */
export type RunDaemonOptions = {
    config?: SyncDaemonConfig;
    /** Test seam: returns wall-clock ms. Defaults to Date.now. */
    now?: () => number;
    /** Test seam: schedules the next tick. Defaults to global setTimeout. */
    schedule?: (cb: () => void, ms: number) => unknown;
    /** Test seam: cancels a pending tick. Defaults to clearTimeout. */
    cancel?: (h: unknown) => void;
};

export async function runSyncDaemon(opts: RunDaemonOptions = {}): Promise<void> {
    if (loopState.running) return;
    loopState.running = true;

    const config = opts.config ?? readConfigFromEnv();
    const now = opts.now ?? Date.now;
    const schedule = opts.schedule ?? ((cb, ms) => setTimeout(cb, ms));
    const cancel = opts.cancel ?? ((h) => clearTimeout(h as NodeJS.Timeout));

    getDb();
    writeFileSync(getSyncDaemonPidPath(), String(process.pid));

    log('sync daemon started', {
        pid: process.pid,
        active_sec: config.intervalActiveSec,
        idle_sec: config.intervalIdleSec,
        idle_after: config.idleAfter,
        debounce_sec: config.debounceSec,
    });

    return new Promise<void>((resolve) => {
        const stop = () => {
            shutdown(cancel);
            resolve();
        };
        process.once('SIGTERM', stop);
        process.once('SIGINT', stop);

        /** First tick fires immediately so a pending push doesn't wait a cadence. */
        void tick(config, now)
            .catch((err) => log('tick error', { error: errMsg(err) }))
            .then(() => scheduleNextTick(config, now, schedule));
    });
}

function scheduleNextTick(
    config: SyncDaemonConfig,
    now: () => number,
    schedule: (cb: () => void, ms: number) => unknown,
): void {
    if (!loopState.running) return;
    const sleep = chooseInterval(loopState.decision, config);
    loopState.timer = schedule(() => {
        void tick(config, now)
            .catch((err) => log('tick error', { error: errMsg(err) }))
            .then(() => scheduleNextTick(config, now, schedule));
    }, sleep) as NodeJS.Timeout;
}

/**
 * Single tick. Exported for tests so they can drive the loop deterministically
 * via `runOneTick(state, config, now)` without spinning the real timer chain.
 */
export async function runOneTick(config: SyncDaemonConfig, now: () => number): Promise<void> {
    return tick(config, now);
}

async function tick(config: SyncDaemonConfig, now: () => number): Promise<void> {
    /** ─── Watermark probe (#29) ────────────────────────────────────── */
    const watermark = latestJournalSyncId();
    const wallNow = now();
    if (watermark !== loopState.lastSeenWatermark) {
        if (loopState.lastSeenWatermark !== null) {
            /** A new write arrived since the previous tick — bump debounce. */
            loopState.decision.lastWriteAt = wallNow;
        }
        loopState.lastSeenWatermark = watermark;
    }
    loopState.decision.unpushedCount = countUnpushed();

    /** ─── Push gate (#29) ─────────────────────────────────────────── */
    const canPush = shouldPush(wallNow, loopState.decision, config);
    if (canPush) {
        const pushResult = await runPush();
        loopState.decision.lastPushAt = wallNow;
        /** Re-read after push so the next decision has the post-push count. */
        loopState.decision.unpushedCount = countUnpushed();
        if (pushResult.errors.length > 0) {
            log('push errors', { count: pushResult.errors.length, first: pushResult.errors[0] });
        } else if (pushResult.pushed > 0) {
            log('push ok', { pushed: pushResult.pushed });
        }
    }

    /** ─── Pull (always) ───────────────────────────────────────────── */
    const pullResult = await runPull();
    if (pullResult.errors.length > 0) {
        log('pull errors', { count: pullResult.errors.length, first: pullResult.errors[0] });
    } else if (pullResult.pulled > 0) {
        log('pull ok', { pulled: pullResult.pulled });
    }

    /** ─── Apply pulled-but-unapplied entries ──────────────────────── */
    if (pullResult.pulled > 0) {
        const apply = applyPending();
        if (apply.applied > 0 || apply.failed.length > 0) {
            log('apply', { applied: apply.applied, failed: apply.failed.length });
        }
    }

    /** ─── Cadence record (#28) ────────────────────────────────────── */
    loopState.decision = recordPull(loopState.decision, pullResult.pulled, config);
}

function shutdown(cancel: (h: unknown) => void): void {
    if (!loopState.running) return;
    loopState.running = false;
    if (loopState.timer) {
        cancel(loopState.timer);
        loopState.timer = null;
    }
    try {
        rmSync(getSyncDaemonPidPath(), { force: true });
    } catch {
        /** Best-effort cleanup; the file may already be gone. */
    }
    log('sync daemon stopped', { pid: process.pid });
}

/** Test helper. Resets internal state between tests in a single process. */
export function resetSyncDaemonStateForTests(): void {
    loopState.running = false;
    if (loopState.timer) clearTimeout(loopState.timer);
    loopState.timer = null;
    loopState.decision = {
        unpushedCount: 0,
        recentPullCounts: [],
        lastWriteAt: null,
        lastPushAt: null,
    };
    loopState.lastSeenWatermark = null;
}

function log(msg: string, fields: Record<string, unknown> = {}): void {
    const entry = { ts: new Date().toISOString(), msg, ...fields };
    process.stdout.write(`${JSON.stringify(entry)}\n`);
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
