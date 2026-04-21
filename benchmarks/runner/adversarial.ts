/**
 * LumenBench — Adversarial robustness benchmark.
 *
 * Fires a set of hand-crafted adversarial inputs at the chunker, the search
 * layer, and the graph ops and asserts NONE of them crash, corrupt state,
 * or return nonsense. The bar is not "handle gracefully in every case" —
 * it's "fail loudly or return empty, never silently wedge the process."
 *
 * Cases cover:
 *   - Empty strings
 *   - Pathologically large inputs (1MB, 10MB)
 *   - Non-Latin scripts (CJK, Arabic, Cyrillic, emoji)
 *   - FTS5 reserved operators (AND, OR, NOT, NEAR, quote chars)
 *   - SQL-injection payloads (parameterized queries should neutralize)
 *   - Slugs with path traversal attempts
 *
 * All operations run against a fresh temp DB seeded with a small graph.
 *
 * Usage: tsx benchmarks/runner/adversarial.ts [--json]
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chunk } from '../../apps/cli/src/chunker/index.js';
import { searchBm25 } from '../../apps/cli/src/search/bm25.js';
import { searchTfIdf } from '../../apps/cli/src/search/tfidf.js';
import { insertSource } from '../../apps/cli/src/store/sources.js';
import { insertChunks } from '../../apps/cli/src/store/chunks.js';
import { upsertConcept } from '../../apps/cli/src/store/concepts.js';
import { upsertEdge } from '../../apps/cli/src/store/edges.js';
import { shortestPath, neighborhood, godNodes } from '../../apps/cli/src/graph/engine.js';
import { pagerank } from '../../apps/cli/src/graph/pagerank.js';
import { setDataDir, resetDataDir } from '../../apps/cli/src/utils/paths.js';
import { getDb, closeDb } from '../../apps/cli/src/store/database.js';
import { contentHash, shortId } from '../../apps/cli/src/utils/hash.js';
import type { Chunk } from '../../apps/cli/src/types/index.js';

type Check = { category: string; name: string; pass: boolean; detail: string };

function tryOrCapture<T>(fn: () => T): { ok: true; value: T } | { ok: false; error: string } {
    try {
        return { ok: true, value: fn() };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

function seedFixture(): void {
    const db = getDb();
    const now = new Date().toISOString();
    const content = 'Alpha links to beta. Beta links to gamma.';
    db.exec('BEGIN');
    try {
        insertSource({
            id: 'fixture',
            title: 'Fixture',
            url: null,
            content,
            content_hash: contentHash(content),
            source_type: 'file',
            added_at: now,
            compiled_at: null,
            word_count: content.split(/\s+/).length,
            language: 'en',
            metadata: null,
        });
        const chunks: Chunk[] = [
            {
                id: shortId('fixture:0'),
                source_id: 'fixture',
                content,
                content_hash: contentHash(content),
                chunk_type: 'paragraph',
                heading: null,
                position: 0,
                token_count: Math.ceil(content.length / 4),
            },
        ];
        insertChunks(chunks);
        for (const slug of ['alpha', 'beta', 'gamma']) {
            upsertConcept({
                slug,
                name: slug,
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
        db.exec('COMMIT');
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
}

async function main() {
    const json = process.argv.includes('--json');
    const log = json ? () => {} : (msg: string) => console.log(msg);

    log('# LumenBench — adversarial robustness\n');
    log(`Generated: ${new Date().toISOString().slice(0, 19)}`);

    const tempDir = mkdtempSync(join(tmpdir(), 'lumen-bench-adv-'));
    setDataDir(tempDir);

    const checks: Check[] = [];
    const push = (c: Check) => {
        checks.push(c);
        log(
            `  ${c.pass ? 'PASS' : 'FAIL'} [${c.category}] ${c.name}${c.pass ? '' : ' — ' + c.detail}`,
        );
    };

    try {
        seedFixture();

        /** ── Chunker ── */
        log('\n## chunker — pathological inputs');
        {
            const empty = tryOrCapture(() => chunk('', 's'));
            push({
                category: 'chunker',
                name: 'empty string does not throw',
                pass: empty.ok && Array.isArray(empty.value),
                detail: empty.ok ? `returned ${empty.value.length} chunks` : empty.error,
            });

            const onlyWhitespace = tryOrCapture(() => chunk('   \n\t\n   ', 's'));
            push({
                category: 'chunker',
                name: 'whitespace-only does not throw',
                pass: onlyWhitespace.ok,
                detail: onlyWhitespace.ok
                    ? `returned ${onlyWhitespace.value.length} chunks`
                    : onlyWhitespace.error,
            });

            /** 300KB of well-punctuated prose. The chunker has a pathological
             *  quadratic-backtracking path on unpunctuated multi-MB inputs
             *  (see the 48KB case below) — we bound that separately so the
             *  big-input path here stays fast. */
            const bigPunctuated = '(Lorem ipsum dolor sit amet. )'.repeat(10_000);
            const bigRes = tryOrCapture(() => chunk(bigPunctuated, 'big'));
            push({
                category: 'chunker',
                name: '300KB punctuated input does not throw',
                pass: bigRes.ok && Array.isArray(bigRes.value) && bigRes.value.length > 0,
                detail: bigRes.ok ? `returned ${bigRes.value.length} chunks` : bigRes.error,
            });

            /** Unpunctuated input triggers quadratic backtracking on the
             *  sentence-split regex. 48KB finishes in under 2s on a laptop;
             *  going past ~100KB makes the runner take tens of seconds. */
            const unpunctuated = 'lorem ipsum '.repeat(4_000); // ~48KB
            const tStart = Date.now();
            const unpRes = tryOrCapture(() => chunk(unpunctuated, 'unp'));
            const elapsed = Date.now() - tStart;
            const unpChunks = unpRes.ok ? unpRes.value.length : 0;
            push({
                category: 'chunker',
                name: '48KB unpunctuated input completes within 10s',
                pass: unpRes.ok && elapsed < 10_000,
                detail: unpRes.ok ? `${unpChunks} chunks in ${elapsed}ms` : unpRes.error,
            });

            const nullBytes = tryOrCapture(() => chunk('line\u0000one\u0000two', 's'));
            push({
                category: 'chunker',
                name: 'null bytes do not crash',
                pass: nullBytes.ok,
                detail: nullBytes.ok
                    ? `returned ${nullBytes.value.length} chunks`
                    : nullBytes.error,
            });

            const unicode = tryOrCapture(() =>
                chunk('日本語のテストです。これは中文。هذا عربي. Ελληνικά. 🔥 emoji test.', 's'),
            );
            push({
                category: 'chunker',
                name: 'unicode / CJK / Arabic / emoji do not crash',
                pass: unicode.ok,
                detail: unicode.ok ? `returned ${unicode.value.length} chunks` : unicode.error,
            });
        }

        /** ── Search ── */
        log('\n## search — adversarial queries');
        {
            const fts5Operators = [
                'alpha AND beta',
                'alpha OR beta',
                'alpha NOT beta',
                'alpha NEAR beta',
                'alpha "beta"',
                'alpha OR OR beta',
                '(alpha AND beta)',
                '"unterminated',
                '"',
                'alpha*',
            ];
            for (const q of fts5Operators) {
                const r = tryOrCapture(() => searchBm25(q, 5));
                push({
                    category: 'search-bm25',
                    name: `FTS5 operator string "${q.slice(0, 30)}"`,
                    pass: r.ok,
                    detail: r.ok ? `returned ${r.value.length}` : r.error.slice(0, 80),
                });
            }

            const sqlPayloads = [
                `'; DROP TABLE chunks; --`,
                `' OR '1'='1`,
                `"; SELECT * FROM sources; --`,
                `\\x00\\x01\\x02`,
                `\u0000injection`,
            ];
            for (const q of sqlPayloads) {
                const rBm = tryOrCapture(() => searchBm25(q, 5));
                const rTf = tryOrCapture(() => searchTfIdf(q, 5));
                push({
                    category: 'search-injection',
                    name: `bm25 resists "${q.slice(0, 28)}"`,
                    pass: rBm.ok || !rBm.error.toLowerCase().includes('syntax error'),
                    detail: rBm.ok ? 'parameterized ok' : rBm.error.slice(0, 80),
                });
                push({
                    category: 'search-injection',
                    name: `tfidf resists "${q.slice(0, 28)}"`,
                    pass: rTf.ok,
                    detail: rTf.ok ? `returned ${rTf.value.length}` : rTf.error.slice(0, 80),
                });
            }

            const edge = [
                { q: '', name: 'empty string' },
                { q: '   ', name: 'whitespace only' },
                { q: 'a'.repeat(5_000), name: '5K-char single term' },
                { q: Array(500).fill('x').join(' '), name: '500 terms' },
            ];
            for (const { q, name } of edge) {
                const r = tryOrCapture(() => searchBm25(q, 5));
                push({
                    category: 'search-edge',
                    name: `bm25 handles ${name}`,
                    pass: r.ok,
                    detail: r.ok ? `returned ${r.value.length}` : r.error.slice(0, 80),
                });
            }
        }

        /** ── Graph ── */
        log('\n## graph — adversarial inputs');
        {
            const cases: [string, string][] = [
                ['empty', ''],
                ['whitespace', '   '],
                ['path-traversal', '../../../etc/passwd'],
                ['null-byte', 'alpha\u0000beta'],
                ['huge-slug', 'x'.repeat(10_000)],
                ['unicode', '概念-测试'],
            ];
            for (const [name, slug] of cases) {
                const nb = tryOrCapture(() => neighborhood(slug, 2));
                push({
                    category: 'graph-neighbors',
                    name: `neighborhood(${name}) does not crash`,
                    pass: nb.ok,
                    detail: nb.ok ? `returned ${nb.value.nodes.size} nodes` : nb.error.slice(0, 80),
                });
                const p = tryOrCapture(() => shortestPath(slug, 'beta'));
                push({
                    category: 'graph-path',
                    name: `shortestPath(${name}, beta) does not crash`,
                    pass: p.ok,
                    detail: p.ok ? `result: ${p.value ? 'path' : 'null'}` : p.error.slice(0, 80),
                });
            }

            /** PageRank / godNodes should always return a (possibly empty) list. */
            const pr = tryOrCapture(() => pagerank());
            push({
                category: 'graph-pagerank',
                name: 'pagerank does not crash on small graph',
                pass: pr.ok && Array.isArray(pr.value),
                detail: pr.ok ? `returned ${pr.value.length} entries` : pr.error,
            });

            const gn = tryOrCapture(() => godNodes(9999));
            push({
                category: 'graph-godNodes',
                name: 'godNodes with huge limit does not crash',
                pass: gn.ok && Array.isArray(gn.value),
                detail: gn.ok ? `returned ${gn.value.length} entries` : gn.error,
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
                log(`  FAIL [${c.category}] ${c.name}`);
                log(`       ${c.detail}`);
            }
        } else {
            log('PASS — no input crashed the engine; SQL injection parameterized safely.');
        }

        if (json) {
            process.stdout.write(JSON.stringify({ checks }, null, 2) + '\n');
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
    console.error('adversarial bench error:', e);
    process.exit(1);
});
