import path from 'node:path';
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

/**
 * vitest-pool-workers boots a real `workerd` per test file with miniflare-backed
 * D1 + KV. The migrations directory is read at config time and exposed to tests
 * via the TEST_MIGRATIONS binding so test/setup.ts can apply them on each
 * isolated DB before any test runs.
 */
export default defineWorkersConfig(async () => {
    const migrationsDir = path.resolve(__dirname, 'migrations');
    const migrations = await readD1Migrations(migrationsDir);

    return {
        test: {
            setupFiles: ['./test/setup.ts'],
            poolOptions: {
                workers: {
                    singleWorker: true,
                    isolatedStorage: true,
                    wrangler: { configPath: './wrangler.toml' },
                    miniflare: {
                        bindings: {
                            TEST_MIGRATIONS: migrations,
                        },
                    },
                },
            },
        },
    };
});
