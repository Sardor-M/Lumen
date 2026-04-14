import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getDataDir, getDaemonLogPath } from '../utils/paths.js';

export type DaemonInstallResult = {
    platform: 'macos' | 'linux';
    unit_path: string;
    already_installed: boolean;
    follow_up: string;
};

export type DaemonUninstallResult = {
    platform: 'macos' | 'linux';
    unit_path: string;
    removed: boolean;
};

const LAUNCHD_LABEL = 'com.lumen.daemon';
const SYSTEMD_UNIT_NAME = 'lumen.service';

/** Install a launchd plist (macOS) or a systemd user unit (Linux). */
export function installDaemonUnit(): DaemonInstallResult {
    const os = detectPlatform();
    return os === 'macos' ? installLaunchd() : installSystemd();
}

/** Remove the launchd/systemd unit and unload it. */
export function uninstallDaemonUnit(): DaemonUninstallResult {
    const os = detectPlatform();
    return os === 'macos' ? uninstallLaunchd() : uninstallSystemd();
}

function detectPlatform(): 'macos' | 'linux' {
    if (platform() === 'darwin') return 'macos';
    if (platform() === 'linux') return 'linux';
    throw new Error(
        `Auto-start is only supported on macOS (launchd) and Linux (systemd). Detected: ${platform()}`,
    );
}

/** Resolve the Node + script paths of the currently running CLI. */
function resolveExec(): { node: string; script: string } {
    return {
        node: realpathSync(process.execPath),
        script: realpathSync(process.argv[1]),
    };
}

/* ----- macOS / launchd ------------------------------------------------ */

function launchdPlistPath(): string {
    return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function installLaunchd(): DaemonInstallResult {
    const plistPath = launchdPlistPath();
    const alreadyExists = existsSync(plistPath);
    const { node, script } = resolveExec();

    const plist = renderPlist({
        label: LAUNCHD_LABEL,
        node,
        script,
        lumenDir: getDataDir(),
        logPath: getDaemonLogPath(),
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
        already_installed: alreadyExists,
        follow_up: `Daemon auto-starts on login. Inspect with: launchctl print gui/${uid}/${LAUNCHD_LABEL}`,
    };
}

function uninstallLaunchd(): DaemonUninstallResult {
    const plistPath = launchdPlistPath();
    const uid = process.getuid?.() ?? 0;
    spawnSync('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`], { stdio: 'ignore' });
    const existed = existsSync(plistPath);
    if (existed) rmSync(plistPath, { force: true });
    return { platform: 'macos', unit_path: plistPath, removed: existed };
}

function renderPlist(params: {
    label: string;
    node: string;
    script: string;
    lumenDir: string;
    logPath: string;
}): string {
    const args = [params.node, params.script, 'daemon', '__run']
        .map((a) => `        <string>${xmlEscape(a)}</string>`)
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
        <key>LUMEN_DIR</key>
        <string>${xmlEscape(params.lumenDir)}</string>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    </dict>
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

function installSystemd(): DaemonInstallResult {
    const unitPath = systemdUnitPath();
    const alreadyExists = existsSync(unitPath);
    const { node, script } = resolveExec();

    const unit = renderSystemdUnit({
        node,
        script,
        lumenDir: getDataDir(),
        logPath: getDaemonLogPath(),
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
        already_installed: alreadyExists,
        follow_up: `Daemon auto-starts on login. Inspect with: systemctl --user status ${SYSTEMD_UNIT_NAME}`,
    };
}

function uninstallSystemd(): DaemonUninstallResult {
    const unitPath = systemdUnitPath();
    spawnSync('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT_NAME], { stdio: 'ignore' });
    const existed = existsSync(unitPath);
    if (existed) rmSync(unitPath, { force: true });
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    return { platform: 'linux', unit_path: unitPath, removed: existed };
}

function renderSystemdUnit(params: {
    node: string;
    script: string;
    lumenDir: string;
    logPath: string;
}): string {
    return `[Unit]
Description=Lumen knowledge connector daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${params.node} ${params.script} daemon __run
Restart=on-failure
RestartSec=30
Environment=LUMEN_DIR=${params.lumenDir}
StandardOutput=append:${params.logPath}
StandardError=append:${params.logPath}

[Install]
WantedBy=default.target
`;
}
