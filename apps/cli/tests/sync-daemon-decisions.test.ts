import { describe, it, expect } from 'vitest';
import {
    chooseCadence,
    chooseInterval,
    recordPull,
    shouldPush,
    type DaemonState,
} from '../src/sync/daemon-decisions.js';
import { DEFAULT_SYNC_DAEMON_CONFIG, type SyncDaemonConfig } from '../src/sync/daemon-install.js';

const config: SyncDaemonConfig = { ...DEFAULT_SYNC_DAEMON_CONFIG };

function emptyState(overrides: Partial<DaemonState> = {}): DaemonState {
    return {
        unpushedCount: 0,
        recentPullCounts: [],
        lastWriteAt: null,
        lastPushAt: null,
        ...overrides,
    };
}

describe('chooseCadence (#28 adaptive interval)', () => {
    it('warmup keeps Active until idleAfter pulls observed', () => {
        const state = emptyState();
        expect(chooseCadence(state, config)).toBe('active');
    });

    it('Active when unpushed > 0 even if pulls are empty', () => {
        const state = emptyState({
            unpushedCount: 1,
            recentPullCounts: [0, 0, 0, 0],
        });
        expect(chooseCadence(state, config)).toBe('active');
    });

    it('Idle after idleAfter consecutive empty pulls AND no unpushed', () => {
        const state = emptyState({
            unpushedCount: 0,
            recentPullCounts: [0, 0, 0],
        });
        expect(chooseCadence(state, config)).toBe('idle');
    });

    it('Active when last pull window contains a non-empty pull', () => {
        const state = emptyState({
            unpushedCount: 0,
            recentPullCounts: [0, 5, 0],
        });
        expect(chooseCadence(state, config)).toBe('active');
    });

    it('chooseInterval returns ms (active path)', () => {
        const state = emptyState({ unpushedCount: 1 });
        expect(chooseInterval(state, config)).toBe(config.intervalActiveSec * 1000);
    });

    it('chooseInterval returns ms (idle path)', () => {
        const state = emptyState({ recentPullCounts: [0, 0, 0] });
        expect(chooseInterval(state, config)).toBe(config.intervalIdleSec * 1000);
    });
});

describe('shouldPush (#29 push debounce)', () => {
    it('false when nothing is unpushed', () => {
        const state = emptyState({ unpushedCount: 0, lastWriteAt: 1000 });
        expect(shouldPush(2000, state, config)).toBe(false);
    });

    it('true on first observation (lastWriteAt === null) — drains existing backlog', () => {
        const state = emptyState({ unpushedCount: 1, lastWriteAt: null });
        expect(shouldPush(0, state, config)).toBe(true);
    });

    it('false during the debounce window after a recent write', () => {
        const state = emptyState({ unpushedCount: 1, lastWriteAt: 10_000 });
        const within = 10_000 + (config.debounceSec * 1000) / 2;
        expect(shouldPush(within, state, config)).toBe(false);
    });

    it('true once debounce window has elapsed', () => {
        const state = emptyState({ unpushedCount: 1, lastWriteAt: 10_000 });
        const after = 10_000 + config.debounceSec * 1000 + 1;
        expect(shouldPush(after, state, config)).toBe(true);
    });

    it('boundary: exactly debounceSec * 1000 elapsed - allows push', () => {
        const state = emptyState({ unpushedCount: 1, lastWriteAt: 10_000 });
        const at = 10_000 + config.debounceSec * 1000;
        expect(shouldPush(at, state, config)).toBe(true);
    });
});

describe('recordPull window management', () => {
    it('appends a pull observation and caps the window at idleAfter', () => {
        let state = emptyState();
        for (let i = 0; i < config.idleAfter + 2; i++) {
            state = recordPull(state, i, config);
        }
        expect(state.recentPullCounts).toHaveLength(config.idleAfter);
        /** Latest (idleAfter) entries should be the most recent. */
        const expected = Array.from({ length: config.idleAfter }, (_, k) => 2 + k);
        expect(state.recentPullCounts).toEqual(expected);
    });

    it('preserves immutability — does not mutate the input state', () => {
        const before = emptyState({ recentPullCounts: [1] });
        recordPull(before, 2, config);
        expect(before.recentPullCounts).toEqual([1]);
    });
});
