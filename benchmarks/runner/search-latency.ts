/**
 * LumenBench — Search latency benchmark.
 *
 * Measures BM25, TF-IDF, and RRF latency at three corpus scales (100 / 1K /
 * 10K chunks). Chunks are synthetic: varied prose drawn from a fixed
 * vocabulary so the FTS5 index has realistic term distribution without
 * needing real content.
 *
 * Protocol per scale:
 *   1. Fresh temp DB.
 *   2. Seed N chunks in a single transaction.
 *   3. Warm up with 20 queries (drops first-call JIT + FTS5 state).
 *   4. Run 200 timed queries drawn from a fixed query pool.
 *   5. Report p50/p95/p99 + qps.
 *
 * Usage: tsx benchmarks/runner/search-latency.ts [--json]
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { insertSource } from '../../apps/cli/src/store/sources.js';
import { insertChunks } from '../../apps/cli/src/store/chunks.js';
import { searchBm25 } from '../../apps/cli/src/search/bm25.js';
import { searchTfIdf } from '../../apps/cli/src/search/tfidf.js';
import { fuseRrf } from '../../apps/cli/src/search/fusion.js';
import { setDataDir, resetDataDir } from '../../apps/cli/src/utils/paths.js';
import { getDb, closeDb } from '../../apps/cli/src/store/database.js';
import { contentHash, shortId } from '../../apps/cli/src/utils/hash.js';
import type { Chunk } from '../../apps/cli/src/types/index.js';

const SCALES = [100, 1_000, 10_000];
const QUERIES_PER_RUN = 200;
const WARMUP = 20;

/** Small vocabulary with skewed frequency — gives realistic Zipf-ish term
 *  distribution so BM25's IDF has something to do. */
const VOCAB = [
    'bm25',
    'tfidf',
    'pagerank',
    'rrf',
    'sqlite',
    'fts5',
    'vector',
    'embedding',
    'chunk',
    'source',
    'concept',
    'edge',
    'relation',
    'implements',
    'extends',
    'retrieval',
    'hybrid',
    'search',
    'knowledge',
    'graph',
    'compile',
    'token',
    'budget',
    'porter',
    'stemmer',
    'intent',
    'classify',
    'neighbor',
    'path',
    'community',
    'cluster',
    'label',
    'propagation',
    'damping',
    'rank',
    'fusion',
    'density',
    'cosine',
    'distance',
    'similarity',
    'document',
    'query',
    'index',
    'insert',
    'select',
    'order',
    'limit',
    'score',
    'content',
    'lorem',
    'ipsum',
];

const STOPWORDS = ['the', 'of', 'and', 'to', 'a', 'in', 'that', 'is', 'for'];

/** Seeded-ish RNG — keeps runs reproducible when seeded with the same int. */
function mulberry32(seed: number) {
    let t = seed >>> 0;
    return () => {
        t = (t + 0x6d2b79f5) >>> 0;
        let x = t;
        x = Math.imul(x ^ (x >>> 15), x | 1);
        x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
}

function makeContent(rand: () => number, tokens: number): string {
    const parts: string[] = [];
    for (let i = 0; i < tokens; i++) {
        const r = rand();
        if (r < 0.3) parts.push(STOPWORDS[Math.floor(rand() * STOPWORDS.length)]);
        else parts.push(VOCAB[Math.floor(rand() * VOCAB.length)]);
    }
    return parts.join(' ');
}

function makeQueries(count: number, rand: () => number): string[] {
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
        const terms = 1 + Math.floor(rand() * 3); // 1..3 terms
        const picked: string[] = [];
        for (let t = 0; t < terms; t++) picked.push(VOCAB[Math.floor(rand() * VOCAB.length)]);
        out.push(picked.join(' '));
    }
    return out;
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
    return sorted[idx];
}

type ScaleResult = {
    scale: number;
    seedMs: number;
    mode: 'bm25' | 'tfidf' | 'rrf';
    p50: number;
    p95: number;
    p99: number;
    mean: number;
    qps: number;
};

