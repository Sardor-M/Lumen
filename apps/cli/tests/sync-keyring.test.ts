import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    setMasterKey,
    getMasterKey,
    deleteMasterKey,
    hasMasterKey,
    setKeyringBackend,
    getKeyringBackend,
} from '../src/sync/keyring.js';
import { setDataDir, resetDataDir } from '../src/utils/paths.js';

let tempDir: string;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lumen-keyring-'));
    setDataDir(tempDir);
});

afterEach(() => {
    setKeyringBackend(null);
    resetDataDir();
    rmSync(tempDir, { recursive: true, force: true });
});

describe('keyring — memory backend', () => {
    beforeEach(() => setKeyringBackend('memory'));

    it('reports the active backend', () => {
        expect(getKeyringBackend()).toBe('memory');
    });

    it('round-trips a 32-byte key', () => {
        const key = Buffer.alloc(32, 0x42);
        setMasterKey(key);
        const got = getMasterKey();
        expect(got).not.toBeNull();
        expect(got!.equals(key)).toBe(true);
    });

    it('returns null when no key is stored', () => {
        expect(getMasterKey()).toBeNull();
        expect(hasMasterKey()).toBe(false);
    });

    it('hasMasterKey is true after set, false after delete', () => {
        setMasterKey(Buffer.alloc(32, 1));
        expect(hasMasterKey()).toBe(true);
        deleteMasterKey();
        expect(hasMasterKey()).toBe(false);
    });

    it('overwrites prior keys when set again', () => {
        const a = Buffer.alloc(32, 0x11);
        const b = Buffer.alloc(32, 0x22);
        setMasterKey(a);
        setMasterKey(b);
        expect(getMasterKey()!.equals(b)).toBe(true);
    });

    it('rejects keys that are not exactly 32 bytes', () => {
        expect(() => setMasterKey(Buffer.alloc(16))).toThrow(/32 bytes/);
        expect(() => setMasterKey(Buffer.alloc(64))).toThrow(/32 bytes/);
    });

    it('does not leak state between backends', () => {
        setMasterKey(Buffer.alloc(32, 0x33));
        expect(hasMasterKey()).toBe(true);
        /** Switching backends discards the memory store. */
        setKeyringBackend('file');
        expect(hasMasterKey()).toBe(false);
        setKeyringBackend('memory');
        expect(hasMasterKey()).toBe(false);
    });
});

describe('keyring — file backend', () => {
    beforeEach(() => setKeyringBackend('file'));

    it('persists the key to <LUMEN_DIR>/.sync-key', () => {
        const key = Buffer.alloc(32, 0x55);
        setMasterKey(key);
        const path = join(tempDir, '.sync-key');
        const onDisk = readFileSync(path, 'utf-8').trim();
        expect(onDisk).toBe(key.toString('base64'));
    });

    it('writes the key file with mode 0600', () => {
        setMasterKey(Buffer.alloc(32, 1));
        const path = join(tempDir, '.sync-key');
        const mode = statSync(path).mode & 0o777;
        expect(mode).toBe(0o600);
    });

    it('round-trips a key across set/get/delete', () => {
        const key = Buffer.alloc(32, 0x77);
        setMasterKey(key);
        expect(getMasterKey()!.equals(key)).toBe(true);
        deleteMasterKey();
        expect(getMasterKey()).toBeNull();
    });

    it('returns null when the file is missing', () => {
        expect(getMasterKey()).toBeNull();
    });

    it('returns null when the file decodes to the wrong length', () => {
        const path = join(tempDir, '.sync-key');
        writeFileSync(path, Buffer.alloc(8).toString('base64'));
        expect(getMasterKey()).toBeNull();
    });

    it('overwrites and re-locks the file on subsequent set', () => {
        setMasterKey(Buffer.alloc(32, 1));
        setMasterKey(Buffer.alloc(32, 2));
        const path = join(tempDir, '.sync-key');
        const mode = statSync(path).mode & 0o777;
        expect(mode).toBe(0o600);
        expect(getMasterKey()![0]).toBe(2);
    });
});

describe('keyring — backend selection', () => {
    it('honors LUMEN_KEYRING_BACKEND when no explicit override', () => {
        const prior = process.env.LUMEN_KEYRING_BACKEND;
        process.env.LUMEN_KEYRING_BACKEND = 'memory';
        setKeyringBackend(null);
        try {
            expect(getKeyringBackend()).toBe('memory');
        } finally {
            if (prior === undefined) delete process.env.LUMEN_KEYRING_BACKEND;
            else process.env.LUMEN_KEYRING_BACKEND = prior;
        }
    });
});
