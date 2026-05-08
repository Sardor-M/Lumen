/**
 * Pure decision functions for the sync daemon loop.
 *
 *   chooseInterval(state, config) -> next-tick sleep ms (#28 adaptive interval)
 *   shouldPush(now, state, config) -> bool (#29 push debounce)
 *
 * Kept in a separate module from `daemon-loop.ts` so the decision matrix is
 * trivially unit-testable without standing up a real daemon, journal, or
 * relay. The loop module reads these and does the IO.
 */

import type { SyncDaemonConfig } from './daemon-install.js';

export type CadenceMode = 'active' | 'idle';

/**
 * Per-tick observable state the decisions read. `recentPullCounts` is a
 * sliding window of the last N pull results (length === config.idleAfter
 * after warmup). `unpushedCount` is the result of countUnpushed() for this
 * tick. `lastWriteAt` is the wall-clock ms of the most recent observed
 * journal mutation; null means "no writes seen since the daemon started".
 * `lastPushAt` is the most recent push attempt's wall clock; used as a
 * floor so we don't push more often than `debounceSec` even if writes are
 * continuous.
 */
export type DaemonState = {
    unpushedCount: number;
    recentPullCounts: number[];
    lastWriteAt: number | null;
    lastPushAt: number | null;
};

/**
 * Pick the next-tick sleep based on journal pressure.
 *
 *   Active (fast cadence)  - unpushedCount > 0 OR last cycle pulled > 0
 *   Idle   (slow cadence)  - the last `idleAfter` pulls all returned 0
 *                            AND unpushedCount == 0
 *
 * Warmup (recentPullCounts.length < idleAfter) stays Active so a freshly-
 * started daemon doesn't immediately go to sleep before it has data to
 * decide with.
 */
export function chooseCadence(state: DaemonState, config: SyncDaemonConfig): CadenceMode {
    if (state.unpushedCount > 0) return 'active';
    if (state.recentPullCounts.length < config.idleAfter) return 'active';
    const lastPulls = state.recentPullCounts.slice(-config.idleAfter);
    const allEmpty = lastPulls.every((n) => n === 0);
    return allEmpty ? 'idle' : 'active';
}

export function chooseInterval(state: DaemonState, config: SyncDaemonConfig): number {
    const mode = chooseCadence(state, config);
    return (mode === 'active' ? config.intervalActiveSec : config.intervalIdleSec) * 1000;
}

/**
 * Decide whether to push *this* tick.
 *
 *   true  - there are unpushed entries AND either:
 *             a) no writes have arrived since the last push window, or
 *             b) the last write is older than `debounceSec` (write burst settled)
 *   false - no unpushed entries, or the burst is still in-flight (a write
 *           arrived within the last `debounceSec` seconds).
 *
 * Pull cadence is independent of this decision — pull runs every tick at
 * the chosen cadence so writes from other devices are picked up promptly.
 * Only push is debounced.
 */
export function shouldPush(now: number, state: DaemonState, config: SyncDaemonConfig): boolean {
    if (state.unpushedCount === 0) return false;
    if (state.lastWriteAt === null) {
        /** Daemon just started — push the existing backlog immediately. */
        return true;
    }
    const debounceMs = config.debounceSec * 1000;
    /** Use the later of lastWriteAt / lastPushAt so a recent push also
     *  resets the window — prevents re-pushing every tick once the burst
     *  settles but unpushedCount stays > 0 (e.g. relay rejected some rows). */
    const anchor = Math.max(state.lastWriteAt, state.lastPushAt ?? Number.NEGATIVE_INFINITY);
    return now - anchor >= debounceMs;
}

/**
 * Append a pull-count observation to the ring buffer used by chooseCadence.
 * Window size is bounded to `idleAfter` so callers don't need to manage
 * memory. Pure for unit-testing.
 */
export function recordPull(
    state: DaemonState,
    pulledThisTick: number,
    config: SyncDaemonConfig,
): DaemonState {
    const next = [...state.recentPullCounts, pulledThisTick];
    while (next.length > config.idleAfter) next.shift();
    return { ...state, recentPullCounts: next };
}
