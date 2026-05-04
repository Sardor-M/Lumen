/**
 * vitest setup: apply D1 migrations against the per-test-file isolated DB.
 * Runs once per test file (not per `it`); `isolatedStorage: true` in
 * vitest.config.ts gives each file a fresh DB so cross-file state is impossible.
 */

import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
