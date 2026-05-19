import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setDataDir, resetDataDir } from '../src/utils/paths.js';
import {
    installSyncDaemon,
    syncDaemonStatus,
    uninstallSyncDaemon,
} from '../src/sync/daemon-install.js';

let lumenDir: string;

const home = mkdtempSync(join(tmpdir(), 'lumen-sync-home-'));

vi.mock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os');
    return {
        ...actual,
        homedir: () => home,
        platform: () => (process.env.LUMEN_TEST_PLATFORM as NodeJS.Platform) ?? 'darwin',
    };
});

const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
vi.mock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    return {
        ...actual,
        spawnSync: (cmd: string, args: string[]) => {
            spawnCalls.push({ cmd, args });
            return { status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null };
        },
    };
});

beforeEach(() => {
    lumenDir = mkdtempSync(join(tmpdir(), 'lumen-sync-install-'));
    setDataDir(lumenDir);
    spawnCalls.length = 0;
});

afterEach(() => {
    resetDataDir();
    rmSync(lumenDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    delete process.env.LUMEN_TEST_PLATFORM;
});

describe('installSyncDaemon — macOS', () => {
    beforeEach(() => {
        process.env.LUMEN_TEST_PLATFORM = 'darwin';
    });

    it('writes a launchd plist with managed shape (KeepAlive, sync daemon __run)', () => {
        const result = installSyncDaemon();
        expect(result.platform).toBe('macos');
        expect(result.unit_path).toMatch(/Library\/LaunchAgents\/com\.lumen\.sync\.plist$/);
        expect(existsSync(result.unit_path)).toBe(true);

        const plist = readFileSync(result.unit_path, 'utf-8');
        expect(plist).toMatch(/<key>Label<\/key>\s*<string>com\.lumen\.sync<\/string>/);
        expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
        expect(plist).toMatch(/<string>sync<\/string>/);
        expect(plist).toMatch(/<string>daemon<\/string>/);
        expect(plist).toMatch(/<string>__run<\/string>/);
        expect(plist).not.toMatch(/<key>StartInterval<\/key>/);

        const launchctlCalls = spawnCalls.filter((c) => c.cmd === 'launchctl');
        expect(launchctlCalls.some((c) => c.args.includes('bootstrap'))).toBe(true);
    });

    it('embeds the config as launchd EnvironmentVariables', () => {
        const result = installSyncDaemon({
            config: {
                intervalActiveSec: 45,
                intervalIdleSec: 600,
                idleAfter: 5,
                debounceSec: 7,
            },
        });
        const plist = readFileSync(result.unit_path, 'utf-8');
        expect(plist).toContain('LUMEN_SYNC_DAEMON_INTERVAL_ACTIVE');
        expect(plist).toContain('<string>45</string>');
        expect(plist).toContain('LUMEN_SYNC_DAEMON_INTERVAL_IDLE');
        expect(plist).toContain('<string>600</string>');
        expect(plist).toContain('LUMEN_SYNC_DAEMON_DEBOUNCE');
        expect(plist).toContain('<string>7</string>');
    });

    it('reports already_installed=true on idempotent re-run', () => {
        installSyncDaemon();
        const second = installSyncDaemon();
        expect(second.already_installed).toBe(true);
        expect(second.replaced_manual).toBe(false);
    });

    it('refuses to clobber a manually-installed plist without --replace-manual', () => {
        const plistPath = join(home, 'Library', 'LaunchAgents', 'com.lumen.sync.plist');
        mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
        /** Mimic the PR #27 manual template — has StartInterval, no KeepAlive. */
        writeFileSync(
            plistPath,
            `<?xml version="1.0"?>
<plist><dict>
  <key>Label</key><string>com.lumen.sync</string>
  <key>StartInterval</key><integer>120</integer>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-lc</string><string>lumen sync run</string></array>
</dict></plist>`,
            'utf-8',
        );

        expect(() => installSyncDaemon()).toThrow(/manually-installed sync plist/);
    });

    it('replaces a manually-installed plist when --replace-manual is set', () => {
        const plistPath = join(home, 'Library', 'LaunchAgents', 'com.lumen.sync.plist');
        mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
        writeFileSync(
            plistPath,
            `<?xml version="1.0"?>
<plist><dict>
  <key>Label</key><string>com.lumen.sync</string>
  <key>StartInterval</key><integer>120</integer>
</dict></plist>`,
            'utf-8',
        );

        const result = installSyncDaemon({ replaceManual: true });
        expect(result.replaced_manual).toBe(true);
        const plist = readFileSync(result.unit_path, 'utf-8');
        expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
        expect(plist).not.toMatch(/<key>StartInterval<\/key>/);
    });

    it('escapes XML-sensitive characters in paths', () => {
        setDataDir(join(lumenDir, 'with <angle> & "quote"'));
        const result = installSyncDaemon();
        const plist = readFileSync(result.unit_path, 'utf-8');
        expect(plist).toContain('with &lt;angle&gt; &amp; &quot;quote&quot;');
    });
});

describe('installSyncDaemon — Linux', () => {
    beforeEach(() => {
        process.env.LUMEN_TEST_PLATFORM = 'linux';
    });

    it('writes a managed (Type=simple, long-running) systemd user unit', () => {
        const result = installSyncDaemon();
        expect(result.platform).toBe('linux');
        expect(result.unit_path).toMatch(/\.config\/systemd\/user\/lumen-sync\.service$/);

        const unit = readFileSync(result.unit_path, 'utf-8');
        expect(unit).toContain('[Unit]');
        expect(unit).toContain('Type=simple');
        expect(unit).toContain('sync daemon __run');
        expect(unit).toContain('Restart=on-failure');
        expect(unit).toContain('LUMEN_SYNC_DAEMON_INTERVAL_ACTIVE');

        const systemctl = spawnCalls.filter((c) => c.cmd === 'systemctl');
        expect(systemctl.some((c) => c.args.join(' ').includes('daemon-reload'))).toBe(true);
        expect(systemctl.some((c) => c.args.join(' ').includes('enable'))).toBe(true);
    });

    it('refuses to clobber an oneshot manual unit without --replace-manual', () => {
        const unitPath = join(home, '.config', 'systemd', 'user', 'lumen-sync.service');
        mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
        writeFileSync(
            unitPath,
            '[Unit]\n[Service]\nType=oneshot\nExecStart=/usr/local/bin/lumen sync run\n',
            'utf-8',
        );

        expect(() => installSyncDaemon()).toThrow(/manually-installed sync service/);
    });

    it('replaces oneshot manual unit + drops sibling timer when --replace-manual', () => {
        const unitPath = join(home, '.config', 'systemd', 'user', 'lumen-sync.service');
        const timerPath = join(home, '.config', 'systemd', 'user', 'lumen-sync.timer');
        mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
        writeFileSync(
            unitPath,
            '[Service]\nType=oneshot\nExecStart=/usr/local/bin/lumen sync run\n',
            'utf-8',
        );
        writeFileSync(timerPath, '[Timer]\nOnUnitActiveSec=120\n', 'utf-8');

        const result = installSyncDaemon({ replaceManual: true });
        expect(result.replaced_manual).toBe(true);
        const unit = readFileSync(result.unit_path, 'utf-8');
        expect(unit).toContain('Type=simple');
        expect(existsSync(timerPath)).toBe(false);
    });
});

describe('uninstallSyncDaemon', () => {
    it('removes a macOS plist and calls launchctl bootout', () => {
        process.env.LUMEN_TEST_PLATFORM = 'darwin';
        installSyncDaemon();
        spawnCalls.length = 0;

        const result = uninstallSyncDaemon();
        expect(result.removed).toBe(true);
        expect(existsSync(result.unit_path)).toBe(false);
        expect(spawnCalls.some((c) => c.args.includes('bootout'))).toBe(true);
    });

    it('returns removed=false when nothing is installed', () => {
        process.env.LUMEN_TEST_PLATFORM = 'linux';
        const result = uninstallSyncDaemon();
        expect(result.removed).toBe(false);
    });

    it('removes a systemd unit and calls disable', () => {
        process.env.LUMEN_TEST_PLATFORM = 'linux';
        installSyncDaemon();
        spawnCalls.length = 0;

        const result = uninstallSyncDaemon();
        expect(result.removed).toBe(true);
        expect(spawnCalls.some((c) => c.args.includes('disable'))).toBe(true);
    });
});

describe('syncDaemonStatus', () => {
    it('reports installed=false when no plist/unit exists', () => {
        process.env.LUMEN_TEST_PLATFORM = 'darwin';
        const s = syncDaemonStatus();
        expect(s.installed).toBe(false);
        expect(s.managed).toBe(false);
        expect(s.manual).toBe(false);
    });

    it('reports manual=true when a PR #27-shape plist is found', () => {
        process.env.LUMEN_TEST_PLATFORM = 'darwin';
        const plistPath = join(home, 'Library', 'LaunchAgents', 'com.lumen.sync.plist');
        mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
        writeFileSync(
            plistPath,
            `<plist><dict><key>StartInterval</key><integer>120</integer></dict></plist>`,
            'utf-8',
        );
        const s = syncDaemonStatus();
        expect(s.installed).toBe(true);
        expect(s.manual).toBe(true);
        expect(s.managed).toBe(false);
    });

    it('reports managed=true after install', () => {
        process.env.LUMEN_TEST_PLATFORM = 'darwin';
        installSyncDaemon();
        const s = syncDaemonStatus();
        expect(s.installed).toBe(true);
        expect(s.managed).toBe(true);
        expect(s.manual).toBe(false);
    });
});

describe('platform detection', () => {
    it('throws on unsupported platforms', () => {
        process.env.LUMEN_TEST_PLATFORM = 'win32';
        expect(() => installSyncDaemon()).toThrow(/Sync daemon is only supported/);
    });
});
