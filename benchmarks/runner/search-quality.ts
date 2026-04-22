/**
 * LumenBench — Search quality benchmark.
 *
 * Compares BM25, TF-IDF, and RRF-fused hybrid search on a curated corpus
 * (benchmarks/data/corpus-v1/*.md) with a graded query set
 * (benchmarks/data/corpus-v1/queries.json).
 *
 * Metrics per mode:
 *   - P@1    — fraction of queries where top-1 hit maps to a relevant doc
 *   - P@5    — avg of (relevant in top-5) / 5
 *   - MRR    — mean reciprocal rank of the first relevant hit
 *   - nDCG@5 — discounted cumulative gain normalized by the ideal ranking
 *
 * Relevance grades: 3 = exact topic, 2 = major reference, 1 = passing mention,
 * 0 = irrelevant. Results map chunks → source docs by source_id.
 *
 * No LLM, no network. Writes to a temp dir; never touches ~/.lumen.
 *
 * Usage: tsx benchmarks/runner/search-quality.ts [--json]
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { chunk } from '../../apps/cli/src/chunker/index.js';
import { insertSource } from '../../apps/cli/src/store/sources.js';
import { insertChunks } from '../../apps/cli/src/store/chunks.js';
import { searchBm25 } from '../../apps/cli/src/search/bm25.js';
import { searchTfIdf } from '../../apps/cli/src/search/tfidf.js';
import { fuseRrf } from '../../apps/cli/src/search/fusion.js';
import { setDataDir, resetDataDir } from '../../apps/cli/src/utils/paths.js';
import { getDb, closeDb } from '../../apps/cli/src/store/database.js';
import { contentHash } from '../../apps/cli/src/utils/hash.js';

type QueryEntry = {
    id: string;
    query: string;
    category: string;
    /** docSlug → relevance grade 0..3 */
    relevant: Record<string, number>;
};

type QuerySet = { queries: QueryEntry[] };

type Mode = 'bm25' | 'tfidf' | 'rrf';

type Hit = { chunk_id: string; source_id: string; score: number };

type ScoredQuery = {
    id: string;
    mode: Mode;
    /** Ranked list of unique source slugs (chunks deduped by source). */
    ranked: string[];
    p1: number;
    p5: number;
    rr: number;
    ndcg5: number;
    latencyMs: number;
};

const CORPUS_DIR = 'benchmarks/data/corpus-v1';
const K = 5;

