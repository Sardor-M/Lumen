/**
 * Master-key storage. The 32-byte `Kx` lives in the platform keychain so the
 * SQLite file alone is useless to an attacker who obtains it. Tier 5c uses
 * this to load `Kx` before push/pull; nothing else in the codebase touches
 * the keychain.
 *
 * Backends:
 *   - 'macos'       — shells out to `security add/find/delete-generic-password`
 *   - 'secret-tool' — Linux libsecret CLI (GNOME Keyring, KWallet via D-Bus)
 *   - 'file'        — `<LUMEN_DIR>/.sync-key` with mode 0600. v1 fallback for
 *                     Windows + Linux without libsecret. Documented as such.
 *   - 'memory'      — in-process Map. Tests inject this via setKeyringBackend.
 *
 * Backend selection:
 *   1. `LUMEN_KEYRING_BACKEND` env var if set
 *   2. `setKeyringBackend()` (test-only override)
 *   3. Platform default: macOS → 'macos'; Linux with `secret-tool` on PATH →
 *      'secret-tool'; everything else → 'file'
 *
 * The key is stored base64-encoded so the keychain doesn't see a binary blob.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../utils/paths.js';

const SERVICE = 'lumen';
const ACCOUNT = 'master-key';
const FILE_NAME = '.sync-key';

export type KeyringBackend = 'macos' | 'secret-tool' | 'file' | 'memory';

let override: KeyringBackend | null = null;
let memoryStore: Buffer | null = null;

export function setKeyringBackend(backend: KeyringBackend | null): void {
    override = backend;
    if (backend !== 'memory') memoryStore = null;
}

export function getKeyringBackend(): KeyringBackend {
    if (override) return override;
    const fromEnv = process.env.LUMEN_KEYRING_BACKEND;
    if (
        fromEnv === 'macos' ||
        fromEnv === 'secret-tool' ||
        fromEnv === 'file' ||
        fromEnv === 'memory'
    ) {
        return fromEnv;
    }
    if (process.platform === 'darwin') return 'macos';
    if (process.platform === 'linux' && hasSecretTool()) return 'secret-tool';
    return 'file';
}

export function setMasterKey(key: Buffer): void {
    if (key.length !== 32) {
        throw new Error(`master key must be 32 bytes, got ${key.length}`);
    }
    const b64 = key.toString('base64');
    switch (getKeyringBackend()) {
        case 'macos':
            return setMacOS(b64);
        case 'secret-tool':
            return setSecretTool(b64);
        case 'file':
            return setFile(b64);
        case 'memory':
            memoryStore = Buffer.from(key);
            return;
    }
}

export function getMasterKey(): Buffer | null {
    let b64: string | null;
    switch (getKeyringBackend()) {
        case 'macos':
            b64 = getMacOS();
            break;
        case 'secret-tool':
            b64 = getSecretTool();
            break;
        case 'file':
            b64 = getFile();
            break;
        case 'memory':
            return memoryStore ? Buffer.from(memoryStore) : null;
    }
    if (!b64) return null;
    const buf = Buffer.from(b64, 'base64');
    if (buf.length !== 32) return null;
    return buf;
}

export function deleteMasterKey(): void {
    switch (getKeyringBackend()) {
        case 'macos':
            return deleteMacOS();
        case 'secret-tool':
            return deleteSecretTool();
        case 'file':
            return deleteFile();
        case 'memory':
            memoryStore = null;
            return;
    }
}

export function hasMasterKey(): boolean {
    return getMasterKey() !== null;
}

/** ─── macOS (security CLI) ─── */

function setMacOS(b64: string): void {
    /** -U updates if the entry already exists. */
    execFileSync(
        'security',
        ['add-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w', b64, '-U'],
        { stdio: 'pipe' },
    );
}

function getMacOS(): string | null {
    const r = spawnSync('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'], {
        encoding: 'utf-8',
    });
    if (r.status !== 0) return null;
    const out = r.stdout.trim();
    return out.length > 0 ? out : null;
}

function deleteMacOS(): void {
    spawnSync('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT], {
        stdio: 'pipe',
    });
}

/** ─── Linux (secret-tool / libsecret) ─── */

function hasSecretTool(): boolean {
    const r = spawnSync('secret-tool', ['--version'], { stdio: 'pipe' });
    return r.status === 0;
}

function setSecretTool(b64: string): void {
    /**
     * `secret-tool store` reads the secret from stdin. The flag set is:
     *   --label   "Lumen master key"  (shows in keyring UIs)
     *   service   lumen
     *   account   master-key
     */
    const r = spawnSync(
        'secret-tool',
        ['store', '--label', 'Lumen master key', 'service', SERVICE, 'account', ACCOUNT],
        { input: b64, encoding: 'utf-8' },
    );
    if (r.status !== 0) {
        throw new Error(`secret-tool store failed: ${r.stderr || 'unknown error'}`);
    }
}

function getSecretTool(): string | null {
    const r = spawnSync('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT], {
        encoding: 'utf-8',
    });
    if (r.status !== 0) return null;
    const out = r.stdout.trim();
    return out.length > 0 ? out : null;
}

function deleteSecretTool(): void {
    spawnSync('secret-tool', ['clear', 'service', SERVICE, 'account', ACCOUNT], { stdio: 'pipe' });
}

/** ─── File fallback (mode 0600 in LUMEN_DIR) ─── */

function filePath(): string {
    return join(getDataDir(), FILE_NAME);
}

function setFile(b64: string): void {
    const path = filePath();
    writeFileSync(path, b64, { encoding: 'utf-8', mode: 0o600 });
    /** writeFileSync's `mode` only applies on create; chmod ensures perms on overwrite. */
    chmodSync(path, 0o600);
}

function getFile(): string | null {
    const path = filePath();
    if (!existsSync(path)) return null;
    const content = readFileSync(path, 'utf-8').trim();
    return content.length > 0 ? content : null;
}

function deleteFile(): void {
    const path = filePath();
    if (existsSync(path)) unlinkSync(path);
}
