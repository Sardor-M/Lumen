import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getDb } from '../store/database.js';
import { countSources, countSourcesByType, getSource } from '../store/sources.js';
import { insertSource } from '../store/sources.js';
import { countChunks, totalTokens, insertChunks } from '../store/chunks.js';
import { countConcepts, getConcept, getConceptSources } from '../store/concepts.js';
import { countEdges, getEdgesFrom, getEdgesTo } from '../store/edges.js';
import { searchBm25 } from '../search/bm25.js';
import { searchTfIdf } from '../search/tfidf.js';
import { fuseRrf } from '../search/fusion.js';
import { selectByBudget } from '../search/budget.js';
import { shortestPath, neighborhood, godNodes } from '../graph/engine.js';
import { pagerank } from '../graph/pagerank.js';
import { detectCommunities } from '../graph/cluster.js';
import { chat } from '../llm/client.js';
import { QA_SYSTEM, qaUserPrompt } from '../llm/prompts/qa.js';
import { loadConfig } from '../utils/config.js';
import { ingestInput } from '../ingest/file.js';
import { sourceExists } from '../store/dedup.js';
import { shortId, contentHash } from '../utils/hash.js';
import { chunk } from '../chunker/index.js';
import { logQuery } from '../store/query-log.js';

export async function startMcpServer(): Promise<void> {
    getDb();

    const sessionId = `mcp-${Date.now()}`;

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
            const start = Date.now();
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
                logQuery({
                    tool_name: 'search',
                    query_text: query,
                    result_count: selected.length,
                    latency_ms: Date.now() - start,
                    session_id: sessionId,
                });
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

            logQuery({
                tool_name: 'search',
                query_text: query,
                result_count: results.length,
                latency_ms: Date.now() - start,
                session_id: sessionId,
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

    /** ─── Query (Q&A) ─── */

    server.tool(
        'query',
        'Ask a question and get a synthesized answer from the knowledge base using search + LLM.',
        {
            question: z.string().describe('The question to answer'),
            limit: z.number().optional().default(10).describe('Max chunks to retrieve'),
            budget: z.number().optional().default(4000).describe('Token budget for context'),
        },
        async ({ question, limit, budget }) => {
            const start = Date.now();
            const config = loadConfig();

            const bm25 = searchBm25(question, limit * 2);
            const tfidf = searchTfIdf(question, limit * 2);

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

            const selected = selectByBudget(
                fused.slice(0, limit).map((r) => ({
                    chunk_id: r.chunk_id,
                    source_id: r.source_id,
                    score: r.rrf_score,
                })),
                budget,
            );

            if (selected.length === 0) {
                logQuery({
                    tool_name: 'query',
                    query_text: question,
                    result_count: 0,
                    latency_ms: Date.now() - start,
                    session_id: sessionId,
                });
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: 'No relevant content found in the knowledge base.',
                        },
                    ],
                };
            }

            const chunks = selected.map((c) => ({
                source_title: getSource(c.source_id)?.title ?? c.source_id,
                heading: null as string | null,
                content: c.content,
                score: c.score,
            }));

            const answer = await chat(
                config,
                [{ role: 'user', content: qaUserPrompt(question, chunks) }],
                { system: QA_SYSTEM, maxTokens: 2048 },
            );

            logQuery({
                tool_name: 'query',
                query_text: question,
                result_count: selected.length,
                latency_ms: Date.now() - start,
                session_id: sessionId,
            });
            return { content: [{ type: 'text' as const, text: answer }] };
        },
    );

    /** ─── Community Detail ─── */

    server.tool(
        'community',
        'Get concepts in a specific community by its ID.',
        {
            id: z.number().describe('Community ID (from the communities tool)'),
        },
        async ({ id }) => {
            const communities = detectCommunities();
            const community = communities.find((c) => c.id === id);

            if (!community) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Community ${id} not found. Use the "communities" tool to list available IDs.`,
                        },
                    ],
                };
            }

            const members = community.members.map((slug) => {
                const concept = getConcept(slug);
                return {
                    slug,
                    name: concept?.name ?? slug,
                    summary: concept?.summary ?? null,
                    mention_count: concept?.mention_count ?? 0,
                };
            });

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify({ id, size: community.size, members }, null, 2),
                    },
                ],
            };
        },
    );

    /** ─── Add Source ─── */

    server.tool(
        'add',
        'Ingest a new source into the knowledge base. Accepts URLs, file paths, arXiv IDs, or YouTube links.',
        {
            input: z.string().describe('URL, file path, arXiv ID, or YouTube link to ingest'),
        },
        async ({ input }) => {
            const config = loadConfig();
            const db = getDb();

            try {
                const result = await ingestInput(input);

                const existingId = sourceExists(db, result.content);
                if (existingId) {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: `Skipped (duplicate): "${result.title}" already exists.`,
                            },
                        ],
                    };
                }

                const id = shortId(result.content);
                const hash = contentHash(result.content);
                const wordCount = result.content.split(/\s+/).length;

                insertSource({
                    id,
                    title: result.title,
                    url: result.url,
                    content: result.content,
                    content_hash: hash,
                    source_type: result.source_type,
                    added_at: new Date().toISOString(),
                    compiled_at: null,
                    word_count: wordCount,
                    language: result.language,
                    metadata: result.metadata ? JSON.stringify(result.metadata) : null,
                });

                const chunks = chunk(result.content, id, {
                    minTokens: config.chunker.min_chunk_tokens,
                    maxTokens: config.chunker.max_chunk_tokens,
                });
                insertChunks(chunks);

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Added "${result.title}" (${chunks.length} chunks, ${wordCount} words)`,
                        },
                    ],
                };
            } catch (err) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Failed to ingest: ${err instanceof Error ? err.message : String(err)}`,
                        },
                    ],
                    isError: true,
                };
            }
        },
    );

    /** ─── Start server ─── */

    const transport = new StdioServerTransport();
    await server.connect(transport);
}
