import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import * as log from '../utils/logger.js';
import { isInitialized, getDataDir } from '../utils/paths.js';

/**
 * Walk up from the installed CLI location looking for `apps/web/package.json`.
 * Works both when running via `pnpm dev` inside the monorepo and when the CLI
 * is linked globally.
 */
function findWebApp(): string | null {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
        const candidate = join(dir, 'apps', 'web', 'package.json');
        if (existsSync(candidate)) return dirname(candidate);
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

export function registerServe(program: Command): void {
    program
        .command('serve')
        .description('Start the Lumen web UI (Next.js) against the local knowledge base')
        .option('-p, --port <port>', 'Port to listen on', '3000')
        .option('--host <host>', 'Host to bind to', 'localhost')
        .option(
            '--mode <mode>',
            'Server mode: dev (hot reload) or prod (requires prior build)',
            'dev',
        )
        .action((opts: { port: string; host: string; mode: 'dev' | 'prod' }) => {
            try {
                if (!isInitialized()) {
                    log.warn('Lumen is not initialized. Run `lumen init` first.');
                    process.exitCode = 1;
                    return;
                }

                if (opts.mode !== 'dev' && opts.mode !== 'prod') {
                    log.error(`Invalid --mode "${opts.mode}". Expected "dev" or "prod".`);
                    process.exitCode = 1;
                    return;
                }

                const port = Number(opts.port);
                if (!Number.isInteger(port) || port < 1 || port > 65535) {
                    log.error(`Invalid --port "${opts.port}". Expected an integer in [1, 65535].`);
                    process.exitCode = 1;
                    return;
                }

                const webDir = findWebApp();
                if (!webDir) {
                    log.error(
                        'Could not locate the Lumen web app (apps/web). Serve requires the monorepo layout.',
                    );
                    process.exitCode = 1;
                    return;
                }

                const script = opts.mode === 'prod' ? 'start' : 'dev';

                log.heading('Lumen Web');
                log.info(`  Data dir   ${getDataDir()}`);
                log.info(`  Web root   ${webDir}`);
                log.info(`  URL        http://${opts.host}:${port}`);
                log.info(`  Mode       ${opts.mode}`);

                const monorepoRoot = resolve(webDir, '..', '..');
                const child = spawn(
                    'pnpm',
                    [
                        '--filter',
                        '@lumen/web',
                        'exec',
                        'next',
                        script,
                        '-p',
                        String(port),
                        '-H',
                        opts.host,
                    ],
                    {
                        cwd: monorepoRoot,
                        stdio: 'inherit',
                        env: {
                            ...process.env,
                            LUMEN_DIR: getDataDir(),
                        },
                    },
                );

                /** Fires when spawn itself fails (e.g., `pnpm` not on PATH). */
                child.on('error', (err) => {
                    log.error(`Failed to start web server: ${err.message}`);
                    process.exitCode = 1;
                });

                child.on('exit', (code) => {
                    process.exitCode = code ?? 0;
                });

                const forward = (signal: NodeJS.Signals) => {
                    child.kill(signal);
                };
                process.on('SIGINT', forward);
                process.on('SIGTERM', forward);
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });
}
