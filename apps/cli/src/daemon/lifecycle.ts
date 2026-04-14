import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { getDaemonLogPath, getDaemonPidPath, getDataDir } from '../utils/paths.js';

export type DaemonStatus =
    | { state: 'stopped'; pid: null }
    | { state: 'stale-pid'; pid: number }
    | { state: 'running'; pid: number };

/**
 * Read the PID file, returning the number or null if missing / unparseable.
 */
export function readDaemonPid(): number | null {
    const path = getDaemonPidPath();
    if (!existsSync(path)) return null;
    try {
        const raw = readFileSync(path, 'utf8').trim();
        const n = Number(raw);
        return Number.isInteger(n) && n > 0 ? n : null;
    } catch {
        return null;
    }
}

/**
 * Signal 0 — probes whether the pid exists without sending a real signal.
 */
export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

export function daemonStatus(): DaemonStatus {
    const pid = readDaemonPid();
    if (pid === null) return { state: 'stopped', pid: null };
    if (isProcessAlive(pid)) return { state: 'running', pid };
    return { state: 'stale-pid', pid };
}

/**
 * Detach a scheduler child. Parent writes the PID file and returns.
 */
export function startDaemonDetached(): { pid: number; logPath: string } {
    const existing = daemonStatus();
    if (existing.state === 'running') {
        throw new Error(`Daemon already running (pid ${existing.pid})`);
    }
    if (existing.state === 'stale-pid') {
        /** Stale pid — safe to clobber. */
        rmSync(getDaemonPidPath(), { force: true });
    }

    const logPath = getDaemonLogPath();
    const logFd = openSync(logPath, 'a');

    const child = spawn(
        process.execPath,
        [...process.execArgv, process.argv[1], 'daemon', '__run'],
        {
            detached: true,
            stdio: ['ignore', logFd, logFd],
            env: {
                ...process.env,
                LUMEN_DIR: getDataDir(),
                LUMEN_DAEMON_CHILD: '1',
            },
        },
    );

    if (!child.pid) {
        throw new Error('Failed to spawn daemon process');
    }

    /**
     *  Write the PID file here (parent) rather than waiting for the child
     *  to boot and write it. Otherwise `lumen daemon status` run immediately
     *  after `start` races the child's init and reports "stopped" even
     *  though the child is alive. The child still overwrites this on boot
     *  when launched by launchd/systemd where no parent lumen exists.
     */
    writeFileSync(getDaemonPidPath(), String(child.pid));

    child.unref();
    return { pid: child.pid, logPath };
}

/** Send SIGTERM, wait briefly for graceful shutdown, escalate to SIGKILL. */
export async function stopDaemon(opts: { timeoutMs?: number } = {}): Promise<boolean> {
    const pid = readDaemonPid();
    if (pid === null || !isProcessAlive(pid)) {
        rmSync(getDaemonPidPath(), { force: true });
        return false;
    }

    process.kill(pid, 'SIGTERM');

    const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
    while (Date.now() < deadline) {
        if (!isProcessAlive(pid)) {
            rmSync(getDaemonPidPath(), { force: true });
            return true;
        }
        await sleep(100);
    }

    /** Didn't exit in time — force it. */
    try {
        process.kill(pid, 'SIGKILL');
    } catch {
        /** Already dead. */
    }
    rmSync(getDaemonPidPath(), { force: true });
    return true;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
