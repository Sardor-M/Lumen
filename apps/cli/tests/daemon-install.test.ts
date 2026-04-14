import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setDataDir, resetDataDir } from '../src/utils/paths.js';
import { installDaemonUnit, uninstallDaemonUnit } from '../src/daemon/install.js';

let lumenDir: string;

/** Mocks applied before importing the module under test. */
const home = mkdtempSync(join(tmpdir(), 'lumen-home-'));

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
    lumenDir = mkdtempSync(join(tmpdir(), 'lumen-install-'));
    setDataDir(lumenDir);
    spawnCalls.length = 0;
});

afterEach(() => {
    resetDataDir();
    rmSync(lumenDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    mkdtempSync(join(tmpdir(), 'lumen-home-'));
    delete process.env.LUMEN_TEST_PLATFORM;
});

describe('installDaemonUnit — macOS', () => {
    beforeEach(() => {
        process.env.LUMEN_TEST_PLATFORM = 'darwin';
    });

    it('writes a launchd plist and invokes launchctl bootstrap', () => {
        const result = installDaemonUnit();
        expect(result.platform).toBe('macos');
        expect(result.unit_path).toMatch(/Library\/LaunchAgents\/com\.lumen\.daemon\.plist$/);
        expect(existsSync(result.unit_path)).toBe(true);

        const plist = readFileSync(result.unit_path, 'utf-8');
        expect(plist).toMatch(/<key>Label<\/key>\s*<string>com\.lumen\.daemon<\/string>/);
        expect(plist).toMatch(/<string>daemon<\/string>/);
        expect(plist).toMatch(/<string>__run<\/string>/);
        expect(plist).toContain(`<string>${lumenDir}</string>`);
        expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);

        const launchctlCalls = spawnCalls.filter((c) => c.cmd === 'launchctl');
        expect(launchctlCalls.length).toBeGreaterThanOrEqual(1);
        expect(launchctlCalls.some((c) => c.args.includes('bootstrap'))).toBe(true);
    });

    it('reports already_installed=true on re-run', () => {
        installDaemonUnit();
        const result = installDaemonUnit();
        expect(result.already_installed).toBe(true);
    });

    it('escapes XML-sensitive characters in paths', () => {
        setDataDir(join(lumenDir, 'with <angle> & "quote"'));
        const result = installDaemonUnit();
        const plist = readFileSync(result.unit_path, 'utf-8');
        expect(plist).toContain('with &lt;angle&gt; &amp; &quot;quote&quot;');
        expect(plist).not.toContain('with <angle>');
    });
});

describe('installDaemonUnit — Linux', () => {
    beforeEach(() => {
        process.env.LUMEN_TEST_PLATFORM = 'linux';
    });

    it('writes a systemd user unit and calls daemon-reload + enable', () => {
        const result = installDaemonUnit();
        expect(result.platform).toBe('linux');
        expect(result.unit_path).toMatch(/\.config\/systemd\/user\/lumen\.service$/);

        const unit = readFileSync(result.unit_path, 'utf-8');
        expect(unit).toContain('[Unit]');
        expect(unit).toContain('ExecStart=');
        expect(unit).toContain('daemon __run');
        expect(unit).toContain(`Environment=LUMEN_DIR=${lumenDir}`);
        expect(unit).toContain('Restart=on-failure');

        const systemctl = spawnCalls.filter((c) => c.cmd === 'systemctl');
        expect(systemctl.some((c) => c.args.join(' ').includes('daemon-reload'))).toBe(true);
        expect(systemctl.some((c) => c.args.join(' ').includes('enable'))).toBe(true);
    });
});

describe('uninstallDaemonUnit', () => {
    it('removes a macOS plist and calls launchctl bootout', () => {
        process.env.LUMEN_TEST_PLATFORM = 'darwin';
        installDaemonUnit();
        spawnCalls.length = 0;

        const result = uninstallDaemonUnit();
        expect(result.removed).toBe(true);
        expect(existsSync(result.unit_path)).toBe(false);
        expect(spawnCalls.some((c) => c.args.includes('bootout'))).toBe(true);
    });

    it('returns removed=false when nothing is installed', () => {
        process.env.LUMEN_TEST_PLATFORM = 'linux';
        const result = uninstallDaemonUnit();
        expect(result.removed).toBe(false);
    });

    it('removes a systemd unit and calls disable + daemon-reload', () => {
        process.env.LUMEN_TEST_PLATFORM = 'linux';
        /** Seed a fake unit file so `removed` reports true without going through install. */
        const unitPath = join(home, '.config', 'systemd', 'user', 'lumen.service');
        const fs = require('node:fs') as typeof import('node:fs');
        fs.mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
        writeFileSync(unitPath, 'stub', 'utf-8');

        const result = uninstallDaemonUnit();
        expect(result.removed).toBe(true);
        expect(spawnCalls.some((c) => c.args.includes('disable'))).toBe(true);
    });
});

describe('platform detection', () => {
    it('throws on unsupported platforms', () => {
        process.env.LUMEN_TEST_PLATFORM = 'win32';
        expect(() => installDaemonUnit()).toThrow(/Auto-start is only supported/);
    });
});
