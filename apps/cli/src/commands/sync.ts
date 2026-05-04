/**
 * `lumen sync` — opt-in cross-device sync.
 *
 * Subcommands:
 *   init [--relay <url>]   generate or accept Kx, store in keyring, derive routing keys
 *   enable / disable       flip the runtime gate
 *   push                   one-shot push of unpushed journal entries
 *   pull                   one-shot pull from cursor
 *   apply                  drain pulled-but-unapplied entries into the local store
 *   run                    push then pull then apply (the standard cycle)
 *   status                 journal lag, last sync times, fingerprint
 *   reset-error            clear last_error after a circuit-break
 *   show-key [--reveal]    print the master key (base64) for sharing to a 2nd device
 *   import-key <base64>    accept an existing master key (2nd-device flow)
 */

import type { Command } from 'commander';
import { getDb } from '../store/database.js';
import { countJournal, countUnpushed } from '../sync/journal.js';
import { getOrInitSyncState, setEnabled, setRelayConfig } from '../sync/state.js';
import {
    getMasterKey,
    setMasterKey,
    deleteMasterKey,
    hasMasterKey,
    getKeyringBackend,
} from '../sync/keyring.js';
import {
    generateMasterKey,
    deriveUserHash,
    fingerprintMasterKey,
    MASTER_KEY_BYTES,
} from '../sync/crypto.js';
import { runPush, runPull, runSync, runApply, clearLastError } from '../sync/sync-driver.js';
import * as log from '../utils/logger.js';

type InitOptions = { relay?: string };
type ImportKeyOptions = { relay?: string };
type ShowKeyOptions = { reveal?: boolean };

