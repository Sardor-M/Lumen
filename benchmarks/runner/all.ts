/**
 * LumenBench — combined runner.
 *
 * Runs every shipping benchmark category in sequence, captures each one's
 * full stdout, and writes a unified markdown report to
 * `docs/benchmarks/YYYY-MM-DD-lumenbench.md`. The report embeds every
 * category's output plus a reproducibility footer.
 *
 * Pass criteria: every category must exit 0. A non-zero exit from any
 * category marks the run failed; the report still gets written so diffs
 * are visible in git.
 *
 * Usage: tsx benchmarks/runner/all.ts
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type CategoryRun = {
    num: number;
    name: string;
    script: string;
    status: 'pass' | 'fail';
    output: string;
    exitCode: number;
    wallMs: number;
};

const CATEGORIES = [
    { num: 1, name: 'Ingest / Chunker', script: 'benchmarks/runner/ingest.ts' },
    { num: 2, name: 'Search Quality', script: 'benchmarks/runner/search-quality.ts' },
    { num: 3, name: 'Search Latency', script: 'benchmarks/runner/search-latency.ts' },
    { num: 4, name: 'Graph Operations', script: 'benchmarks/runner/graph-ops.ts' },
    { num: 5, name: 'MCP Contract', script: 'benchmarks/runner/mcp-contract.ts' },
    { num: 6, name: 'Adversarial Robustness', script: 'benchmarks/runner/adversarial.ts' },
];

function runCategory(c: (typeof CATEGORIES)[number]): CategoryRun {
    console.log(`\n=== Running Category ${c.num}: ${c.name} ===`);
    const started = Date.now();
    let output = '';
    let exitCode = 0;
    try {
        output = execSync(`npx tsx ${c.script}`, {
            encoding: 'utf-8',
            timeout: 600_000,
            maxBuffer: 50 * 1024 * 1024,
        });
    } catch (e) {
        const err = e as { stdout?: string; stderr?: string; status?: number };
        output = (err.stdout ?? '') + (err.stderr ?? '');
        exitCode = err.status ?? 1;
    }
    const wallMs = Date.now() - started;
    const lastLines = output.trimEnd().split('\n').slice(-5).join('\n');
    console.log(lastLines);
    console.log(`(${(wallMs / 1000).toFixed(1)}s, exit ${exitCode})`);
    return {
        num: c.num,
        name: c.name,
        script: c.script,
        status: exitCode === 0 ? 'pass' : 'fail',
        output,
        exitCode,
        wallMs,
    };
}

function gitInfo(): { branch: string; commit: string } {
    try {
        return {
            branch: execSync('git rev-parse --abbrev-ref HEAD').toString().trim(),
            commit: execSync('git rev-parse --short HEAD').toString().trim(),
        };
    } catch {
        return { branch: 'unknown', commit: 'unknown' };
    }
}

function buildReport(runs: CategoryRun[]): string {
    const date = new Date().toISOString().slice(0, 10);
    const { branch, commit } = gitInfo();
    const passed = runs.filter((r) => r.status === 'pass').length;
    const failed = runs.length - passed;
    const totalSec = (runs.reduce((s, r) => s + r.wallMs, 0) / 1000).toFixed(1);

    const lines: string[] = [];
    lines.push(`# LumenBench — ${date}`);
    lines.push('');
    lines.push(`**Branch:** \`${branch}\`  `);
    lines.push(`**Commit:** \`${commit}\`  `);
    lines.push(`**Engine:** better-sqlite3 (temp dir, WAL mode)  `);
    lines.push(`**Runtime:** tsx on Node ${process.version}  `);
    lines.push(`**Wall time:** ${totalSec}s`);
    lines.push('');

    lines.push(`## Summary`);
    lines.push('');
    lines.push(`${runs.length} categories run. ${passed} passed, ${failed} failed.`);
    lines.push('');
    lines.push(`| # | Category | Status | Wall time | Script |`);
    lines.push(`|---|----------|--------|-----------|--------|`);
    for (const r of runs) {
        const mark = r.status === 'pass' ? '✓ pass' : '✗ fail';
        lines.push(
            `| ${r.num} | ${r.name} | ${mark} | ${(r.wallMs / 1000).toFixed(1)}s | \`${r.script}\` |`,
        );
    }
    lines.push('');

    lines.push(`## What LumenBench measures`);
    lines.push('');
    lines.push(
        'LumenBench is an engine-level benchmark suite for Lumen — the local-first knowledge compiler.',
    );
    lines.push('Every category runs in-process against a fresh temp SQLite database.');
    lines.push('No LLM calls, no network, no API keys. Safe to run in CI.');
    lines.push('');
    lines.push('- **Ingest / Chunker** — throughput (docs/sec), per-doc latency, chunk shape');
    lines.push('  across markdown, HTML, and plaintext formats.');
    lines.push('- **Search Quality** — P@1, P@5, MRR, nDCG@5 comparing BM25, TF-IDF, and');
    lines.push('  RRF-fused hybrid on a curated 20-doc corpus with graded queries.');
    lines.push('- **Search Latency** — p50 / p95 / p99 at 100, 1K, 10K chunk scales.');
    lines.push('- **Graph Operations** — correctness of shortestPath, neighborhood,');
    lines.push('  pagerank, godNodes, and community detection on a seeded concept graph.');
    lines.push('- **MCP Contract** — valid / invalid input contract for every tool');
    lines.push('  dispatched through `handleToolCall`.');
    lines.push('- **Adversarial Robustness** — unicode, huge inputs, FTS5 operator strings,');
    lines.push('  SQL injection payloads, pathological slugs.');
    lines.push('');
    lines.push('An agent-level benchmark (quality with Claude Code in the loop) is tracked');
    lines.push('separately in `docs/docs-temp/BENCHMARK-PLAN.md`.');
    lines.push('');

    for (const r of runs) {
        lines.push(`---`);
        lines.push(`# Category ${r.num}: ${r.name}`);
        lines.push('');
        lines.push(`Status: ${r.status === 'pass' ? '✓ PASS' : '✗ FAIL'} (exit ${r.exitCode})`);
        lines.push(`Wall time: ${(r.wallMs / 1000).toFixed(2)}s`);
        lines.push('');
        lines.push('```');
        lines.push(r.output.trimEnd());
        lines.push('```');
        lines.push('');
    }

    lines.push(`---`);
    lines.push(`## How to reproduce`);
    lines.push('');
    lines.push('```bash');
    lines.push('# Combined run — writes report to docs/benchmarks/');
    lines.push('pnpm --filter lumen-kb bench');
    lines.push('');
    lines.push('# Or run a single category:');
    for (const c of CATEGORIES) {
        lines.push(`npx tsx ${c.script}`);
    }
    lines.push('```');
    lines.push('');
    lines.push('All runs target a temp SQLite database — your real `~/.lumen` is never touched.');

    return lines.join('\n') + '\n';
}

async function main() {
    const runs: CategoryRun[] = [];
    for (const c of CATEGORIES) {
        runs.push(runCategory(c));
    }

    const reportDir = 'docs/benchmarks';
    if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const reportPath = join(reportDir, `${date}-lumenbench.md`);
    writeFileSync(reportPath, buildReport(runs));

    console.log(`\n=== Report written to ${reportPath} ===`);
    const passed = runs.filter((r) => r.status === 'pass').length;
    console.log(`${passed}/${runs.length} categories passed`);

    if (runs.some((r) => r.status === 'fail')) process.exitCode = 1;
}

main().catch((e) => {
    console.error('all.ts error:', e);
    process.exit(1);
});
