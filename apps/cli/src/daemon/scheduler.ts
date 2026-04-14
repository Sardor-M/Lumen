import { getDb } from '../store/database.js';
import { initConnectors, runDue } from '../connectors/index.js';
import { getDaemonPidPath } from '../utils/paths.js';
import { rmSync, writeFileSync } from 'node:fs';

const TICK_MS = 60_000;
const CONCURRENCY = 4;

type SchedulerState = {
    running: boolean;
    timer: NodeJS.Timeout | null;
};

const state: SchedulerState = { running: false, timer: null };

/**
 * Run the scheduler in the current process. Writes a PID file at start,
 * removes it on graceful shutdown. Resolves when SIGTERM/SIGINT arrives.
 * Called by the hidden `daemon __run` subcommand inside the detached child.
 */
export async function runScheduler(): Promise<void> {
    if (state.running) return;
    state.running = true;

    getDb();
    initConnectors();
    writeFileSync(getDaemonPidPath(), String(process.pid));

    log('daemon started', { pid: process.pid, tick_ms: TICK_MS, concurrency: CONCURRENCY });

    return new Promise<void>((resolve) => {
        const stop = () => {
            shutdown();
            resolve();
        };
        process.once('SIGTERM', stop);
        process.once('SIGINT', stop);

        /** First tick immediately; the active timer chain keeps the event
         *  loop alive until a signal fires. */
        void tick().then(scheduleNextTick);
    });
}

function scheduleNextTick(): void {
    if (!state.running) return;
    state.timer = setTimeout(async () => {
        await tick();
        scheduleNextTick();
    }, TICK_MS);
}

async function tick(): Promise<void> {
    try {
        const summaries = await runDue({ concurrency: CONCURRENCY });
        if (summaries.length === 0) return;
        const ingested = summaries.reduce((n, s) => n + s.ingested, 0);
        const failed = summaries.filter((s) => s.error).length;
        log('tick', { ran: summaries.length, ingested, failed });
        for (const s of summaries) {
            if (s.error) log('connector failed', { id: s.connector_id, error: s.error });
        }
    } catch (err) {
        log('tick error', { error: err instanceof Error ? err.message : String(err) });
    }
}

function shutdown(): void {
    if (!state.running) return;
    state.running = false;
    if (state.timer) clearTimeout(state.timer);
    try {
        rmSync(getDaemonPidPath(), { force: true });
    } catch {
        /** Best-effort cleanup — PID file may already be gone. */
    }
    log('daemon stopped');
}

/** Structured line to stdout (which the parent redirects to daemon.log). */
function log(event: string, detail?: Record<string, unknown>): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...detail });
    process.stdout.write(line + '\n');
}
