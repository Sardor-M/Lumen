/**
 * LumenBench — Ingest (chunker) benchmark.
 *
 * Measures the chunker in isolation: throughput (docs/sec, bytes/sec), latency
 * (p50/p95/p99), and output shape (chunk count, token-count distribution) across
 * the three formats Lumen supports (markdown, html, plain).
 *
 * Ingest also exercises detectFormat(). We sample 150 real-ish documents per
 * format: markdown from the corpus-v1 fixtures, html synthesized from the same
 * content wrapped in tags, plain text stripped of markup. Each is chunked once;
 * percentiles come from the sample.
 *
 * No LLM, no network, no DB. Pure chunker call. Safe to run in CI.
 *
 * Usage: tsx benchmarks/runner/ingest.ts [--json]
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { chunk, detectFormat } from '../../apps/cli/src/chunker/index.js';

type FormatName = 'markdown' | 'html' | 'plain';

type Sample = { format: FormatName; content: string; sourceId: string };

type RunStats = {
    format: FormatName;
    docs: number;
    bytesTotal: number;
    chunksTotal: number;
    tokensTotal: number;
    latenciesMs: number[];
    chunkCountHist: number[];
    tokenCountHist: number[];
    wallMs: number;
};

const CORPUS_DIR = 'benchmarks/data/corpus-v1';

function loadCorpusMd(): string[] {
    const files = readdirSync(CORPUS_DIR)
        .filter((f) => f.endsWith('.md'))
        .sort();
    return files.map((f) => readFileSync(join(CORPUS_DIR, f), 'utf-8'));
}

/** Strip markdown markers to a plausible plain-text variant. Not perfect —
 *  it just removes heading hashes, code-fence lines, list bullets, and link
 *  brackets. Produces prose that detectFormat() will classify as 'plain'. */
