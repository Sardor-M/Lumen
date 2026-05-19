/**
 * `lumen sync daemon install` — generate launchd (macOS) or systemd (Linux)
 * units for a long-running sync daemon and load them.
 *
 * Mirrors the shape of `apps/cli/src/daemon/install.ts` (which manages the
 * connector-watch daemon) but for a separate, sibling daemon dedicated to
 * sync. Two daemons coexist with separate labels, PID files, and log files.
 *
 * Migration: PR #27 shipped manual launchd/systemd templates that users
 * could copy into `~/Library/LaunchAgents/com.lumen.sync.plist`. Those used
 * a short-lived `StartInterval=120` shape (oneshot per tick), whereas the
 * managed daemon installed here is long-running with `KeepAlive=true` and
 * an internal tick loop. We detect the manual shape by inspecting the
 * existing plist for `<key>StartInterval</key>` AND absence of
 * `<key>KeepAlive</key>` — and replace it when `--replace-manual` is set
 * (or when the user opts in interactively).
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getDataDir, getSyncDaemonLogPath, getSyncDaemonPidPath } from '../utils/paths.js';

export type SyncDaemonConfig = {
    /** Active-mode tick interval in seconds. Used when journal_unpushed > 0 or last cycle pulled rows. */
    intervalActiveSec: number;
    /** Idle-mode tick interval in seconds. Used after `idleAfter` consecutive empty pulls. */
    intervalIdleSec: number;
    /** Number of consecutive empty pulls before transitioning Active -> Idle. */
    idleAfter: number;
    /** Push-debounce window in seconds. Bursts of journal writes coalesce into a single push. */
    debounceSec: number;
};

export const DEFAULT_SYNC_DAEMON_CONFIG: SyncDaemonConfig = {
    intervalActiveSec: 30,
    intervalIdleSec: 300,
    idleAfter: 3,
    debounceSec: 5,
};

export type SyncDaemonInstallResult = {
    platform: 'macos' | 'linux';
    unit_path: string;
    already_installed: boolean;
    replaced_manual: boolean;
    config: SyncDaemonConfig;
    follow_up: string;
};

export type SyncDaemonUninstallResult = {
    platform: 'macos' | 'linux';
    unit_path: string;
    removed: boolean;
};

export type SyncDaemonInstallOptions = {
    config?: Partial<SyncDaemonConfig>;
    /** If true, replace a manually-installed (PR #27-template) plist/unit without prompting. */
    replaceManual?: boolean;
};

const LAUNCHD_LABEL = 'com.lumen.sync';
const SYSTEMD_UNIT_NAME = 'lumen-sync.service';

/** Install a launchd plist (macOS) or a systemd user unit (Linux) for the sync daemon. */
export function installSyncDaemon(opts: SyncDaemonInstallOptions = {}): SyncDaemonInstallResult {
    const os = detectPlatform();
    const config = mergeConfig(opts.config);
    return os === 'macos'
        ? installLaunchd(config, opts.replaceManual ?? false)
        : installSystemd(config, opts.replaceManual ?? false);
}

/** Remove the sync daemon unit and unload it. */
export function uninstallSyncDaemon(): SyncDaemonUninstallResult {
    const os = detectPlatform();
    return os === 'macos' ? uninstallLaunchd() : uninstallSystemd();
}

export type SyncDaemonStatus = {
    platform: 'macos' | 'linux';
    installed: boolean;
    unit_path: string;
    /** True if the unit looks like the long-running managed shape we install. */
    managed: boolean;
    /** True if the unit looks like the PR #27 manual short-lived template. */
    manual: boolean;
    pid_file: string;
    pid_alive: boolean;
};

/** Read on-disk state of the sync daemon — installed? managed-shape? pid alive? */
export function syncDaemonStatus(): SyncDaemonStatus {
    const os = detectPlatform();
    const unit_path = os === 'macos' ? launchdPlistPath() : systemdUnitPath();
    const installed = existsSync(unit_path);
    let manual = false;
    let managed = false;
    if (installed) {
        const contents = readFileSync(unit_path, 'utf-8');
        manual = looksManual(contents, os);
        managed = !manual;
    }
    const pid_file = getSyncDaemonPidPath();
    const pid_alive = isPidAlive(pid_file);
    return { platform: os, installed, unit_path, managed, manual, pid_file, pid_alive };
}

