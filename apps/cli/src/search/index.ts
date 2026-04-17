import { classifyIntent } from '../classify/intent.js';
import { searchBm25 } from './bm25.js';
import { searchTfIdf } from './tfidf.js';
import { searchVector } from './vector.js';
import { fuseRrf } from './fusion.js';
import { selectByBudget } from './budget.js';
import { getConcept } from '../store/concepts.js';
import { getSource } from '../store/sources.js';
import { getEdgesFrom, getEdgesTo } from '../store/edges.js';
import { shortestPath, neighborhood } from '../graph/engine.js';
import { toSlug } from '../utils/slug.js';
import type { LumenConfig, Concept, SearchResult, QueryIntent } from '../types/index.js';

type PathResult = {
    path: string[];
    hops: number;
};

type NeighborhoodResult = {
    center: string;
    node_count: number;
    nodes: string[];
};

export type RoutedSearchResult = {
    intent: QueryIntent;
    /** Set when intent resolved to an exact concept page. */
    concept?: Concept & {
        outgoing_edges: { to: string; relation: string; weight: number }[];
        incoming_edges: { from: string; relation: string; weight: number }[];
    };
    /** Set when intent resolved to a graph path. */
    path?: PathResult | null;
    /** Set when intent resolved to a neighborhood. */
    neighbors?: NeighborhoodResult;
    /** Set for hybrid_search intent — ranked chunks ready for LLM synthesis. */
    chunks?: { source_title: string; heading: string | null; content: string; score: number }[];
    found: boolean;
};

/**
 * Intent-aware search entry point.
 * Classifies the query, then routes to the fastest retrieval path:
 *   entity_lookup  → concept page (compiled_truth + edges)
 *   graph_path     → shortest-path BFS
 *   neighborhood   → N-hop neighborhood
 *   hybrid_search  → BM25 + TF-IDF + vector RRF pipeline
 *   temporal / originals → fall through to hybrid_search
 */
export async function routedSearch(
    query: string,
    config: LumenConfig,
    limit = 10,
    budget = 4000,
): Promise<RoutedSearchResult> {
    const intent = await classifyIntent(query, config);

    /** ── Entity lookup ── */
    if (intent === 'entity_lookup') {
        const raw = query
            .replace(/^(who|what) is\s+/i, '')
            .replace(/^(tell me about|explain|describe)\s+/i, '')
            .trim();
        const slug = toSlug(raw);
        const concept = getConcept(slug);
        if (concept) {
            const outEdges = getEdgesFrom(slug);
            const inEdges = getEdgesTo(slug);
            return {
                intent,
                found: true,
                concept: {
                    ...concept,
                    outgoing_edges: outEdges.map((e) => ({
                        to: e.to_slug,
                        relation: e.relation,
                        weight: e.weight,
                    })),
                    incoming_edges: inEdges.map((e) => ({
                        from: e.from_slug,
                        relation: e.relation,
                        weight: e.weight,
                    })),
                },
            };
        }
        /** Fall through to hybrid if no exact slug match. */
    }

    /** ── Graph path ── */
    if (intent === 'graph_path') {
        const [from, to] = extractPathSlugs(query);
        if (from && to) {
            const result = shortestPath(from, to);
            return {
                intent,
                found: !!result,
                path: result ? { path: result.path, hops: result.hops } : null,
            };
        }
        /** Fall through if we couldn't extract both slugs. */
    }

    /** ── Neighborhood ── */
    if (intent === 'neighborhood') {
        const raw = query.replace(/^(related to|neighbors of|connected to)\s+/i, '').trim();
        const slug = toSlug(raw);
        const nb = neighborhood(slug, 2);
        /** neighborhood() always seeds nodes with the center — real neighbors = size > 1. */
        const hasNeighbors = nb.nodes.size > 1;
        return {
            intent,
            found: hasNeighbors,
            neighbors: {
                center: slug,
                node_count: hasNeighbors ? nb.nodes.size - 1 : 0,
                nodes: [...nb.nodes].filter((n) => n !== slug),
            },
        };
    }

    /** ── Default: three-signal hybrid search ── */
    const [bm25Results, tfidfResults, vectorResults] = await Promise.all([
        Promise.resolve(searchBm25(query, limit * 2)),
        Promise.resolve(searchTfIdf(query, limit * 2)),
        searchVector(query, config, limit * 2),
    ]);

    const vectorEnabled = vectorResults.length > 0;
    const bm25w = vectorEnabled ? config.search.bm25_weight : 0.5;
    const tfidfW = vectorEnabled ? config.search.tfidf_weight : 0.5;

    const fused = fuseRrf(
        [
            {
                name: 'bm25',
                weight: bm25w,
                results: bm25Results.map((r) => ({
                    chunk_id: r.chunk_id,
                    source_id: r.source_id,
                    score: r.score,
                })),
            },
            {
                name: 'tfidf',
                weight: tfidfW,
                results: tfidfResults.map((r) => ({
                    chunk_id: r.chunk_id,
                    source_id: r.source_id,
                    score: r.score,
                })),
            },
            ...(vectorEnabled
                ? [
                      {
                          name: 'vector',
                          weight: config.search.vector_weight,
                          results: vectorResults.map((r) => ({
                              chunk_id: r.chunk_id,
                              source_id: r.source_id,
                              score: r.score,
                          })),
                      },
                  ]
                : []),
        ],
        60,
    );

    const selected = selectByBudget(
        fused.slice(0, limit).map((r) => ({
            chunk_id: r.chunk_id,
            source_id: r.source_id,
            score: r.rrf_score,
        })),
        budget,
    );

    const chunks = selected.map((c) => ({
        source_title: getSource(c.source_id)?.title ?? c.source_id,
        heading: null as string | null,
        content: c.content,
        score: c.score,
    }));

    return {
        intent: 'hybrid_search',
        found: chunks.length > 0,
        chunks,
    };
}

/** Extract from/to concept slugs for graph_path queries. */
function extractPathSlugs(query: string): [string | null, string | null] {
    /** "path from X to Y" or "path between X and Y" */
    const fromTo = query.match(/(?:path from|from)\s+(.+?)\s+to\s+(.+)/i);
    if (fromTo) return [toSlug(fromTo[1].trim()), toSlug(fromTo[2].trim())];

    const between = query.match(/(?:between|connect(?:s|ing)?)\s+(.+?)\s+and\s+(.+)/i);
    if (between) return [toSlug(between[1].trim()), toSlug(between[2].trim())];

    /** "how does X connect to Y" / "how does X relate to Y" */
    const howDoes = query.match(/how (?:does|do|is)\s+(.+?)\s+(?:connect|relate|link) to\s+(.+)/i);
    if (howDoes) return [toSlug(howDoes[1].trim()), toSlug(howDoes[2].trim())];

    return [null, null];
}

/** Re-export SearchResult for consumers of this module. */
export type { SearchResult };
