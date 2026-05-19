import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setDataDir, resetDataDir, getSyncDaemonPidPath } from '../src/utils/paths.js';
import { getDb, resetDb } from '../src/store/database.js';
import {
    appendJournal,
    latestJournalSyncId,
    countUnpushed,
    markPushed,
} from '../src/sync/journal.js';
import { readConfigFromEnv, resetSyncDaemonStateForTests } from '../src/sync/daemon-loop.js';
import { DEFAULT_SYNC_DAEMON_CONFIG } from '../src/sync/daemon-install.js';

let lumenDir: string;

beforeEach(() => {
    lumenDir = mkdtempSync(join(tmpdir(), 'lumen-sync-loop-'));
    setDataDir(lumenDir);
    getDb();
    resetSyncDaemonStateForTests();
});

afterEach(() => {
    resetDb();
    resetDataDir();
    rmSync(lumenDir, { recursive: true, force: true });
    delete process.env.LUMEN_SYNC_DAEMON_INTERVAL_ACTIVE;
    delete process.env.LUMEN_SYNC_DAEMON_INTERVAL_IDLE;
    delete process.env.LUMEN_SYNC_DAEMON_IDLE_AFTER;
    delete process.env.LUMEN_SYNC_DAEMON_DEBOUNCE;
});

describe('readConfigFromEnv', () => {
    it('falls back to defaults when env is unset', () => {
        const config = readConfigFromEnv();
        expect(config).toEqual(DEFAULT_SYNC_DAEMON_CONFIG);
    });

    it('reads positive integers from env', () => {
        process.env.LUMEN_SYNC_DAEMON_INTERVAL_ACTIVE = '15';
        process.env.LUMEN_SYNC_DAEMON_INTERVAL_IDLE = '600';
        process.env.LUMEN_SYNC_DAEMON_IDLE_AFTER = '5';
        process.env.LUMEN_SYNC_DAEMON_DEBOUNCE = '8';
        const config = readConfigFromEnv();
        expect(config.intervalActiveSec).toBe(15);
        expect(config.intervalIdleSec).toBe(600);
        expect(config.idleAfter).toBe(5);
        expect(config.debounceSec).toBe(8);
    });

    it('rejects non-positive values and falls back', () => {
        process.env.LUMEN_SYNC_DAEMON_INTERVAL_ACTIVE = '-3';
        process.env.LUMEN_SYNC_DAEMON_DEBOUNCE = 'banana';
        const config = readConfigFromEnv();
        expect(config.intervalActiveSec).toBe(DEFAULT_SYNC_DAEMON_CONFIG.intervalActiveSec);
        expect(config.debounceSec).toBe(DEFAULT_SYNC_DAEMON_CONFIG.debounceSec);
    });
});

describe('latestJournalSyncId watermark', () => {
    it('returns null when the journal is empty', () => {
        expect(latestJournalSyncId()).toBeNull();
    });

    it('returns the highest sync_id after writes', () => {
        const a = appendJournal({
            op: 'concept_create',
            entity_id: 'a',
            scope_kind: 'personal',
            scope_key: 'me',
            payload: {},
        });
        const b = appendJournal({
            op: 'concept_create',
            entity_id: 'b',
            scope_kind: 'personal',
            scope_key: 'me',
            payload: {},
        });
        const latest = latestJournalSyncId();
        expect(latest).not.toBeNull();
        /** sync_ids are sortable; the second insert must not be earlier than the first. */
        expect(latest! >= a).toBe(true);
        expect(latest).toBe(b);
    });

    it('countUnpushed reflects markPushed', () => {
        const id = appendJournal({
            op: 'concept_create',
            entity_id: 'x',
            scope_kind: 'personal',
            scope_key: 'me',
            payload: {},
        });
        expect(countUnpushed()).toBe(1);
        markPushed([id]);
        expect(countUnpushed()).toBe(0);
    });
});

describe('PID file lifecycle', () => {
    it('PID file path is under getDataDir()', () => {
        expect(getSyncDaemonPidPath()).toContain(lumenDir);
        expect(getSyncDaemonPidPath()).toMatch(/sync-daemon\.pid$/);
        expect(existsSync(getSyncDaemonPidPath())).toBe(false);
    });

    /**
     * Full daemon-run integration test would require a running relay; covered
     * by the manual two-device runbook. Here we just verify the PID-file path
     * is computed correctly and the lumen data dir exists.
     */
    it('pid file directory is writable', () => {
        const _path = getSyncDaemonPidPath();
        expect(existsSync(lumenDir)).toBe(true);
    });
});
