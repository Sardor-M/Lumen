import type { Command } from 'commander';
import { getDataDir, getDbPath, isInitialized } from '../utils/paths.js';
import { initConfig } from '../utils/config.js';
import { getDb } from '../store/database.js';
import { audit } from '../utils/logger.js';
import * as log from '../utils/logger.js';

export function registerInit(program: Command): void {
    program
        .command('init')
        .description('Initialize a new Lumen workspace at ~/.lumen')
        .action(() => {
            try {
                if (isInitialized()) {
                    log.warn(`Workspace already exists at ${getDataDir()}`);
                    return;
                }

                /** Create data directory, database, and default config. */
                getDb();
                initConfig();

                audit('workspace:init', { path: getDataDir() });

                log.success(`Initialized Lumen workspace at ${getDataDir()}`);
                log.table({
                    Database: getDbPath(),
                    Config: `${getDataDir()}/config.json`,
                });
                log.dim('\nNext steps:');
                log.dim('  lumen add <url>       — ingest your first source');
                log.dim('  lumen search <query>  — search ingested content');
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });
}