function seedN(n: number, rand: () => number): number {
    const db = getDb();
    const now = new Date().toISOString();
    const content = makeContent(rand, 20);
    insertSource({
        id: 'synthetic',
        title: 'Synthetic corpus',
        url: null,
        content,
        content_hash: contentHash(content + ':' + n),
        source_type: 'file',
        added_at: now,
        compiled_at: null,
        word_count: 20,
        language: 'en',
        metadata: null,
    });

    const batches: Chunk[][] = [];
    let batch: Chunk[] = [];
    for (let i = 0; i < n; i++) {
        const text = makeContent(rand, 50 + Math.floor(rand() * 150));
        const id = shortId(`synthetic:${i}`);
        batch.push({
            id,
            source_id: 'synthetic',
            content: text,
            content_hash: contentHash(text),
            chunk_type: 'paragraph',
            heading: null,
            position: i,
            token_count: Math.ceil(text.length / 4),
        });
        if (batch.length >= 500) {
            batches.push(batch);
            batch = [];
        }
    }
    if (batch.length) batches.push(batch);

    const t0 = performance.now();
    /** Outer transaction wraps batch inserts — insertChunks already wraps
     *  each batch, but bundling them avoids N round-trips to the WAL header. */
    db.exec('BEGIN');
    try {
        for (const b of batches) insertChunks(b);
        db.exec('COMMIT');
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
    return performance.now() - t0;
}

function runScale(scale: number, queries: string[]): ScaleResult[] {
    const bmLat: number[] = [];
    const tfLat: number[] = [];
    const rrfLat: number[] = [];

    /** Warm up. */
    for (let i = 0; i < WARMUP; i++) {
        searchBm25(queries[i % queries.length], 10);
        searchTfIdf(queries[i % queries.length], 10);
    }

    for (let i = 0; i < QUERIES_PER_RUN; i++) {
        const q = queries[i % queries.length];

        const t1 = performance.now();
        const bm = searchBm25(q, 20);
        bmLat.push(performance.now() - t1);

        const t2 = performance.now();
        const tf = searchTfIdf(q, 20);
        tfLat.push(performance.now() - t2);

        const t3 = performance.now();
        fuseRrf(
            [
                {
                    name: 'bm25',
                    weight: 0.5,
                    results: bm.map((r) => ({
                        chunk_id: r.chunk_id,
                        source_id: r.source_id,
                        score: r.score,
                    })),
                },
                {
                    name: 'tfidf',
                    weight: 0.5,
                    results: tf.map((r) => ({
                        chunk_id: r.chunk_id,
                        source_id: r.source_id,
                        score: r.score,
                    })),
                },
            ],
            60,
        );
        rrfLat.push(performance.now() - t3 + bmLat[i] + tfLat[i]);
    }

    const build = (mode: 'bm25' | 'tfidf' | 'rrf', latencies: number[]): ScaleResult => {
        const sorted = [...latencies].sort((a, b) => a - b);
        const total = latencies.reduce((a, b) => a + b, 0);
        return {
            scale,
            seedMs: 0,
            mode,
            p50: +percentile(sorted, 0.5).toFixed(3),
            p95: +percentile(sorted, 0.95).toFixed(3),
            p99: +percentile(sorted, 0.99).toFixed(3),
            mean: +(total / latencies.length).toFixed(3),
            qps: +(latencies.length / (total / 1000)).toFixed(1),
        };
    };

    return [build('bm25', bmLat), build('tfidf', tfLat), build('rrf', rrfLat)];
}

async function main() {
    const json = process.argv.includes('--json');
    const log = json ? () => {} : (msg: string) => console.log(msg);

    log('# LumenBench — search latency\n');
    log(`Generated: ${new Date().toISOString().slice(0, 19)}`);
    log(
        `Scales: ${SCALES.join(', ')} chunks. ${QUERIES_PER_RUN} queries per run, ${WARMUP} warmup.\n`,
    );

    const rand = mulberry32(42);
    const queries = makeQueries(50, rand);

    const allResults: ScaleResult[] = [];

    for (const scale of SCALES) {
        /** Fresh DB per scale — no carryover. */
        const tempDir = mkdtempSync(join(tmpdir(), `lumen-bench-lat-${scale}-`));
        setDataDir(tempDir);
        try {
            log(`## Seeding ${scale} chunks...`);
            const seedMs = seedN(scale, mulberry32(scale + 1));
            log(
                `  seeded in ${seedMs.toFixed(0)} ms (${((scale / seedMs) * 1000).toFixed(0)} chunks/sec)`,
            );

            const results = runScale(scale, queries);
            for (const r of results) r.seedMs = +seedMs.toFixed(1);
            allResults.push(...results);
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

    log('\n## Latency per scale\n');
    log('| scale  | mode  | p50 ms | p95 ms | p99 ms | mean ms | qps      | seed ms  |');
    log('|--------|-------|--------|--------|--------|---------|----------|----------|');
    for (const r of allResults) {
        log(
            `| ${String(r.scale).padEnd(6)} | ${r.mode.padEnd(5)} | ${String(r.p50).padEnd(6)} | ${String(r.p95).padEnd(6)} | ${String(r.p99).padEnd(6)} | ${String(r.mean).padEnd(7)} | ${String(r.qps).padEnd(8)} | ${String(r.seedMs).padEnd(8)} |`,
        );
    }

    /** Fail gates: p95 > 200ms at 10K chunks is a regression worth flagging.
     *  These thresholds are loose — BM25 on 10K rows should be ≤ a few ms
     *  on any modern machine. */
    const failures: string[] = [];
    for (const r of allResults) {
        const cap = r.scale <= 1000 ? 50 : 200;
        if (r.p95 > cap) failures.push(`${r.mode}@${r.scale} p95 ${r.p95}ms > ${cap}ms`);
    }

    log('\n## Status\n');
    if (failures.length === 0) {
        log('PASS — search latency within envelope at all scales.');
    } else {
        log(`FAIL — ${failures.length} issue(s):`);
        for (const f of failures) log(`  - ${f}`);
    }

    if (json) {
        process.stdout.write(JSON.stringify({ results: allResults, failures }, null, 2) + '\n');
    }

    if (failures.length > 0) process.exitCode = 1;
}

main().catch((e) => {
    console.error('search-latency bench error:', e);
    process.exit(1);
});
