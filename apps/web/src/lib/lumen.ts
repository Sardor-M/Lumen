/**
 * Server-only bridge between the Next.js web app and the Lumen CLI engine.
 * Imports store/search/graph functions from @lumen/cli and exposes thin
 * wrappers shaped for API route consumption.
 *
 * All functions here run server-side only — they open the SQLite file at
 * ~/.lumen/lumen.db (or $LUMEN_DIR/lumen.db) via the CLI's store layer.
 */

import 'server-only';
import { isInitialized } from '@lumen/cli/utils/paths';
import { countSources, listSources } from '@lumen/cli/store/sources';
import { countConcepts, listConcepts, getConcept } from '@lumen/cli/store/concepts';
import { countEdges, listEdges, getEdgesFrom, getEdgesTo } from '@lumen/cli/store/edges';
import { searchBm25 } from '@lumen/cli/search/bm25';
import { searchTfIdf } from '@lumen/cli/search/tfidf';
import { fuseRrf } from '@lumen/cli/search/fusion';
import { godNodes, neighborhood } from '@lumen/cli/graph/engine';
import { pagerank } from '@lumen/cli/graph/pagerank';
import { detectCommunities } from '@lumen/cli/graph/cluster';
import { getProfile } from '@lumen/cli/profile/cache';

export function status() {
    if (!isInitialized()) {
        return { initialized: false as const };
    }
    return {
        initialized: true as const,
        sources: countSources(),
        concepts: countConcepts(),
        edges: countEdges(),
    };
}

export function profile() {
    if (!isInitialized()) return null;
    return getProfile(false);
}

export function hybridSearch(query: string, limit = 20) {
    if (!isInitialized() || query.trim().length === 0) return [];

    const bm25 = searchBm25(query, limit);
    const tfidf = searchTfIdf(query, limit);

    const fused = fuseRrf(
        [
            { name: 'bm25', results: bm25, weight: 1 },
            {
                name: 'tfidf',
                results: tfidf.map((t) => ({
                    chunk_id: t.chunk_id,
                    source_id: t.source_id,
                    score: t.score,
                })),
                weight: 1,
            },
        ],
        60,
    );

    /** Join BM25 content/snippet back onto fused ordering for display. */
    const bm25ById = new Map(bm25.map((r) => [r.chunk_id, r]));
    return fused.slice(0, limit).map((f) => {
        const hit = bm25ById.get(f.chunk_id);
        return {
            chunk_id: f.chunk_id,
            source_id: f.source_id,
            rrf_score: f.rrf_score,
            signals: f.signals,
            source_title: hit?.source_title ?? null,
            snippet: hit?.snippet ?? null,
        };
    });
}

export function sources() {
    if (!isInitialized()) return [];
    return listSources();
}

export function concepts() {
    if (!isInitialized()) return [];
    return listConcepts();
}

export function concept(slug: string) {
    if (!isInitialized()) return null;
    const c = getConcept(slug);
    if (!c) return null;
    return {
        ...c,
        neighborhood: neighborhood(slug, 1),
        outgoing: getEdgesFrom(slug),
        incoming: getEdgesTo(slug),
    };
}

export function graphSnapshot(opts?: { limit?: number }) {
    if (!isInitialized()) return { nodes: [], edges: [], communities: [], god_nodes: [] };

    const limit = opts?.limit ?? 500;
    const allConcepts = listConcepts();
    const top = allConcepts.length > limit ? pagerank().slice(0, limit) : allConcepts;
    const keepSlugs = new Set(top.map((c) => c.slug));

    const nodes = allConcepts
        .filter((c) => keepSlugs.has(c.slug))
        .map((c) => ({ slug: c.slug, name: c.name, mentions: c.mention_count }));

    const edges = listEdges()
        .filter((e) => keepSlugs.has(e.from_slug) && keepSlugs.has(e.to_slug))
        .map((e) => ({
            from: e.from_slug,
            to: e.to_slug,
            relation: e.relation,
            weight: e.weight,
        }));

    const communities = detectCommunities()
        .slice(0, 10)
        .map((c) => ({ id: c.id, size: c.size, members: c.members.slice(0, 20) }));

    return { nodes, edges, communities, god_nodes: godNodes(10) };
}
