import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getDb } from '../store/database.js';
import { countSources, countSourcesByType, getSource } from '../store/sources.js';
import { insertSource } from '../store/sources.js';
import { countChunks, totalTokens, insertChunks } from '../store/chunks.js';
import {
    countConcepts,
    getConcept,
    getActiveConcept,
    getConceptSources,
    upsertConcept,
    appendTimeline,
    retireConcept,
} from '../store/concepts.js';
import { recordFeedback } from '../store/feedback.js';
import { countEdges, getEdgesFrom, getEdgesTo } from '../store/edges.js';
import { addLink, addBackLink, getBackLinks, getLinksFrom, countLinks } from '../store/links.js';
import { routedSearch } from '../search/index.js';
import { searchBm25 } from '../search/bm25.js';
import { searchTfIdf } from '../search/tfidf.js';
import { searchVector } from '../search/vector.js';
import { fuseRrf } from '../search/fusion.js';
import { selectByBudget } from '../search/budget.js';
import { shortestPath, neighborhood, godNodes } from '../graph/engine.js';
import { pagerank } from '../graph/pagerank.js';
import { detectCommunities } from '../graph/cluster.js';
import { chat } from '../llm/client.js';
import { QA_SYSTEM, qaUserPrompt } from '../llm/prompts/qa.js';
import { toSlug } from '../utils/slug.js';
import { invalidateProfile } from '../profile/invalidate.js';
import { loadConfig } from '../utils/config.js';
import { ingestInput } from '../ingest/file.js';
import { sourceExists } from '../store/dedup.js';
import { shortId, contentHash } from '../utils/hash.js';
import { chunk } from '../chunker/index.js';
import { logQuery } from '../store/query-log.js';
import { scrubPii } from '../pii/index.js';

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
        'Hybrid BM25 + TF-IDF + vector search across all ingested content. Returns ranked chunks with snippets.',
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
            const config = loadConfig();

            const [bm25, tfidf, vec] = await Promise.all([
                Promise.resolve(searchBm25(query, limit * 2)),
                Promise.resolve(searchTfIdf(query, limit * 2)),
                searchVector(query, config, limit * 2),
            ]);

            const vectorEnabled = vec.length > 0;
            const bm25w = vectorEnabled ? config.search.bm25_weight : 0.5;
            const tfidfW = vectorEnabled ? config.search.tfidf_weight : 0.5;

            const fused = fuseRrf(
                [
                    {
                        name: 'bm25',
                        weight: bm25w,
                        results: bm25.map((r) => ({
                            chunk_id: r.chunk_id,
                            source_id: r.source_id,
                            score: r.score,
                        })),
                    },
                    {
                        name: 'tfidf',
                        weight: tfidfW,
                        results: tfidf.map((r) => ({
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
                                  results: vec.map((r) => ({
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
            links: countLinks(),
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
        'Get full details about a concept: compiled_truth (best current understanding), timeline (immutable evidence trail), edges, and sources.',
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
                slug: concept.slug,
                name: concept.name,
                /** Mutable best-current-understanding, rewritten as new evidence accumulates. */
                compiled_truth: concept.compiled_truth ?? concept.summary ?? null,
                /** Immutable evidence trail — one entry per source that mentioned this concept. */
                timeline: concept.timeline,
                mention_count: concept.mention_count,
                article: concept.article ?? null,
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
        'Ask a question and get a synthesized answer. Uses intent routing: entity/path/neighborhood queries return structured results directly; everything else runs full three-signal hybrid search + LLM synthesis.',
        {
            question: z.string().describe('The question to answer'),
            limit: z.number().optional().default(10).describe('Max chunks to retrieve'),
            budget: z.number().optional().default(4000).describe('Token budget for context'),
        },
        async ({ question, limit, budget }) => {
            const start = Date.now();
            const config = loadConfig();

            const routed = await routedSearch(question, config, limit, budget);

            /** ── Structured routes — return directly without LLM synthesis ── */
            if (routed.intent === 'entity_lookup' && routed.concept) {
                logQuery({
                    tool_name: 'query',
                    query_text: question,
                    result_count: 1,
                    latency_ms: Date.now() - start,
                    session_id: sessionId,
                });
                return {
                    content: [
                        { type: 'text' as const, text: JSON.stringify(routed.concept, null, 2) },
                    ],
                };
            }

            if (routed.intent === 'graph_path') {
                logQuery({
                    tool_name: 'query',
                    query_text: question,
                    result_count: routed.found ? 1 : 0,
                    latency_ms: Date.now() - start,
                    session_id: sessionId,
                });
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(
                                { intent: 'graph_path', found: routed.found, path: routed.path },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            }

            if (routed.intent === 'neighborhood' && routed.neighbors) {
                logQuery({
                    tool_name: 'query',
                    query_text: question,
                    result_count: routed.neighbors.node_count,
                    latency_ms: Date.now() - start,
                    session_id: sessionId,
                });
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(routed.neighbors, null, 2),
                        },
                    ],
                };
            }

            /** ── Hybrid search — synthesize with LLM ── */
            const chunks = routed.chunks ?? [];

            if (chunks.length === 0) {
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

            const answer = await chat(
                config,
                [{ role: 'user', content: qaUserPrompt(question, chunks) }],
                { system: QA_SYSTEM, maxTokens: 2048 },
            );

            logQuery({
                tool_name: 'query',
                query_text: question,
                result_count: chunks.length,
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
                    compiled_truth: concept?.compiled_truth ?? concept?.summary ?? null,
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

    /** ─── Link Management ─── */

    server.tool(
        'add_link',
        'Create a manual directional link between two concepts. Automatically creates the reverse back-link too.',
        {
            from_slug: z.string().describe('Source concept slug'),
            to_slug: z.string().describe('Target concept slug'),
            context: z
                .string()
                .optional()
                .describe('The passage or reason for this link (up to 200 chars)'),
        },
        async ({ from_slug, to_slug, context }) => {
            addLink(from_slug, to_slug, 'manual', context ?? null, null);
            addLink(to_slug, from_slug, 'back-link', context ?? null, null);
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(
                            { linked: true, from: from_slug, to: to_slug },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.tool(
        'backlinks',
        'Get all concepts that reference or link to a given concept — the back-link index.',
        {
            slug: z.string().describe('Concept slug to find back-links for'),
        },
        async ({ slug }) => {
            const links = getBackLinks(slug);
            const result = {
                slug,
                backlink_count: links.length,
                links: links.map((l) => ({
                    from: l.from_slug,
                    type: l.link_type,
                    context: l.context,
                    added: l.created_at,
                })),
            };
            return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        },
    );

    server.tool(
        'links',
        'Get all outgoing links from a concept, optionally filtered by link type.',
        {
            slug: z.string().describe('Concept slug'),
            type: z
                .enum(['reference', 'back-link', 'manual', 'co-occurs'])
                .optional()
                .describe('Filter by link type (omit to return all)'),
        },
        async ({ slug, type }) => {
            const links = getLinksFrom(slug, type as Parameters<typeof getLinksFrom>[1]);
            const result = links.map((l) => ({
                to: l.to_slug,
                type: l.link_type,
                context: l.context,
                source_id: l.source_id,
                added: l.created_at,
            }));
            return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
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

    /** ─── Compile ─── */

    server.tool(
        'compile',
        `Compile unprocessed sources into concepts and edges via LLM.
Call this after ingesting new sources with "add" to extract knowledge graph nodes.
Without compilation, ingested content is searchable but won't appear in the concept graph.`,
        {
            all: z
                .boolean()
                .optional()
                .describe('Recompile all sources, not just unprocessed (default: false)'),
        },
        async ({ all }) => {
            try {
                const { compile } = await import('../lib/compile.js');
                const result = await compile({
                    all: all ?? false,
                    writeReport: true,
                    concurrency: 3,
                });
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify({
                                sources_compiled: result.sources_compiled,
                                sources_failed: result.sources_failed,
                                concepts_created: result.concepts_created,
                                concepts_updated: result.concepts_updated,
                                edges_created: result.edges_created,
                                tokens_used: result.tokens_used,
                            }),
                        },
                    ],
                };
            } catch (err) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Compilation failed: ${err instanceof Error ? err.message : String(err)}`,
                        },
                    ],
                    isError: true,
                };
            }
        },
    );

    /** ─── Profile ─── */

    server.tool(
        'profile',
        'Fast cached snapshot of your knowledge base — top concepts, recent activity, learned preferences. No args needed.',
        {},
        async () => {
            const start = Date.now();
            const { getProfile } = await import('../profile/cache.js');
            const profile = getProfile();
            logQuery({
                tool_name: 'profile',
                query_text: null,
                result_count: null,
                latency_ms: Date.now() - start,
                session_id: sessionId,
            });
            return { content: [{ type: 'text' as const, text: JSON.stringify(profile, null, 2) }] };
        },
    );

    /** ─── Signal Capture (Phase 5) ─── */

    server.tool(
        'capture',
        `Capture an idea, observation, fact, or entity mention into the knowledge base.
Call this whenever the user expresses original thinking or when you encounter
a notable fact about a concept. The brain grows automatically.`,
        {
            type: z
                .enum(['idea', 'observation', 'fact', 'entity_mention'])
                .describe('What kind of signal this is'),
            title: z
                .string()
                .describe('Short name for this knowledge unit (becomes the concept slug)'),
            content: z.string().describe('The exact phrasing to preserve — do not paraphrase'),
            related_slugs: z
                .array(z.string())
                .optional()
                .describe('Concept slugs this capture relates to — will be linked'),
            source_context: z
                .string()
                .optional()
                .describe(
                    'Brief context: where this came from (e.g. "user said during search session")',
                ),
        },
        async ({ type, title, content, related_slugs, source_context }) => {
            const titleScrub = scrubPii(title, { strict: true });
            if (!titleScrub.ok) {
                return {
                    content: [{ type: 'text' as const, text: titleScrub.reason }],
                    isError: true,
                };
            }
            const contentScrub = scrubPii(content);
            if (!contentScrub.ok) {
                return {
                    content: [{ type: 'text' as const, text: contentScrub.reason }],
                    isError: true,
                };
            }
            const contextScrub = scrubPii(source_context ?? '');
            if (!contextScrub.ok) {
                return {
                    content: [{ type: 'text' as const, text: contextScrub.reason }],
                    isError: true,
                };
            }

            const cleanTitle = titleScrub.content;
            const cleanContent = contentScrub.content;
            const cleanContext = source_context !== undefined ? contextScrub.content : undefined;
            const totalRedactions =
                titleScrub.redactions + contentScrub.redactions + contextScrub.redactions;

            const slug = toSlug(cleanTitle);
            const now = new Date().toISOString();

            upsertConcept({
                slug,
                name: cleanTitle,
                summary: cleanContent,
                compiled_truth: cleanContent,
                article: null,
                created_at: now,
                updated_at: now,
                mention_count: 1,
            });

            appendTimeline(slug, {
                date: now.slice(0, 10),
                source_id: null,
                source_title: cleanContext ?? `Captured via MCP (${type})`,
                event: `${type}: ${cleanContent.slice(0, 120)}`,
                detail: cleanContent,
            });

            for (const related of related_slugs ?? []) {
                if (getConcept(related)) {
                    addBackLink(slug, related, cleanContent.slice(0, 200), null);
                }
            }

            invalidateProfile();

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(
                            {
                                captured: true,
                                slug,
                                type,
                                linked_to: related_slugs ?? [],
                                redactions: totalRedactions,
                                redacted_patterns: {
                                    ...titleScrub.by_pattern,
                                    ...contentScrub.by_pattern,
                                    ...contextScrub.by_pattern,
                                },
                            },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.tool(
        'session_summary',
        'Store a summary of what was discussed in this session as timeline entries on touched concepts.',
        {
            summary: z.string().describe('What was discussed and what was learned'),
            concepts_touched: z
                .array(z.string())
                .optional()
                .describe('Concept slugs that came up in the session'),
        },
        async ({ summary, concepts_touched }) => {
            const summaryScrub = scrubPii(summary);
            if (!summaryScrub.ok) {
                return {
                    content: [{ type: 'text' as const, text: summaryScrub.reason }],
                    isError: true,
                };
            }
            const cleanSummary = summaryScrub.content;
            const today = new Date().toISOString().slice(0, 10);
            let updated = 0;

            for (const slug of concepts_touched ?? []) {
                if (getConcept(slug)) {
                    appendTimeline(slug, {
                        date: today,
                        source_id: null,
                        source_title: `MCP session ${today}`,
                        event: `Appeared in session: ${cleanSummary.slice(0, 100)}`,
                        detail: cleanSummary,
                    });
                    updated++;
                }
            }

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(
                            {
                                stored: true,
                                concepts_updated: updated,
                                redactions: summaryScrub.redactions,
                                redacted_patterns: summaryScrub.by_pattern,
                            },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    /** ─── Skill scoring (Tier 2a) ─── */

    server.tool(
        'brain_feedback',
        `Record a +1 or -1 vote on a concept (skill) with an optional reason.
+1 reinforces the skill. -1 with a reason captures why the skill was wrong
or unhelpful — the reason is load-bearing because it lets a future review
pass edit the skill instead of just retiring it.
Cumulative score <= -3 auto-retires the concept; the most recent negative
reason becomes the retirement reason.`,
        {
            slug: z.string().describe('Concept slug to vote on'),
            delta: z
                .union([z.literal(1), z.literal(-1), z.literal('+1'), z.literal('-1')])
                .describe('Vote direction'),
            reason: z.string().optional().describe('Why - load-bearing for downvotes'),
        },
        async ({ slug, delta, reason }) => {
            const numericDelta: -1 | 1 = delta === 1 || delta === '+1' ? 1 : -1;
            const concept = getConcept(slug);
            if (!concept) {
                return {
                    content: [{ type: 'text' as const, text: `Concept "${slug}" not found.` }],
                    isError: true,
                };
            }
            const result = recordFeedback({
                slug,
                delta: numericDelta,
                reason: reason ?? null,
                session_id: sessionId,
            });
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(
                            {
                                slug,
                                delta: numericDelta,
                                new_score: result.new_score,
                                retired: result.retired,
                                feedback_id: result.feedback_id,
                            },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.tool(
        'retire_skill',
        `Explicitly retire a concept with a reason. Soft delete - the row and
its timeline / feedback history remain queryable, but the concept is
hidden from skill-substrate retrieval (brain_ops, search, ask).
Idempotent: re-retiring keeps the original retired_at and reason.`,
        {
            slug: z.string().describe('Concept slug to retire'),
            reason: z.string().describe('Why this skill is being retired'),
        },
        async ({ slug, reason }) => {
            const concept = getConcept(slug);
            if (!concept) {
                return {
                    content: [{ type: 'text' as const, text: `Concept "${slug}" not found.` }],
                    isError: true,
                };
            }
            retireConcept(slug, reason);
            const updated = getConcept(slug);
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(
                            {
                                slug,
                                retired_at: updated?.retired_at,
                                retire_reason: updated?.retire_reason,
                                already_retired: concept.retired_at !== null,
                            },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    /** ─── Brain Ops — single agent entry point (Phase 8) ─── */

    server.tool(
        'brain_ops',
        `Brain-first lookup. Call this BEFORE answering any substantive question.
Checks memory, routes by intent, returns context in one call.
Agents should call this automatically — it is the entry point to the brain.`,
        {
            query: z.string().describe('The question or topic to check the brain for'),
            intent: z
                .enum(['search', 'concept', 'path', 'neighborhood'])
                .optional()
                .describe('Routing hint. Omit to auto-detect from query shape.'),
            from: z.string().optional().describe('For path intent: starting concept slug'),
            to: z.string().optional().describe('For path intent: ending concept slug'),
        },
        async ({ query, intent, from, to }) => {
            const config = loadConfig();
            const db = getDb();
            const start = Date.now();

            const resolvedIntent = intent ?? autoDetectBrainIntent(query);

            /** ── Concept lookup ── */
            if (resolvedIntent === 'concept') {
                const raw = query
                    .replace(/^(who|what) is\s+/i, '')
                    .replace(/^(tell me about|explain|describe)\s+/i, '')
                    .trim();
                const slug = toSlug(raw);
                /** Skip retired concepts in skill-substrate retrieval. */
                const concept = getActiveConcept(slug);
                if (concept) {
                    logQuery({
                        tool_name: 'brain_ops',
                        query_text: query,
                        result_count: 1,
                        latency_ms: Date.now() - start,
                        session_id: sessionId,
                    });
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: JSON.stringify(
                                    {
                                        found: true,
                                        intent: 'concept',
                                        slug: concept.slug,
                                        name: concept.name,
                                        compiled_truth: concept.compiled_truth ?? concept.summary,
                                        mention_count: concept.mention_count,
                                        score: concept.score,
                                        outgoing_edges: getEdgesFrom(slug).slice(0, 8),
                                        incoming_edges: getEdgesTo(slug).slice(0, 8),
                                    },
                                    null,
                                    2,
                                ),
                            },
                        ],
                    };
                }
                /** Fall through to hybrid search if no exact (active) concept match. */
            }

            /** ── Graph path ── */
            if (resolvedIntent === 'path' && from && to) {
                const pathResult = shortestPath(from, to);
                logQuery({
                    tool_name: 'brain_ops',
                    query_text: query,
                    result_count: pathResult ? 1 : 0,
                    latency_ms: Date.now() - start,
                    session_id: sessionId,
                });
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(
                                { found: !!pathResult, intent: 'path', path: pathResult },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            }

            /** ── Neighborhood ── */
            if (resolvedIntent === 'neighborhood') {
                const raw = query.replace(/^(related to|neighbors of|connected to)\s+/i, '').trim();
                const slug = toSlug(raw);
                const nb = neighborhood(slug, 2);
                logQuery({
                    tool_name: 'brain_ops',
                    query_text: query,
                    result_count: nb.nodes.size,
                    latency_ms: Date.now() - start,
                    session_id: sessionId,
                });
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(
                                {
                                    found: nb.nodes.size > 1,
                                    intent: 'neighborhood',
                                    center: slug,
                                    node_count: nb.nodes.size > 1 ? nb.nodes.size - 1 : 0,
                                    nodes: [...nb.nodes].filter((n) => n !== slug),
                                    edges: nb.edges.slice(0, 20),
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            }

            /** ── Default: BM25 + TF-IDF hybrid search ── */
            const bm25 = searchBm25(query, 10);
            const tfidf = searchTfIdf(query, 10);
            const [vec] = await Promise.all([searchVector(query, config, 10)]);

            const vectorEnabled = vec.length > 0;
            const bm25w = vectorEnabled ? config.search.bm25_weight : 0.5;
            const tfidfW = vectorEnabled ? config.search.tfidf_weight : 0.5;

            const fused = fuseRrf(
                [
                    {
                        name: 'bm25',
                        weight: bm25w,
                        results: bm25.map((r) => ({
                            chunk_id: r.chunk_id,
                            source_id: r.source_id,
                            score: r.score,
                        })),
                    },
                    {
                        name: 'tfidf',
                        weight: tfidfW,
                        results: tfidf.map((r) => ({
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
                                  results: vec.map((r) => ({
                                      chunk_id: r.chunk_id,
                                      source_id: r.source_id,
                                      score: r.score,
                                  })),
                              },
                          ]
                        : []),
                ],
                60,
            ).slice(0, 5);

            const results = fused.map((r) => {
                const chunkRow = db
                    .prepare('SELECT content, heading FROM chunks WHERE id = ?')
                    .get(r.chunk_id) as { content: string; heading: string | null } | undefined;
                return {
                    chunk_id: r.chunk_id,
                    source_id: r.source_id,
                    source: getSource(r.source_id)?.title ?? r.source_id,
                    heading: chunkRow?.heading ?? null,
                    content: chunkRow?.content?.slice(0, 400) ?? '',
                    score: r.rrf_score,
                };
            });

            logQuery({
                tool_name: 'brain_ops',
                query_text: query,
                result_count: results.length,
                latency_ms: Date.now() - start,
                session_id: sessionId,
            });

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(
                            {
                                found: results.length > 0,
                                intent: 'hybrid_search',
                                result_count: results.length,
                                results,
                            },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    /** ─── Start server ─── */

    const transport = new StdioServerTransport();
    await server.connect(transport);
}

/** Deterministic intent detection for brain_ops — no LLM call needed. */
function autoDetectBrainIntent(query: string): 'concept' | 'path' | 'neighborhood' | 'search' {
    if (/^(who|what) is\s/i.test(query)) return 'concept';
    if (/^(tell me about|explain|describe)\s/i.test(query)) return 'concept';
    if (/path (from|between)|how.*(connect|relate|link)/i.test(query)) return 'path';
    if (/(related to|neighbors of|connected to)\s/i.test(query)) return 'neighborhood';
    return 'search';
}
