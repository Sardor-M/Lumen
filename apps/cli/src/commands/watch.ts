import type { Command } from 'commander';
import { getDb } from '../store/database.js';
import { isInitialized } from '../utils/paths.js';
import {
    deleteConnector,
    getConnector,
    insertConnector,
    listConnectors,
} from '../store/connectors.js';
import {
    initConnectors,
    runAll,
    runOne,
    getHandler,
    listHandlerTypes,
} from '../connectors/index.js';
import type { PullSummary } from '../connectors/index.js';
import * as log from '../utils/logger.js';
import type { Connector, ConnectorType } from '../types/index.js';

const DEFAULT_INTERVAL_SECONDS = 3600;
const MIN_INTERVAL_SECONDS = 60;
const MAX_INTERVAL_SECONDS = 86400 * 7;

export function registerWatch(program: Command): void {
    const cmd = program
        .command('watch')
        .description('Manage connectors that auto-ingest from external sources');

    cmd.command('add <type> <target>')
        .description('Register a new connector — e.g. `watch add rss https://simonw.net/atom`')
        .option(
            '-i, --interval <seconds>',
            `Poll interval in seconds (default ${DEFAULT_INTERVAL_SECONDS})`,
        )
        .option('-n, --name <name>', 'Human-readable name (defaults to target)')
        .action((typeArg: string, target: string, opts: { interval?: string; name?: string }) => {
            try {
                ensureInitialized();
                initConnectors();

                const type = validateType(typeArg);
                const interval = parseInterval(opts.interval);

                const handler = getHandler(type);
                if (!handler) {
                    log.error(
                        `No handler for "${type}". Available: ${listHandlerTypes().join(', ')}`,
                    );
                    process.exitCode = 1;
                    return;
                }

                const parsed = handler.parseTarget(target, {});
                if (getConnector(parsed.id)) {
                    log.warn(`Connector already exists: ${parsed.id}`);
                    process.exitCode = 1;
                    return;
                }

                const connector: Connector = {
                    id: parsed.id,
                    type,
                    name: opts.name ?? parsed.name,
                    config: JSON.stringify(parsed.config),
                    state: JSON.stringify(parsed.initialState),
                    interval_seconds: interval,
                    last_run_at: null,
                    last_error: null,
                    created_at: new Date().toISOString(),
                };
                insertConnector(connector);

                log.success(`Added connector: ${connector.id}`);
                log.dim(`  Type       ${connector.type}`);
                log.dim(`  Name       ${connector.name}`);
                log.dim(`  Interval   ${connector.interval_seconds}s`);
                log.dim(`  Run with   lumen watch pull ${connector.id}`);
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });

    cmd.command('list')
        .description('List all registered connectors')
        .option('--json', 'Output as JSON')
        .action((opts: { json?: boolean }) => {
            try {
                ensureInitialized();
                const all = listConnectors();

                if (opts.json) {
                    console.log(JSON.stringify(all, null, 2));
                    return;
                }

                if (all.length === 0) {
                    log.info('No connectors registered. Try: lumen watch add rss <feed-url>');
                    return;
                }

                log.heading(`Connectors (${all.length})`);
                for (const c of all) {
                    const lastRun = c.last_run_at ? c.last_run_at.split('T')[0] : 'never';
                    const errSuffix = c.last_error ? `  ✗ ${c.last_error}` : '';
                    log.info(`  ${c.id}`);
                    log.dim(
                        `    type=${c.type}  interval=${c.interval_seconds}s  last_run=${lastRun}${errSuffix}`,
                    );
                }
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });

    cmd.command('remove <id>')
        .description('Unregister a connector')
        .action((id: string) => {
            try {
                ensureInitialized();
                const removed = deleteConnector(id);
                if (!removed) {
                    log.warn(`Connector not found: ${id}`);
                    process.exitCode = 1;
                    return;
                }
                log.success(`Removed connector: ${id}`);
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });

    cmd.command('run')
        .description('Pull all connectors once (ignores interval)')
        .action(async () => {
            try {
                ensureInitialized();
                initConnectors();
                const summaries = await runAll();
                printSummaries(summaries);
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });

    cmd.command('pull <id>')
        .description('Pull a single connector now')
        .action(async (id: string) => {
            try {
                ensureInitialized();
                initConnectors();
                const summary = await runOne(id);
                printSummaries([summary]);
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
    getDb();
}

function validateType(raw: string): ConnectorType {
    const known: ConnectorType[] = ['rss', 'folder', 'arxiv', 'github', 'youtube-channel'];
    const registered = listHandlerTypes();
    if (!known.includes(raw as ConnectorType)) {
        throw new Error(`Unknown connector type "${raw}". Known: ${known.join(', ')}`);
    }
    if (!registered.includes(raw as ConnectorType)) {
        throw new Error(
            `Connector type "${raw}" is not yet implemented. Registered: ${registered.join(', ') || '(none)'}`,
        );
    }
    return raw as ConnectorType;
}

function parseInterval(raw: string | undefined): number {
    if (raw === undefined) return DEFAULT_INTERVAL_SECONDS;
    const n = Number(raw);
    if (!Number.isInteger(n)) {
        throw new Error(`--interval must be an integer, got "${raw}"`);
    }
    if (n < MIN_INTERVAL_SECONDS || n > MAX_INTERVAL_SECONDS) {
        throw new Error(
            `--interval must be between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS} seconds`,
        );
    }
    return n;
}

function printSummaries(summaries: PullSummary[]): void {
    if (summaries.length === 0) {
        log.info('No connectors ran.');
        return;
    }

    let totalIngested = 0;
    let totalDeduped = 0;
    let failures = 0;

    log.heading('Connector Run');
    for (const s of summaries) {
        if (s.error) {
            failures++;
            log.warn(`  ${s.connector_id}  ✗ ${s.error}`);
            continue;
        }
        totalIngested += s.ingested;
        totalDeduped += s.deduped;
        log.dim(
            `  ${s.connector_id}  fetched=${s.fetched} ingested=${s.ingested} deduped=${s.deduped}`,
        );
    }

    log.dim(
        `\n${summaries.length} connector(s): ${totalIngested} ingested, ${totalDeduped} deduped, ${failures} failed`,
    );
    if (failures > 0) process.exitCode = 1;
}