function isPidAlive(pidFile: string): boolean {
    if (!existsSync(pidFile)) return false;
    const raw = readFileSync(pidFile, 'utf-8').trim();
    const pid = Number(raw);
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/* ----- Helpers shared across platforms --------------------------------- */

function detectPlatform(): 'macos' | 'linux' {
    if (platform() === 'darwin') return 'macos';
    if (platform() === 'linux') return 'linux';
    throw new Error(
        `Sync daemon is only supported on macOS (launchd) and Linux (systemd). Detected: ${platform()}`,
    );
}

function mergeConfig(partial: Partial<SyncDaemonConfig> | undefined): SyncDaemonConfig {
    return { ...DEFAULT_SYNC_DAEMON_CONFIG, ...(partial ?? {}) };
}

function resolveExec(): { node: string; script: string } {
    return {
        node: realpathSync(process.execPath),
        script: realpathSync(process.argv[1]),
    };
}

/**
 * Heuristic: PR #27 manual templates use `StartInterval` (launchd) or
 * `Type=oneshot` + a sibling `.timer` (systemd) — neither shape lives long.
 * The managed install uses `KeepAlive`/`Type=simple` (long-running). If both
 * markers are absent we err on the side of "not manual" so unrelated units
 * don't get clobbered.
 */
function looksManual(contents: string, os: 'macos' | 'linux'): boolean {
    if (os === 'macos') {
        return (
            contents.includes('<key>StartInterval</key>') &&
            !contents.includes('<key>KeepAlive</key>')
        );
    }
    return /^\s*Type=oneshot\s*$/m.test(contents);
}

function envBlockEntries(config: SyncDaemonConfig, lumenDir: string): Record<string, string> {
    return {
        LUMEN_DIR: lumenDir,
        LUMEN_SYNC_DAEMON_INTERVAL_ACTIVE: String(config.intervalActiveSec),
        LUMEN_SYNC_DAEMON_INTERVAL_IDLE: String(config.intervalIdleSec),
        LUMEN_SYNC_DAEMON_IDLE_AFTER: String(config.idleAfter),
        LUMEN_SYNC_DAEMON_DEBOUNCE: String(config.debounceSec),
    };
}

/* ----- macOS / launchd ------------------------------------------------ */

function launchdPlistPath(): string {
    return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function installLaunchd(config: SyncDaemonConfig, replaceManual: boolean): SyncDaemonInstallResult {
    const plistPath = launchdPlistPath();
    const alreadyExists = existsSync(plistPath);
    let replacedManual = false;

    if (alreadyExists) {
        const existing = readFileSync(plistPath, 'utf-8');
        if (looksManual(existing, 'macos')) {
            if (!replaceManual) {
                throw new Error(
                    `A manually-installed sync plist exists at ${plistPath} (from PR #27 templates). ` +
                        `Re-run with --replace-manual to let lumen take over and replace it.`,
                );
            }
            replacedManual = true;
            const uidEarly = process.getuid?.() ?? 0;
            spawnSync('launchctl', ['bootout', `gui/${uidEarly}/${LAUNCHD_LABEL}`], {
                stdio: 'ignore',
            });
        }
    }

    const { node, script } = resolveExec();
    const plist = renderPlist({
        label: LAUNCHD_LABEL,
        node,
        script,
        env: envBlockEntries(config, getDataDir()),
        logPath: getSyncDaemonLogPath(),
    });

    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, plist, 'utf-8');

    /** launchctl bootstrap is idempotent when unloaded first. */
    const uid = process.getuid?.() ?? 0;
    spawnSync('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`], { stdio: 'ignore' });
    const boot = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], {
        stdio: 'ignore',
    });
    if (boot.status !== 0) {
        throw new Error(
            `Wrote ${plistPath} but launchctl bootstrap failed (exit ${boot.status}). Try: launchctl load ${plistPath}`,
        );
    }

    return {
        platform: 'macos',
        unit_path: plistPath,
        already_installed: alreadyExists && !replacedManual,
        replaced_manual: replacedManual,
        config,
        follow_up: `Sync daemon auto-starts on login. Inspect with: launchctl print gui/${uid}/${LAUNCHD_LABEL}`,
    };
}