function loadCorpus(): { slug: string; title: string; content: string }[] {
    return readdirSync(CORPUS_DIR)
        .filter((f) => f.endsWith('.md'))
        .map((f) => {
            const content = readFileSync(join(CORPUS_DIR, f), 'utf-8');
            const slug = f.replace(/\.md$/, '');
            const firstLine = content.split('\n').find((l) => l.startsWith('# ')) ?? slug;
            const title = firstLine.replace(/^#\s+/, '').trim();
            return { slug, title, content };
        });
}

function loadQueries(): QuerySet {
    return JSON.parse(readFileSync(join(CORPUS_DIR, 'queries.json'), 'utf-8')) as QuerySet;
}

function seedCorpus(docs: { slug: string; title: string; content: string }[]): void {
    const db = getDb();
    const now = new Date().toISOString();
    /** Seed everything under a single transaction for speed. */
    const tx = db.transaction(() => {
        for (const d of docs) {
            insertSource({
                id: d.slug,
                title: d.title,
                url: null,
                content: d.content,
                content_hash: contentHash(d.content),
                source_type: 'file',
                added_at: now,
                compiled_at: null,
                word_count: d.content.split(/\s+/).length,
                language: 'en',
                metadata: null,
            });
            const chunks = chunk(d.content, d.slug);
            insertChunks(chunks);
        }
    });
    tx();
}

/** Dedupe a ranked list of chunks down to unique source slugs, preserving
 *  order. This is what the agent sees at the source level — a single doc
 *  should contribute at most once to precision/recall. */
function chunksToSourceRanking(hits: Hit[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const h of hits) {
        if (!seen.has(h.source_id)) {
            seen.add(h.source_id);
            out.push(h.source_id);
        }
    }
    return out;
}

function dcgAt(ranked: string[], grades: Record<string, number>, k: number): number {
    let dcg = 0;
    for (let i = 0; i < Math.min(k, ranked.length); i++) {
        const g = grades[ranked[i]] ?? 0;
        /** 2^g - 1 / log2(i + 2) — the common formulation. */
        dcg += (Math.pow(2, g) - 1) / Math.log2(i + 2);
    }
    return dcg;
}

function idealDcgAt(grades: Record<string, number>, k: number): number {
    const sortedGrades = Object.values(grades).sort((a, b) => b - a);
    let dcg = 0;
    for (let i = 0; i < Math.min(k, sortedGrades.length); i++) {
        dcg += (Math.pow(2, sortedGrades[i]) - 1) / Math.log2(i + 2);
    }
    return dcg;
}

function scoreOne(q: QueryEntry, mode: Mode, ranked: string[], latencyMs: number): ScoredQuery {
    const p1 = (q.relevant[ranked[0]] ?? 0) > 0 ? 1 : 0;

    let relInTop5 = 0;
    for (let i = 0; i < Math.min(K, ranked.length); i++) {
        if ((q.relevant[ranked[i]] ?? 0) > 0) relInTop5++;
    }
    const p5 = relInTop5 / K;

    /** MRR: 1 / rank of first relevant hit in the full returned list. */
    let rr = 0;
    for (let i = 0; i < ranked.length; i++) {
        if ((q.relevant[ranked[i]] ?? 0) > 0) {
            rr = 1 / (i + 1);
            break;
        }
    }

    const ideal = idealDcgAt(q.relevant, K);
    const ndcg5 = ideal > 0 ? dcgAt(ranked, q.relevant, K) / ideal : 0;

    return { id: q.id, mode, ranked, p1, p5, rr, ndcg5, latencyMs };
}

async function main() {
    const json = process.argv.includes('--json');
    const log = json ? () => {} : (msg: string) => console.log(msg);

    log('# LumenBench — search quality\n');
    log(`Generated: ${new Date().toISOString().slice(0, 19)}`);

    /** Isolate all DB state in a temp dir. */
    const tempDir = mkdtempSync(join(tmpdir(), 'lumen-bench-search-'));
    setDataDir(tempDir);

    try {
        const docs = loadCorpus();
        const { queries } = loadQueries();
        log(`Corpus: ${docs.length} docs, Queries: ${queries.length}\n`);

        seedCorpus(docs);

        /** Warm up FTS5 — first query compiles internal state. */
        searchBm25('warmup', 5);

        const byMode: Record<Mode, ScoredQuery[]> = { bm25: [], tfidf: [], rrf: [] };

        for (const q of queries) {
            const t1 = performance.now();
            const bm25 = searchBm25(q.query, 20);
            const bm25Ms = performance.now() - t1;

            const t2 = performance.now();
            const tfidf = searchTfIdf(q.query, 20);
            const tfidfMs = performance.now() - t2;

            const t3 = performance.now();
            const fused = fuseRrf(
                [
                    {
                        name: 'bm25',
                        weight: 0.5,
                        results: bm25.map((r) => ({
                            chunk_id: r.chunk_id,
                            source_id: r.source_id,
                            score: r.score,
                        })),
                    },
                    {
                        name: 'tfidf',
                        weight: 0.5,
                        results: tfidf.map((r) => ({
                            chunk_id: r.chunk_id,
                            source_id: r.source_id,
                            score: r.score,
                        })),
                    },
                ],
                60,
            );
            const rrfMs = performance.now() - t3;
            const rrfHits: Hit[] = fused.map((r) => ({
                chunk_id: r.chunk_id,
                source_id: r.source_id,
                score: r.rrf_score,
            }));

            byMode.bm25.push(
                scoreOne(
                    q,
                    'bm25',
                    chunksToSourceRanking(
                        bm25.map((r) => ({
                            chunk_id: r.chunk_id,
                            source_id: r.source_id,
                            score: r.score,
                        })),
                    ),
                    bm25Ms,
                ),
            );
            byMode.tfidf.push(
                scoreOne(
                    q,
                    'tfidf',
                    chunksToSourceRanking(
                        tfidf.map((r) => ({
                            chunk_id: r.chunk_id,
                            source_id: r.source_id,
                            score: r.score,
                        })),
                    ),
                    tfidfMs,
                ),
            );
            byMode.rrf.push(scoreOne(q, 'rrf', chunksToSourceRanking(rrfHits), rrfMs));
        }

        const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / (arr.length || 1);

        type Agg = {
            mode: Mode;
            p1: number;
            p5: number;
            mrr: number;
            ndcg5: number;
            lat_mean_ms: number;
        };
        const aggs: Agg[] = (['bm25', 'tfidf', 'rrf'] as Mode[]).map((mode) => {
            const xs = byMode[mode];
            return {
                mode,
                p1: avg(xs.map((x) => x.p1)),
                p5: avg(xs.map((x) => x.p5)),
                mrr: avg(xs.map((x) => x.rr)),
                ndcg5: avg(xs.map((x) => x.ndcg5)),
                lat_mean_ms: avg(xs.map((x) => x.latencyMs)),
            };
        });

        const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

        log('## Headline — ranking quality\n');
        log('| Mode  | P@1     | P@5     | MRR     | nDCG@5  | mean ms |');
        log('|-------|---------|---------|---------|---------|---------|');
        for (const a of aggs) {
            log(
                `| ${a.mode.padEnd(5)} | ${pct(a.p1).padEnd(7)} | ${pct(a.p5).padEnd(7)} | ${a.mrr.toFixed(3).padEnd(7)} | ${a.ndcg5.toFixed(3).padEnd(7)} | ${a.lat_mean_ms.toFixed(2).padEnd(7)} |`,
            );
        }

        log('\n## Per-query top-1 hit (RRF mode)\n');
        log(
            '| id  | query                                             | top-1                   | relevant? |',
        );
        log(
            '|-----|---------------------------------------------------|-------------------------|-----------|',
        );
        for (const r of byMode.rrf) {
            const q = queries.find((x) => x.id === r.id)!;
            const top1 = r.ranked[0] ?? '(none)';
            const rel = r.p1 === 1 ? 'yes' : 'no';
            log(
                `| ${q.id.padEnd(3)} | ${q.query.slice(0, 49).padEnd(49)} | ${top1.slice(0, 23).padEnd(23)} | ${rel.padEnd(9)} |`,
            );
        }

        /** Fail flags — these thresholds reflect what a correctly-tuned hybrid
         *  retriever should hit on a 20-doc curated corpus with clean queries.
         *  If any fire, the ranker regressed. */
        const failures: string[] = [];
        const rrf = aggs.find((a) => a.mode === 'rrf')!;
        if (rrf.p1 < 0.6) failures.push(`RRF P@1 ${pct(rrf.p1)} < 60%`);
        if (rrf.mrr < 0.65) failures.push(`RRF MRR ${rrf.mrr.toFixed(3)} < 0.65`);
        if (rrf.ndcg5 < 0.6) failures.push(`RRF nDCG@5 ${rrf.ndcg5.toFixed(3)} < 0.60`);

        log(`\n## Status\n`);
        if (failures.length === 0) {
            log('PASS — search quality within expected envelope on curated corpus.');
        } else {
            log(`FAIL — ${failures.length} issue(s):`);
            for (const f of failures) log(`  - ${f}`);
        }

        if (json) {
            process.stdout.write(
                JSON.stringify({ aggs, perQuery: byMode.rrf, failures }, null, 2) + '\n',
            );
        }

        if (failures.length > 0) process.exitCode = 1;
    } finally {
        closeDb();
        resetDataDir();
        try {
            rmSync(tempDir, { recursive: true, force: true });
        } catch {
            /** temp dir cleanup is best-effort */
        }
    }
}

main().catch((e) => {
    console.error('search-quality bench error:', e);
    process.exit(1);
});
