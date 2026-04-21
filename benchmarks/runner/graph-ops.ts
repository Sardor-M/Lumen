/**
 * LumenBench — Graph operations benchmark.
 *
 * Seeds the concept graph from benchmarks/data/corpus-v1/edges.json and runs
 * correctness + latency checks on the four shipping graph ops:
 *   - shortestPath(from, to)
 *   - neighborhood(slug, depth)
 *   - pagerank()
 *   - detectCommunities()
 *   - godNodes(limit)
 *
 * Expected answers live alongside the edge list under `expectedOps`. They
 * encode the properties the ops must satisfy — "path must include at least
 * one of these slugs", "top-3 must include this slug", "neighborhood count
 * must be >= N" — rather than exact lists, because PageRank scores and
 * community assignments have natural ties.
 *
 * No LLM, no network. Writes to a temp dir; never touches ~/.lumen.
 *
 * Usage: tsx benchmarks/runner/graph-ops.ts [--json]
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { upsertConcept } from '../../apps/cli/src/store/concepts.js';
import { upsertEdge } from '../../apps/cli/src/store/edges.js';
import { shortestPath, neighborhood, godNodes } from '../../apps/cli/src/graph/engine.js';
import { pagerank } from '../../apps/cli/src/graph/pagerank.js';
import { detectCommunities } from '../../apps/cli/src/graph/cluster.js';
import { setDataDir, resetDataDir } from '../../apps/cli/src/utils/paths.js';
import { getDb, closeDb } from '../../apps/cli/src/store/database.js';
import type { RelationType } from '../../apps/cli/src/types/index.js';

type EdgesFile = {
    concepts: { slug: string; name: string }[];
    edges: { from: string; to: string; relation: RelationType }[];
    expectedOps: {
        path: { from: string; to: string; minHops: number; mustIncludeAny?: string[] }[];
        neighbors: { slug: string; depth: number; minCount: number }[];
        godNodesTop3MustInclude: string[];
        pagerankTop3MustInclude: string[];
        communitiesMinCount: number;
    };
};

type Check = { name: string; pass: boolean; detail: string };

function seedGraph(data: EdgesFile): void {
    const now = new Date().toISOString();
    const db = getDb();
    db.exec('BEGIN');
    try {
        for (const c of data.concepts) {
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
        for (const e of data.edges) {
            upsertEdge({
                from_slug: e.from,
                to_slug: e.to,
                relation: e.relation,
                weight: 1,
                source_id: null,
            });
        }
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}

async function main() {
    const json = process.argv.includes('--json');
    const log = json ? () => {} : (msg: string) => console.log(msg);

    log('# LumenBench — graph operations\n');
    log(`Generated: ${new Date().toISOString().slice(0, 19)}`);

    const tempDir = mkdtempSync(join(tmpdir(), 'lumen-bench-graph-'));
    setDataDir(tempDir);

    const checks: Check[] = [];
    const timings: Record<string, number> = {};

    try {
        const data = JSON.parse(
            readFileSync('benchmarks/data/corpus-v1/edges.json', 'utf-8'),
        ) as EdgesFile;

        log(`Graph: ${data.concepts.length} concepts, ${data.edges.length} edges\n`);
        seedGraph(data);

        /** ── shortestPath ── */
        log('## shortestPath');
        for (const p of data.expectedOps.path) {
            const t = performance.now();
            const result = shortestPath(p.from, p.to);
            const ms = performance.now() - t;
            timings[`path:${p.from}-${p.to}`] = ms;

            if (!result) {
                checks.push({
                    name: `path ${p.from} → ${p.to} exists`,
                    pass: false,
                    detail: 'no path found',
                });
                log(`  FAIL path ${p.from} → ${p.to}: no path found`);
                continue;
            }

            const hopsOk = result.hops >= p.minHops;
            const includeOk =
                !p.mustIncludeAny || p.mustIncludeAny.some((s) => result.path.includes(s));

            checks.push({
                name: `path ${p.from} → ${p.to} exists`,
                pass: true,
                detail: `${result.hops} hops: ${result.path.join(' → ')}`,
            });
            checks.push({
                name: `path ${p.from} → ${p.to} min hops >= ${p.minHops}`,
                pass: hopsOk,
                detail: `got ${result.hops}`,
            });
            if (p.mustIncludeAny) {
                checks.push({
                    name: `path ${p.from} → ${p.to} includes any of [${p.mustIncludeAny.join(', ')}]`,
                    pass: includeOk,
                    detail: includeOk ? 'yes' : `path: ${result.path.join(' → ')}`,
                });
            }
            log(
                `  ${hopsOk && includeOk ? 'PASS' : 'FAIL'} ${p.from} → ${p.to}: ${result.path.join(' → ')} (${ms.toFixed(2)}ms)`,
            );
        }

        /** ── neighborhood ── */
        log('\n## neighborhood');
        for (const n of data.expectedOps.neighbors) {
            const t = performance.now();
            const nb = neighborhood(n.slug, n.depth);
            const ms = performance.now() - t;
            timings[`nb:${n.slug}:d${n.depth}`] = ms;

            const count = nb.nodes.size - 1; // exclude center
            const pass = count >= n.minCount;
            checks.push({
                name: `neighbors(${n.slug}, d=${n.depth}) count >= ${n.minCount}`,
                pass,
                detail: `got ${count}`,
            });
            log(
                `  ${pass ? 'PASS' : 'FAIL'} neighbors(${n.slug}, d=${n.depth}) = ${count} (${ms.toFixed(2)}ms)`,
            );
        }

        /** ── pagerank ── */
        log('\n## pagerank');
        {
            const t = performance.now();
            const ranks = pagerank();
            const ms = performance.now() - t;
            timings['pagerank'] = ms;
            const top3 = ranks.slice(0, 3).map((r) => r.slug);
            const mustInclude = data.expectedOps.pagerankTop3MustInclude;
            const matchCount = mustInclude.filter((s) => top3.includes(s)).length;
            const pass = matchCount >= Math.min(2, mustInclude.length);
            checks.push({
                name: `pagerank top-3 includes >=2 of [${mustInclude.join(', ')}]`,
                pass,
                detail: `top-3 = ${top3.join(', ')}`,
            });
            log(`  top-3: ${top3.join(', ')} (${ms.toFixed(2)}ms)`);
        }

        /** ── godNodes ── */
        log('\n## godNodes');
        {
            const t = performance.now();
            const gn = godNodes(5);
            const ms = performance.now() - t;
            timings['godNodes'] = ms;
            const top3 = gn.slice(0, 3).map((g) => g.slug);
            const mustInclude = data.expectedOps.godNodesTop3MustInclude;
            const matchCount = mustInclude.filter((s) => top3.includes(s)).length;
            const pass = matchCount >= Math.min(1, mustInclude.length);
            checks.push({
                name: `godNodes top-3 includes >=1 of [${mustInclude.join(', ')}]`,
                pass,
                detail: `top-3 = ${top3.map((s, i) => `${s}(${gn[i].edgeCount})`).join(', ')}`,
            });
            log(
                `  top-3: ${top3.map((s, i) => `${s}(${gn[i].edgeCount})`).join(', ')} (${ms.toFixed(2)}ms)`,
            );
        }

        /** ── detectCommunities ──
         *  Label propagation is non-deterministic (random tie-breaking). Run
         *  it 3 times and take the modal count, otherwise flaky tests flake. */
        log('\n## detectCommunities');
        {
            const t = performance.now();
            const runs: number[] = [];
            for (let i = 0; i < 3; i++) runs.push(detectCommunities().length);
            const ms = performance.now() - t;
            timings['communities'] = ms;
            const maxCount = Math.max(...runs);
            const min = data.expectedOps.communitiesMinCount;
            const pass = maxCount >= min;
            checks.push({
                name: `communities count >= ${min}`,
                pass,
                detail: `runs: ${runs.join(', ')}`,
            });
            log(`  runs: ${runs.join(', ')} (${(ms / 3).toFixed(2)}ms avg)`);
        }

        /** ── Summary ── */
        const passed = checks.filter((c) => c.pass).length;
        const failed = checks.length - passed;

        log(`\n## Status\n`);
        log(`Checks: ${checks.length}, passed: ${passed}, failed: ${failed}`);

        if (failed > 0) {
            log('\nFailures:');
            for (const c of checks.filter((c) => !c.pass)) {
                log(`  FAIL ${c.name}`);
                log(`       ${c.detail}`);
            }
        } else {
            log('PASS — all graph ops return correct results on seeded graph.');
        }

        if (json) {
            process.stdout.write(JSON.stringify({ checks, timings }, null, 2) + '\n');
        }

        if (failed > 0) process.exitCode = 1;
    } finally {
        closeDb();
        resetDataDir();
        try {
            rmSync(tempDir, { recursive: true, force: true });
        } catch {
            /** best-effort cleanup */
        }
    }
}

main().catch((e) => {
    console.error('graph-ops bench error:', e);
    process.exit(1);
});
