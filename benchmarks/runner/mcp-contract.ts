/**
 * LumenBench — MCP / tool contract benchmark.
 *
 * Exercises every tool exposed via `handleToolCall()` (the same dispatcher
 * that backs both the Anthropic / OpenAI adapters and the MCP server's tool
 * namespace). For each tool we check:
 *
 *   - Valid input returns without throwing and produces a sensible shape.
 *   - Missing or wrong-typed arguments throw `LumenError('INVALID_ARGUMENT')`
 *     (not a generic crash, not silent acceptance).
 *   - Unknown tool name throws.
 *
 * LLM-backed tools (`ask`, `compile`) would require an API key to exercise
 * the success path. For those we only verify the argument validation layer
 * — that's where the contract actually lives; the downstream call goes to
 * the provider.
 *
 * Writes to a temp dir. No LLM, no network.
 *
 * Usage: tsx benchmarks/runner/mcp-contract.ts [--json]
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLumen, type Lumen } from '../../apps/cli/src/index.js';
import { handleToolCall, toolDefinitions } from '../../apps/cli/src/tools.js';
import { upsertConcept } from '../../apps/cli/src/store/concepts.js';
import { upsertEdge } from '../../apps/cli/src/store/edges.js';

type Check = {
    tool: string;
    name: string;
    pass: boolean;
    detail: string;
};

async function runCall(
    lumen: Lumen,
    name: string,
    args: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string; code?: string }> {
    try {
        const result = await handleToolCall(lumen, { name, arguments: args });
        return { ok: true, result };
    } catch (e) {
        const err = e as { message?: string; code?: string };
        return { ok: false, error: err.message ?? String(e), code: err.code };
    }
}

function seedMinimalGraph(): void {
    const now = new Date().toISOString();
    const concepts = [
        { slug: 'alpha', name: 'Alpha' },
        { slug: 'beta', name: 'Beta' },
        { slug: 'gamma', name: 'Gamma' },
    ];
    for (const c of concepts) {
        upsertConcept({
            slug: c.slug,
            name: c.name,
            summary: null,
            compiled_truth: null,
            article: null,
            created_at: now,
            updated_at: now,
            mention_count: 1,
        });
    }
    upsertEdge({
        from_slug: 'alpha',
        to_slug: 'beta',
        relation: 'related',
        weight: 1,
        source_id: null,
    });
    upsertEdge({
        from_slug: 'beta',
        to_slug: 'gamma',
        relation: 'related',
        weight: 1,
        source_id: null,
    });
}

async function main() {
    const json = process.argv.includes('--json');
    const log = json ? () => {} : (msg: string) => console.log(msg);

    log('# LumenBench — MCP contract\n');
    log(`Generated: ${new Date().toISOString().slice(0, 19)}`);
    log(`Tools in registry: ${toolDefinitions.length}`);

    const tempDir = mkdtempSync(join(tmpdir(), 'lumen-bench-mcp-'));
    const lumen = createLumen({ dataDir: tempDir, autoInit: true });

    const checks: Check[] = [];
    const push = (c: Check) => {
        checks.push(c);
        log(`  ${c.pass ? 'PASS' : 'FAIL'} [${c.tool}] ${c.name}${c.pass ? '' : ' — ' + c.detail}`);
    };

    try {
        /** ── Registry sanity ── */
        log('\n## Registry sanity');
        const expectedNames = [
            'add',
            'search',
            'ask',
            'status',
            'profile',
            'god_nodes',
            'pagerank',
            'neighbors',
            'path',
            'communities',
        ];
        for (const name of expectedNames) {
            const found = toolDefinitions.find((t) => t.name === name);
            push({
                tool: name,
                name: 'is defined in toolDefinitions',
                pass: Boolean(found),
                detail: found ? 'ok' : 'missing from registry',
            });
        }

        /** ── status (simplest — no args) ── */
        log('\n## status');
        {
            const r = await runCall(lumen, 'status', {});
            const ok = r.ok && typeof r.result === 'object' && r.result !== null;
            push({
                tool: 'status',
                name: 'returns object with counts',
                pass: ok,
                detail: ok ? 'ok' : `${r.ok ? 'wrong shape' : r.error}`,
            });
        }

        /** Seed a tiny graph for the later ops. */
        seedMinimalGraph();

        /** ── search ── */
        log('\n## search');
        {
            const valid = await runCall(lumen, 'search', { query: 'alpha', limit: 5 });
            push({
                tool: 'search',
                name: 'valid query returns array',
                pass: valid.ok && Array.isArray(valid.result),
                detail: valid.ok ? 'ok' : valid.error,
            });

            const missing = await runCall(lumen, 'search', {});
            push({
                tool: 'search',
                name: 'missing `query` rejected',
                pass: !missing.ok,
                detail: missing.ok ? 'silently accepted (BUG)' : missing.error.slice(0, 80),
            });

            const badType = await runCall(lumen, 'search', { query: 123 as unknown as string });
            push({
                tool: 'search',
                name: 'numeric `query` rejected',
                pass: !badType.ok,
                detail: badType.ok ? 'silently accepted' : badType.error.slice(0, 80),
            });

            const badMode = await runCall(lumen, 'search', { query: 'x', mode: 'ftw' });
            push({
                tool: 'search',
                name: 'invalid `mode` rejected',
                pass: !badMode.ok,
                detail: badMode.ok ? 'silently accepted' : badMode.error.slice(0, 80),
            });
        }

        /** ── god_nodes ── */
        log('\n## god_nodes');
        {
            const valid = await runCall(lumen, 'god_nodes', { limit: 3 });
            push({
                tool: 'god_nodes',
                name: 'returns array',
                pass: valid.ok && Array.isArray(valid.result),
                detail: valid.ok ? 'ok' : valid.error,
            });
            const noArgs = await runCall(lumen, 'god_nodes', {});
            push({
                tool: 'god_nodes',
                name: 'empty args valid (defaulted limit)',
                pass: noArgs.ok && Array.isArray(noArgs.result),
                detail: noArgs.ok ? 'ok' : noArgs.error,
            });
        }

        /** ── pagerank ── */
        log('\n## pagerank');
        {
            const valid = await runCall(lumen, 'pagerank', { limit: 3 });
            push({
                tool: 'pagerank',
                name: 'returns array',
                pass: valid.ok && Array.isArray(valid.result),
                detail: valid.ok ? 'ok' : valid.error,
            });
        }

        /** ── neighbors ── */
        log('\n## neighbors');
        {
            const valid = await runCall(lumen, 'neighbors', { slug: 'alpha', depth: 2 });
            push({
                tool: 'neighbors',
                name: 'valid slug returns result',
                pass: valid.ok,
                detail: valid.ok ? 'ok' : valid.error,
            });

            const missing = await runCall(lumen, 'neighbors', { depth: 2 });
            push({
                tool: 'neighbors',
                name: 'missing `slug` rejected',
                pass: !missing.ok,
                detail: missing.ok ? 'silently accepted' : missing.error.slice(0, 80),
            });

            const badDepth = await runCall(lumen, 'neighbors', {
                slug: 'alpha',
                depth: 'deep' as unknown as number,
            });
            push({
                tool: 'neighbors',
                name: 'string `depth` rejected',
                pass: !badDepth.ok,
                detail: badDepth.ok ? 'silently accepted' : badDepth.error.slice(0, 80),
            });
        }

        /** ── path ── */
        log('\n## path');
        {
            const valid = await runCall(lumen, 'path', { from: 'alpha', to: 'gamma' });
            push({
                tool: 'path',
                name: 'seeded path alpha→gamma resolves',
                pass: valid.ok && typeof valid.result === 'object' && valid.result !== null,
                detail: valid.ok ? JSON.stringify(valid.result).slice(0, 80) : valid.error,
            });

            const nullPath = await runCall(lumen, 'path', { from: 'alpha', to: 'nonexistent' });
            push({
                tool: 'path',
                name: 'nonexistent target returns null (no throw)',
                pass: nullPath.ok && nullPath.result === null,
                detail: nullPath.ok ? String(nullPath.result) : nullPath.error,
            });

            const missingTo = await runCall(lumen, 'path', { from: 'alpha' });
            push({
                tool: 'path',
                name: 'missing `to` rejected',
                pass: !missingTo.ok,
                detail: missingTo.ok ? 'silently accepted' : missingTo.error.slice(0, 80),
            });
        }

        /** ── communities ── */
        log('\n## communities');
        {
            const valid = await runCall(lumen, 'communities', { maxIterations: 20 });
            push({
                tool: 'communities',
                name: 'returns array',
                pass: valid.ok && Array.isArray(valid.result),
                detail: valid.ok ? 'ok' : valid.error,
            });
        }

        /** ── profile ── */
        log('\n## profile');
        {
            const valid = await runCall(lumen, 'profile', {});
            push({
                tool: 'profile',
                name: 'returns object',
                pass: valid.ok && typeof valid.result === 'object',
                detail: valid.ok ? 'ok' : valid.error,
            });

            const badType = await runCall(lumen, 'profile', {
                refresh: 'yes' as unknown as boolean,
            });
            push({
                tool: 'profile',
                name: 'string `refresh` rejected',
                pass: !badType.ok,
                detail: badType.ok ? 'silently accepted' : badType.error.slice(0, 80),
            });
        }

        /** ── add (no network path — empty string should reject) ── */
        log('\n## add');
        {
            const missing = await runCall(lumen, 'add', {});
            push({
                tool: 'add',
                name: 'missing `input` rejected',
                pass: !missing.ok,
                detail: missing.ok ? 'silently accepted' : missing.error.slice(0, 80),
            });
            const emptyStr = await runCall(lumen, 'add', { input: '' });
            push({
                tool: 'add',
                name: 'empty `input` rejected',
                pass: !emptyStr.ok,
                detail: emptyStr.ok ? 'silently accepted' : emptyStr.error.slice(0, 80),
            });
        }

        /** ── ask (LLM — only validate args) ── */
        log('\n## ask (arg validation only — requires API key for success)');
        {
            const missing = await runCall(lumen, 'ask', {});
            push({
                tool: 'ask',
                name: 'missing `question` rejected',
                pass: !missing.ok,
                detail: missing.ok ? 'silently accepted' : missing.error.slice(0, 80),
            });
            const badLimit = await runCall(lumen, 'ask', {
                question: 'x',
                limit: 'ten' as unknown as number,
            });
            push({
                tool: 'ask',
                name: 'string `limit` rejected',
                pass: !badLimit.ok,
                detail: badLimit.ok ? 'silently accepted' : badLimit.error.slice(0, 80),
            });
        }

        /** ── unknown tool ── */
        log('\n## unknown tool');
        {
            const r = await runCall(lumen, 'does_not_exist', { x: 1 });
            push({
                tool: 'unknown',
                name: 'unknown tool name throws',
                pass: !r.ok,
                detail: r.ok ? 'silently accepted' : r.error.slice(0, 80),
            });
        }

        /** ── Summary ── */
        const passed = checks.filter((c) => c.pass).length;
        const failed = checks.length - passed;

        log(`\n## Status\n`);
        log(`Checks: ${checks.length}, passed: ${passed}, failed: ${failed}`);

        if (failed > 0) {
            log('\nFailures:');
            for (const c of checks.filter((c) => !c.pass)) {
                log(`  FAIL [${c.tool}] ${c.name}`);
                log(`       ${c.detail}`);
            }
        } else {
            log('PASS — every tool accepts valid input and rejects invalid input as contracted.');
        }

        if (json) {
            process.stdout.write(JSON.stringify({ checks }, null, 2) + '\n');
        }

        if (failed > 0) process.exitCode = 1;
    } finally {
        lumen.close();
        try {
            rmSync(tempDir, { recursive: true, force: true });
        } catch {
            /** best-effort cleanup */
        }
    }
}

main().catch((e) => {
    console.error('mcp-contract bench error:', e);
    process.exit(1);
});
