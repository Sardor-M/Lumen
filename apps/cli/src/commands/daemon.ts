import type { Command } from 'commander';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isInitialized, getDaemonLogPath } from '../utils/paths.js';
import { listConnectors, dueConnectors } from '../store/connectors.js';
import { daemonStatus, startDaemonDetached, stopDaemon } from '../daemon/lifecycle.js';
import { runScheduler } from '../daemon/scheduler.js';
import * as log from '../utils/logger.js';

export function registerDaemon(program: Command): void {
    const cmd = program
        .command('daemon')
        .description('Run a background scheduler that pulls connectors on their intervals');

    cmd.command('start')
        .description('Start the daemon in the background')
        .action(() => {
            try {
                ensureInitialized();
                const { pid, logPath } = startDaemonDetached();
                log.success('Daemon started');
                log.dim(`  PID    ${pid}`);
                log.dim(`  Log    ${logPath}`);
                log.dim('  Stop   lumen daemon stop');
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });

    cmd.command('stop')
        .description('Stop the running daemon')
        .option('--timeout <ms>', 'Graceful-shutdown timeout before SIGKILL', '10000')
        .action(async (opts: { timeout: string }) => {
            try {
                const timeoutMs = Math.max(500, Number(opts.timeout) || 10_000);
                const stopped = await stopDaemon({ timeoutMs });
                if (stopped) {
                    log.success('Daemon stopped');
                } else {
                    log.warn('No daemon was running');
                }
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });

    cmd.command('status')
        .description('Show daemon state and next scheduled pulls')
        .option('--json', 'Output as JSON')
        .action((opts: { json?: boolean }) => {
            try {
                ensureInitialized();
                const s = daemonStatus();
                const connectors = listConnectors();
                const due = dueConnectors();

                if (opts.json) {
                    console.log(
                        JSON.stringify(
                            {
                                daemon: s,
                                connectors: connectors.length,
                                due: due.length,
                                next_due: due.slice(0, 5).map((c) => c.id),
                            },
                            null,
                            2,
                        ),
                    );
                    return;
                }

                log.heading('Daemon');
                const label =
                    s.state === 'running'
                        ? `running (pid ${s.pid})`
                        : s.state === 'stale-pid'
                          ? `stale PID file (pid ${s.pid} not alive)`
                          : 'stopped';
                log.table({
                    Status: label,
                    Connectors: connectors.length,
                    'Due now': due.length,
                });

                if (due.length > 0) {
                    log.heading('Next up');
                    for (const c of due.slice(0, 5)) {
                        log.dim(`  ${c.id}  (last: ${c.last_run_at ?? 'never'})`);
                    }
                }
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });

    cmd.command('logs')
        .description('Tail the daemon log')
        .option('-f, --follow', 'Follow new output (like `tail -f`)', false)
        .option('-n, --lines <n>', 'Initial lines to show', '100')
        .action((opts: { follow?: boolean; lines: string }) => {
            try {
                const path = getDaemonLogPath();
                if (!existsSync(path)) {
                    log.warn(`No log file yet at ${path}`);
                    return;
                }
                const lines = Math.max(1, Number(opts.lines) || 100);
                const args = ['-n', String(lines)];
                if (opts.follow) args.push('-f');
                args.push(path);

                const tail = spawn('tail', args, { stdio: 'inherit' });
                tail.on('error', (err) => {
                    log.error(`Failed to spawn tail: ${err.message}`);
                    process.exitCode = 1;
                });
                tail.on('exit', (code) => {
                    process.exitCode = code ?? 0;
                });
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });

    /** Hidden subcommand that the detached child enters. Not shown in help. */
    cmd.command('__run', { hidden: true })
        .description('(internal) scheduler loop — invoked by `daemon start`')
        .action(async () => {
            try {
                ensureInitialized();
                await runScheduler();
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });
}

function ensureInitialized(): void {
    if (!isInitialized()) {
        throw new Error('Lumen is not initialized. Run `lumen init` first.');
    }
}
