import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getDb } from '../store/database.js';
import { countSources, countSourcesByType, listSources } from '../store/sources.js';
import { countChunks, totalTokens } from '../store/chunks.js';
import { countConcepts, getConcept, listConcepts, getConceptSources } from '../store/concepts.js';
import { countEdges, getEdgesFrom, getEdgesTo } from '../store/edges.js';
import { searchBm25 } from '../search/bm25.js';
import { searchTfIdf } from '../search/tfidf.js';
import { fuseRrf } from '../search/fusion.js';
import { selectByBudget } from '../search/budget.js';
import { shortestPath, neighborhood, godNodes } from '../graph/engine.js';
import { pagerank } from '../graph/pagerank.js';
import { detectCommunities } from '../graph/cluster.js';
import { getSource } from '../store/sources.js';

export async function startMcpServer(): Promise<void> {
    getDb();

    const server = new McpServer({
        name: 'lumen',
        version: '0.1.0',
    });

    /** ─── Search ─── */

    server.tool(
        'search',
        'Hybrid BM25 + TF-IDF search across all ingested content. Returns ranked chunks with snippets.',
        {
            query: z.string().describe('Search query'),
            limit: z.number().optional().default(10).describe('Max results'),
            budget: z
                .number()
                .optional()
                .describe('Token budget — if set, returns chunks that fit within this token limit'),
        },
        async ({ query, limit, budget }) => {
            const bm25 = searchBm25(query, limit * 2);
            const tfidf = searchTfIdf(query, limit * 2);

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

            let items = fused.slice(0, limit);

            if (budget) {
                const selected = selectByBudget(
                    items.map((r) => ({
                        chunk_id: r.chunk_id,
                        source_id: r.source_id,
                        score: r.rrf_score,
                    })),
                    budget,
                );
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(
                                selected.map((c) => ({
                                    source: getSource(c.source_id)?.title ?? c.source_id,
                                    content: c.content,
                                    score: c.score,
                                    tokens: c.token_count,
                                })),
                                null,
                                2,
                            ),
                        },
                    ],
                };
            }

            const db = getDb();
            const results = items.map((r) => {
                const chunk = db
                    .prepare('SELECT content, heading FROM chunks WHERE id = ?')
                    .get(r.chunk_id) as { content: string; heading: string | null } | undefined;
                const source = db
                    .prepare('SELECT title FROM sources WHERE id = ?')
                    .get(r.source_id) as { title: string } | undefined;
                return {
                    source: source?.title ?? r.source_id,
                    heading: chunk?.heading ?? null,
                    content: chunk?.content?.slice(0, 500) ?? '',
                    score: r.rrf_score,
                };
            });

            return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
        },
    );

    /** ─── Status ─── */

    server.tool('status', 'Show knowledge base statistics.', {}, async () => {
        const stats = {
            sources: countSources(),
            chunks: countChunks(),
            tokens: totalTokens(),
            concepts: countConcepts(),
            edges: countEdges(),
            sources_by_type: countSourcesByType(),
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(stats, null, 2) }] };
    });

    /** ─── God Nodes ─── */

    server.tool(
        'god_nodes',
        'Return the most connected concepts in the knowledge graph (god nodes).',
        {
            limit: z.number().optional().default(10).describe('Number of top concepts'),
        },
        async ({ limit }) => {
            const gods = godNodes(limit);
            const results = gods.map((g) => ({
                slug: g.slug,
                name: g.name,
                edges: g.edgeCount,
                sources: getConceptSources(g.slug).length,
            }));
            return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
        },
    );

    /** ─── Concept Detail ─── */

    server.tool(
        'concept',
        'Get details about a specific concept including its edges and sources.',
        {
            slug: z.string().describe('Concept slug'),
        },
        async ({ slug }) => {
            const concept = getConcept(slug);
            if (!concept) {
                return {
                    content: [{ type: 'text' as const, text: `Concept "${slug}" not found.` }],
                };
            }

            const outEdges = getEdgesFrom(slug);
            const inEdges = getEdgesTo(slug);
            const sources = getConceptSources(slug).map((id) => getSource(id)?.title ?? id);

            const result = {
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
                sources,
            };
            return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        },
    );

    /** ─── Shortest Path ─── */

    server.tool(
        'path',
        'Find the shortest path between two concepts in the knowledge graph.',
        {
            from: z.string().describe('Source concept slug'),
            to: z.string().describe('Target concept slug'),
        },
        async ({ from, to }) => {
            const result = shortestPath(from, to);
            if (!result) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `No path found between "${from}" and "${to}".`,
                        },
                    ],
                };
            }

            const pathNames = result.path.map((slug) => ({
                slug,
                name: getConcept(slug)?.name ?? slug,
            }));

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(
                            { hops: result.hops, path: pathNames, edges: result.edges },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    /** ─── Neighbors ─── */

    server.tool(
        'neighbors',
        'Get all concepts within N hops of a given concept.',
        {
            slug: z.string().describe('Center concept slug'),
            depth: z.number().optional().default(2).describe('Hop depth'),
        },
        async ({ slug, depth }) => {
            const result = neighborhood(slug, depth);
            const nodes = [...result.nodes].map((s) => ({
                slug: s,
                name: getConcept(s)?.name ?? s,
            }));
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify({ center: slug, depth, nodes }, null, 2),
                    },
                ],
            };
        },
    );

    /** ─── PageRank ─── */

    server.tool(
        'pagerank',
        'Return concepts ranked by PageRank importance.',
        {
            limit: z.number().optional().default(15).describe('Number of results'),
        },
        async ({ limit }) => {
            const results = pagerank().slice(0, limit);
            return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
        },
    );

    /** ─── Communities ─── */

    server.tool(
        'communities',
        'List detected concept communities (topic clusters).',
        {},
        async () => {
            const communities = detectCommunities();
            const results = communities.map((c) => ({
                id: c.id,
                size: c.size,
                members: c.members.map((s) => getConcept(s)?.name ?? s),
            }));
            return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
        },
    );

    /** ─── Start server ─── */

    const transport = new StdioServerTransport();
    await server.connect(transport);
}