export function registerSync(program: Command): void {
    const sync = program
        .command('sync')
        .description('Cross-device sync (opt-in, end-to-end encrypted)');

    sync.command('init')
        .description('Generate (or accept) a master key, store in keyring, configure relay')
        .option('--relay <url>', 'Relay URL to push/pull against')
        .action(async (opts: InitOptions) => {
            try {
                getDb();
                const existing = getMasterKey();
                let key: Buffer;
                if (existing) {
                    log.warn('Master key already in keyring — keeping existing key.');
                    key = existing;
                } else {
                    key = generateMasterKey();
                    setMasterKey(key);
                    log.success(
                        `Generated new master key (${MASTER_KEY_BYTES} bytes) and stored in ${getKeyringBackend()}.`,
                    );
                }

                const userHash = deriveUserHash(key);
                const fingerprint = fingerprintMasterKey(key);
                /**
                 * Conditional spread: passing `relay_url: null` would overwrite a
                 * previously-stored relay URL when re-running `sync init` without
                 * `--relay`. setRelayConfig only skips fields that are `undefined`,
                 * not `null`, so omit the key entirely unless `--relay` was given.
                 */
                setRelayConfig({
                    user_hash: userHash,
                    ...(opts.relay !== undefined ? { relay_url: opts.relay } : {}),
                    encryption_key_fingerprint: fingerprint,
                });

                const state = getOrInitSyncState();
                log.heading('Sync identity');
                log.table({
                    user_hash: userHash,
                    fingerprint,
                    relay: state.relay_url ?? '(unset)',
                    keyring: getKeyringBackend(),
                });
                log.dim('\nNext: `lumen sync enable` to start pushing/pulling.');
                log.dim(
                    'To add a second device: run `lumen sync show-key --reveal` here, then `lumen sync import-key <base64>` there.',
                );
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });

    sync.command('enable')
        .description('Enable sync — push/pull will run when invoked')
        .action(() => {
            try {
                getDb();
                if (!hasMasterKey()) {
                    log.error('No master key in keyring. Run `lumen sync init` first.');
                    process.exitCode = 1;
                    return;
                }
                setEnabled(true);
                log.success('Sync enabled.');
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });

    sync.command('disable')
        .description('Disable sync — journal continues, push/pull do not run')
        .action(() => {
            try {
                getDb();
                setEnabled(false);
                log.success('Sync disabled.');
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });

    sync.command('push')
        .description('One-shot push of unpushed journal entries to the relay')
        .action(async () => {
            try {
                getDb();
                const result = await runPush();
                logResult('push', result);
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });

    sync.command('pull')
        .description('One-shot pull from the relay since last cursor')
        .action(async () => {
            try {
                getDb();
                const result = await runPull();
                logResult('pull', result);
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });

    sync.command('run')
        .description('Push, pull, then apply in one cycle (the standard sync loop)')
        .action(async () => {
            try {
                getDb();
                const result = await runSync();
                logResult('sync', result);
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });

    sync.command('apply')
        .description('Apply pulled-but-unapplied journal entries to the local store')
        .action(() => {
            try {
                getDb();
                const result = runApply();
                logResult('apply', result);
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });

    sync.command('status')
        .description('Show sync state — journal lag, fingerprint, last error')
        .action(() => {
            try {
                getDb();
                const state = getOrInitSyncState();
                const total = countJournal();
                const unpushed = countUnpushed();
                log.heading('Sync status');
                log.table({
                    enabled: state.enabled === 1 ? 'yes' : 'no',
                    device_id: state.device_id,
                    user_hash: state.user_hash ?? '(unset)',
                    relay_url: state.relay_url ?? '(unset)',
                    fingerprint: state.encryption_key_fingerprint ?? '(unset)',
                    keyring: getKeyringBackend(),
                    has_key: hasMasterKey() ? 'yes' : 'no',
                    journal_total: total,
                    journal_unpushed: unpushed,
                    last_pushed: state.last_push_at ?? 'never',
                    last_pulled: state.last_pull_at ?? 'never',
                    last_error: state.last_error ?? '-',
                });
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });

    sync.command('reset-error')
        .description('Clear the circuit-breaker after a sustained failure')
        .action(() => {
            try {
                getDb();
                clearLastError();
                log.success('Cleared last_error and circuit-breaker counter.');
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });

    sync.command('show-key')
        .description('Print the master key (base64) for cross-device share')
        .option('--reveal', 'Required — confirms you want the key on screen')
        .action((opts: ShowKeyOptions) => {
            try {
                getDb();
                const key = getMasterKey();
                if (!key) {
                    log.error('No master key in keyring. Run `lumen sync init` first.');
                    process.exitCode = 1;
                    return;
                }
                if (!opts.reveal) {
                    log.warn(
                        'Re-run with --reveal to print the master key. Anyone with this key can read your synced data.',
                    );
                    return;
                }
                log.heading('Master key (base64)');
                /**
                 * Raw write — no log prefix — so the user can pipe or copy
                 * the key cleanly. CLAUDE.md forbids `console.log`; the log
                 * helpers all decorate output, which we don't want here.
                 */
                process.stdout.write(`${key.toString('base64')}\n`);
                log.dim(
                    `\nFingerprint: ${fingerprintMasterKey(key)}  (must match on the other device)`,
                );
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });

    sync.command('import-key')
        .description('Adopt an existing master key from another device (base64)')
        .argument('<base64>', 'Base64-encoded master key from `lumen sync show-key --reveal`')
        .option('--relay <url>', 'Relay URL (required on a fresh device; omit to keep existing)')
        .action((b64: string, opts: ImportKeyOptions) => {
            try {
                getDb();
                const key = Buffer.from(b64.trim(), 'base64');
                if (key.length !== MASTER_KEY_BYTES) {
                    log.error(
                        `Decoded key is ${key.length} bytes; expected ${MASTER_KEY_BYTES}. Check for copy-paste errors.`,
                    );
                    process.exitCode = 1;
                    return;
                }
                if (hasMasterKey()) {
                    log.error(
                        'A master key is already present. Run `lumen sync forget-key` first if you really want to overwrite.',
                    );
                    process.exitCode = 1;
                    return;
                }
                const state = getOrInitSyncState();
                const relayUrl = opts.relay ?? state.relay_url ?? null;
                setMasterKey(key);
                const userHash = deriveUserHash(key);
                const fingerprint = fingerprintMasterKey(key);
                setRelayConfig({
                    user_hash: userHash,
                    encryption_key_fingerprint: fingerprint,
                    relay_url: relayUrl,
                });
                log.success('Imported master key.');
                log.table({ user_hash: userHash, fingerprint, relay: relayUrl ?? '(unset)' });
                log.dim('Fingerprint should match the source device.');
                if (!relayUrl) {
                    log.warn(
                        'No relay configured. Run `lumen sync init --relay <url>` to set one.',
                    );
                }
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });

    sync.command('forget-key')
        .description('Delete the master key from this device (sync stops; remote data unaffected)')
        .action(() => {
            try {
                getDb();
                deleteMasterKey();
                setEnabled(false);
                log.success('Master key removed; sync disabled.');
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });
}

function logResult(
    label: string,
    result: {
        pushed: number;
        pulled: number;
        applied?: number;
        apply_failed?: number;
        rejected: number;
        errors: string[];
    },
): void {
    log.heading(`${label} result`);
    log.table({
        pushed: result.pushed,
        pulled: result.pulled,
        applied: result.applied ?? 0,
        apply_failed: result.apply_failed ?? 0,
        rejected: result.rejected,
        errors: result.errors.length,
    });
    if (result.errors.length > 0) {
        for (const e of result.errors) log.dim(`  - ${e}`);
        /**
         * Surface a non-zero exit so shell pipelines can detect a failed
         * sync (e.g. `lumen sync run && deploy.sh`). Without this, push
         * failures look identical to a clean run from the shell's POV.
         */
        process.exitCode = 1;
    }
}