function uninstallLaunchd(): SyncDaemonUninstallResult {
    const plistPath = launchdPlistPath();
    const uid = process.getuid?.() ?? 0;
    spawnSync('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`], { stdio: 'ignore' });
    const existed = existsSync(plistPath);
    if (existed) rmSync(plistPath, { force: true });
    /** Best-effort PID file cleanup; the daemon itself removes it on graceful stop. */
    const pidPath = getSyncDaemonPidPath();
    if (existsSync(pidPath)) rmSync(pidPath, { force: true });
    return { platform: 'macos', unit_path: plistPath, removed: existed };
}

function renderPlist(params: {
    label: string;
    node: string;
    script: string;
    env: Record<string, string>;
    logPath: string;
}): string {
    const args = [params.node, params.script, 'sync', 'daemon', '__run']
        .map((a) => `        <string>${xmlEscape(a)}</string>`)
        .join('\n');

    const envEntries = Object.entries(params.env)
        .map(
            ([k, v]) =>
                `        <key>${xmlEscape(k)}</key>\n        <string>${xmlEscape(v)}</string>`,
        )
        .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${params.label}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${xmlEscape(params.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(params.logPath)}</string>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(homedir())}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
`;
}

function xmlEscape(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/* ----- Linux / systemd ------------------------------------------------ */

function systemdUnitPath(): string {
    return join(homedir(), '.config', 'systemd', 'user', SYSTEMD_UNIT_NAME);
}

function systemdTimerPath(): string {
    return join(homedir(), '.config', 'systemd', 'user', 'lumen-sync.timer');
}

function installSystemd(config: SyncDaemonConfig, replaceManual: boolean): SyncDaemonInstallResult {
    const unitPath = systemdUnitPath();
    const alreadyExists = existsSync(unitPath);
    let replacedManual = false;

    if (alreadyExists) {
        const existing = readFileSync(unitPath, 'utf-8');
        if (looksManual(existing, 'linux')) {
            if (!replaceManual) {
                throw new Error(
                    `A manually-installed sync service exists at ${unitPath} (from PR #27 templates). ` +
                        `Re-run with --replace-manual to let lumen take over and replace it.`,
                );
            }
            replacedManual = true;
            spawnSync('systemctl', ['--user', 'disable', '--now', 'lumen-sync.timer'], {
                stdio: 'ignore',
            });
            spawnSync('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT_NAME], {
                stdio: 'ignore',
            });
            const timerPath = systemdTimerPath();
            if (existsSync(timerPath)) rmSync(timerPath, { force: true });
        }
    }

    const { node, script } = resolveExec();
    const unit = renderSystemdUnit({
        node,
        script,
        env: envBlockEntries(config, getDataDir()),
        logPath: getSyncDaemonLogPath(),
    });

    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, unit, 'utf-8');

    const reload = spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    if (reload.status !== 0) {
        throw new Error(
            `Wrote ${unitPath} but \`systemctl --user daemon-reload\` failed. Enable manually with: systemctl --user enable --now ${SYSTEMD_UNIT_NAME}`,
        );
    }
    const enable = spawnSync('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME], {
        stdio: 'ignore',
    });
    if (enable.status !== 0) {
        throw new Error(
            `Wrote ${unitPath} but \`systemctl --user enable --now ${SYSTEMD_UNIT_NAME}\` failed. Try running it manually.`,
        );
    }

    return {
        platform: 'linux',
        unit_path: unitPath,
        already_installed: alreadyExists && !replacedManual,
        replaced_manual: replacedManual,
        config,
        follow_up: `Sync daemon auto-starts on login. Inspect with: systemctl --user status ${SYSTEMD_UNIT_NAME}`,
    };
}

function uninstallSystemd(): SyncDaemonUninstallResult {
    const unitPath = systemdUnitPath();
    spawnSync('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT_NAME], { stdio: 'ignore' });
    const existed = existsSync(unitPath);
    if (existed) rmSync(unitPath, { force: true });
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    const pidPath = getSyncDaemonPidPath();
    if (existsSync(pidPath)) rmSync(pidPath, { force: true });
    return { platform: 'linux', unit_path: unitPath, removed: existed };
}

function renderSystemdUnit(params: {
    node: string;
    script: string;
    env: Record<string, string>;
    logPath: string;
}): string {
    const envLines = Object.entries(params.env)
        .map(([k, v]) => `Environment="${k}=${v}"`)
        .join('\n');

    return `[Unit]
Description=Lumen sync daemon (long-running, adaptive interval, push debounce)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${params.node} ${params.script} sync daemon __run
Restart=on-failure
RestartSec=30
${envLines}
StandardOutput=append:${params.logPath}
StandardError=append:${params.logPath}

[Install]
WantedBy=default.target
`;
}