function toPlain(md: string): string {
    return md
        .split('\n')
        .map((l) => l.replace(/^#{1,6}\s+/, ''))
        .filter((l) => !l.startsWith('```'))
        .map((l) => l.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, ''))
        .map((l) => l.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'))
        .join('\n');
}

/** Wrap markdown-ish content in a minimal HTML skeleton. detectFormat()
 *  triggers on doctype / <html> / tag density. */
function toHtml(md: string, title: string): string {
    const paragraphs = md
        .split(/\n\n+/)
        .map(
            (p) =>
                `  <p>${p.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] ?? c)}</p>`,
        )
        .join('\n');
    return `<!doctype html>\n<html>\n<head><title>${title}</title></head>\n<body>\n  <h1>${title}</h1>\n${paragraphs}\n</body>\n</html>\n`;
}

function buildSamples(): Sample[] {
    const mdDocs = loadCorpusMd();
    const samples: Sample[] = [];

    /** Replicate each corpus doc a few times to get a 150-doc sample per format.
     *  Replication is fine for timing — the chunker has no cross-doc state. */
    const replications = Math.ceil(150 / mdDocs.length);

    for (let r = 0; r < replications; r++) {
        for (let i = 0; i < mdDocs.length; i++) {
            const md = mdDocs[i];
            const title = `doc-${r}-${i}`;
            samples.push({ format: 'markdown', content: md, sourceId: `md-${r}-${i}` });
            samples.push({
                format: 'html',
                content: toHtml(md, title),
                sourceId: `html-${r}-${i}`,
            });
            samples.push({ format: 'plain', content: toPlain(md), sourceId: `plain-${r}-${i}` });
        }
    }

    return samples;
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
    return sorted[idx];
}

function runFormat(samples: Sample[]): RunStats {
    const subset = samples.slice(0, 150);
    const stats: RunStats = {
        format: subset[0].format,
        docs: 0,
        bytesTotal: 0,
        chunksTotal: 0,
        tokensTotal: 0,
        latenciesMs: [],
        chunkCountHist: [],
        tokenCountHist: [],
        wallMs: 0,
    };

    const wallStart = performance.now();

    for (const s of subset) {
        const t0 = performance.now();
        const chunks = chunk(s.content, s.sourceId);
        const dt = performance.now() - t0;

        stats.docs++;
        stats.bytesTotal += Buffer.byteLength(s.content, 'utf-8');
        stats.chunksTotal += chunks.length;
        stats.chunkCountHist.push(chunks.length);
        for (const c of chunks) {
            stats.tokensTotal += c.token_count;
            stats.tokenCountHist.push(c.token_count);
        }
        stats.latenciesMs.push(dt);
    }

    stats.wallMs = performance.now() - wallStart;
    return stats;
}

function summarize(s: RunStats) {
    const sorted = [...s.latenciesMs].sort((a, b) => a - b);
    const tokenSorted = [...s.tokenCountHist].sort((a, b) => a - b);
    const docsPerSec = (s.docs / s.wallMs) * 1000;
    const bytesPerSec = (s.bytesTotal / s.wallMs) * 1000;
    return {
        format: s.format,
        docs: s.docs,
        bytes_total: s.bytesTotal,
        chunks_total: s.chunksTotal,
        tokens_total: s.tokensTotal,
        avg_chunks_per_doc: s.chunksTotal / s.docs,
        token_p50: percentile(tokenSorted, 0.5),
        token_p95: percentile(tokenSorted, 0.95),
        lat_p50_ms: +percentile(sorted, 0.5).toFixed(3),
        lat_p95_ms: +percentile(sorted, 0.95).toFixed(3),
        lat_p99_ms: +percentile(sorted, 0.99).toFixed(3),
        lat_mean_ms: +(s.latenciesMs.reduce((a, b) => a + b, 0) / s.latenciesMs.length).toFixed(3),
        wall_ms: +s.wallMs.toFixed(1),
        docs_per_sec: +docsPerSec.toFixed(1),
        mb_per_sec: +(bytesPerSec / (1024 * 1024)).toFixed(2),
    };
}

async function main() {
    const json = process.argv.includes('--json');
    const log = json ? () => {} : (msg: string) => console.log(msg);

    log('# LumenBench — ingest / chunker\n');
    log(`Generated: ${new Date().toISOString().slice(0, 19)}`);
    log(`Corpus: ${CORPUS_DIR}`);

    const samples = buildSamples();
    log(`Samples: ${samples.length} total across markdown/html/plain (150 per format)\n`);

    /** Warm up — first chunker call pays one-time JS compile cost we don't
     *  want polluting the first-format percentiles. */
    chunk(samples[0].content, 'warmup');

    const byFormat: Record<FormatName, Sample[]> = { markdown: [], html: [], plain: [] };
    for (const s of samples) byFormat[s.format].push(s);

    const results = [
        runFormat(byFormat.markdown),
        runFormat(byFormat.html),
        runFormat(byFormat.plain),
    ];

    /** Format detection sanity check. */
    let detectOk = 0;
    for (const s of samples.slice(0, 30)) {
        if (detectFormat(s.content) === s.format) detectOk++;
    }

    const summaries = results.map(summarize);

    log('## Throughput\n');
    log('| Format   | Docs | Chunks | Tokens  | Docs/sec | MB/sec | Wall ms |');
    log('|----------|------|--------|---------|----------|--------|---------|');
    for (const r of summaries) {
        log(
            `| ${r.format.padEnd(8)} | ${String(r.docs).padEnd(4)} | ${String(r.chunks_total).padEnd(6)} | ${String(r.tokens_total).padEnd(7)} | ${String(r.docs_per_sec).padEnd(8)} | ${String(r.mb_per_sec).padEnd(6)} | ${String(r.wall_ms).padEnd(7)} |`,
        );
    }

    log('\n## Per-document latency\n');
    log('| Format   | p50 ms | p95 ms | p99 ms | mean ms |');
    log('|----------|--------|--------|--------|---------|');
    for (const r of summaries) {
        log(
            `| ${r.format.padEnd(8)} | ${String(r.lat_p50_ms).padEnd(6)} | ${String(r.lat_p95_ms).padEnd(6)} | ${String(r.lat_p99_ms).padEnd(6)} | ${String(r.lat_mean_ms).padEnd(7)} |`,
        );
    }

    log('\n## Chunk shape\n');
    log('| Format   | chunks/doc | token p50 | token p95 |');
    log('|----------|------------|-----------|-----------|');
    for (const r of summaries) {
        log(
            `| ${r.format.padEnd(8)} | ${r.avg_chunks_per_doc.toFixed(1).padEnd(10)} | ${String(r.token_p50).padEnd(9)} | ${String(r.token_p95).padEnd(9)} |`,
        );
    }

    log(`\nFormat auto-detection: ${detectOk}/30 samples classified correctly.`);

    /** Pass/fail flags — if any format's p95 latency exceeds a generous 50ms
     *  on a 150-doc corpus of small markdown, something went backwards. */
    const failures: string[] = [];
    for (const r of summaries) {
        if (r.lat_p95_ms > 50) failures.push(`${r.format} p95 ${r.lat_p95_ms}ms > 50ms`);
        if (r.docs_per_sec < 20)
            failures.push(`${r.format} throughput ${r.docs_per_sec} docs/sec < 20`);
    }
    if (detectOk < 28) failures.push(`format detection ${detectOk}/30 < 28 threshold`);

    log(`\n## Status\n`);
    if (failures.length === 0) {
        log('PASS — chunker throughput and latency within expected envelope.');
    } else {
        log(`FAIL — ${failures.length} issue(s):`);
        for (const f of failures) log(`  - ${f}`);
    }

    if (json) {
        process.stdout.write(
            JSON.stringify({ summaries, detect_ok: detectOk, failures }, null, 2) + '\n',
        );
    }

    if (failures.length > 0) process.exitCode = 1;
}

main().catch((e) => {
    console.error('ingest bench error:', e);
    process.exit(1);
});
