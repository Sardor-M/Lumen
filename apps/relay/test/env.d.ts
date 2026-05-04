/**
 * Type augmentation for the bindings exposed to tests by vitest-pool-workers.
 * The `TEST_MIGRATIONS` binding is injected by vitest.config.ts; the rest
 * mirror the production Bindings type.
 */

import type { D1Migration } from '@cloudflare/vitest-pool-workers/config';

declare module 'cloudflare:test' {
    interface ProvidedEnv {
        DB: D1Database;
        RATE_LIMIT: KVNamespace;
        TEST_MIGRATIONS: D1Migration[];
        MAX_ENVELOPE_BYTES?: string;
        MAX_BATCH_ENTRIES?: string;
        MAX_PULL_LIMIT?: string;
        DEFAULT_PULL_LIMIT?: string;
        RATE_LIMIT_PUSH_REQUESTS_PER_MINUTE?: string;
        RATE_LIMIT_PULL_REQUESTS_PER_MINUTE?: string;
        RATE_LIMIT_PUSH_ENTRIES_PER_HOUR?: string;
        RATE_LIMIT_BYTES_PER_DAY?: string;
    }
}
