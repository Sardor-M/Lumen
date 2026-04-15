/**
 * Provider-agnostic tool definitions for LLM function-calling APIs.
 *
 * Each definition follows the JSON-Schema-inside-a-name/description shape
 * that OpenAI, Anthropic, Google, and most aggregators converge on. Adapters
 * (Phase 6.3) wrap these into the exact envelope their host SDK expects.
 *
 *     import { createLumen } from '@lumen/cli';
 *     import { toolDefinitions, handleToolCall } from '@lumen/cli/tools';
 *
 *     const lumen = createLumen({ dataDir: '~/.lumen' });
 *     const tools = toolDefinitions; // pass to openai.chat.completions.create({ tools })
 *     const out = await handleToolCall(lumen, { name: 'search', arguments: { query: 'x' } });
 *
 * Design:
 * - Names match `Lumen` methods exactly (`add`, `search`, `ask`, …) so the
 *   mapping stays obvious. MCP may use different tool names internally —
 *   that's its own namespace.
 * - Parameters are hand-authored JSON Schema: no runtime Zod dependency for
 *   library consumers, and the shapes are stable enough to maintain by hand.
 * - `handleToolCall` swallows no errors: it lets `LumenError`, `IngestError`,
 *   and any other throw propagate. The adapter decides retry / formatting.
 */

import type { Lumen } from './index.js';
import { LumenError } from './lib/errors.js';

export type JsonSchema = {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
};

export type ToolDefinition = {
    name: string;
    description: string;
    parameters: JsonSchema;
};

export type ToolCall = {
    name: string;
    arguments: Record<string, unknown>;
};

const RAW_TOOL_DEFINITIONS: ToolDefinition[] = [
    {
        name: 'add',
        description:
            'Ingest a URL, file path, arXiv ID, or YouTube link into the knowledge base. Returns status=added with chunk/word counts, or status=skipped when the content is already stored.',
        parameters: {
            type: 'object',
            properties: {
                input: {
                    type: 'string',
                    description: 'The URL, local path, arXiv ID, or YouTube link to ingest',
                    minLength: 1,
                },
            },
            required: ['input'],
            additionalProperties: false,
        },
    },

    {
        name: 'search',
        description:
            'Hybrid BM25 + TF-IDF search with RRF fusion over all ingested chunks. Returns ranked chunks with source titles and content. No LLM call.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Free-text search query',
                    minLength: 1,
                },
                limit: {
                    type: 'integer',
                    description: 'Maximum number of results to return',
                    minimum: 1,
                    maximum: 100,
                    default: 10,
                },
                mode: {
                    type: 'string',
                    enum: ['hybrid', 'bm25', 'tfidf'],
                    description: 'Retrieval strategy. Default "hybrid" (BM25 + TF-IDF fused).',
                    default: 'hybrid',
                },
            },
            required: ['query'],
            additionalProperties: false,
        },
    },

    {
        name: 'ask',
        description:
            'Retrieval-augmented Q&A. Searches the knowledge base, budgets context, and synthesizes a citable answer via the configured LLM. Returns `{ answer, verdict, found, citations[], sources[] }` — `answer` contains inline `[N]` markers tied to entries in `citations`; `verdict` is one of `answered | partial | uncertain | no_evidence`. Use `verdict === "no_evidence"` or `found === false` to detect when the knowledge base lacks relevant content. Requires an API key.',
        parameters: {
            type: 'object',
            properties: {
                question: {
                    type: 'string',
                    description: 'Question to answer from the knowledge base',
                    minLength: 1,
                },
                limit: {
                    type: 'integer',
                    description: 'Max chunks considered from fused retrieval',
                    minimum: 1,
                    maximum: 50,
                    default: 10,
                },
                budget: {
                    type: 'integer',
                    description: 'Token budget for retrieved context',
                    minimum: 256,
                    maximum: 100000,
                },
            },
            required: ['question'],
            additionalProperties: false,
        },
    },

    {
        name: 'status',
        description:
            'Return counts (sources, chunks, concepts, edges, connectors), database size on disk, and graph density. No args.',
        parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
    },

    {
        name: 'profile',
        description:
            'Fast cached snapshot — top concepts (god nodes, PageRank), top communities, recent sources, learned preferences. Ideal for system-prompt injection.',
        parameters: {
            type: 'object',
            properties: {
                refresh: {
                    type: 'boolean',
                    description: 'Force a rebuild of the cached profile',
                    default: false,
                },
            },
            additionalProperties: false,
        },
    },

    {
        name: 'god_nodes',
        description: 'Top concepts by edge count — the most connected hubs in the knowledge graph.',
        parameters: {
            type: 'object',
            properties: {
                limit: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 100,
                    default: 10,
                },
            },
            additionalProperties: false,
        },
    },

    {
        name: 'pagerank',
        description:
            'Top concepts ranked by PageRank importance (iterative power method, damping=0.85). Use `limit` to cap the number of results returned.',
        parameters: {
            type: 'object',
            properties: {
                limit: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 500,
                    default: 15,
                },
            },
            additionalProperties: false,
        },
    },

    {
        name: 'neighbors',
        description: 'Return all concepts within N hops of a given concept in the graph.',
        parameters: {
            type: 'object',
            properties: {
                slug: {
                    type: 'string',
                    description: 'Center concept slug',
                    minLength: 1,
                },
                depth: {
                    type: 'integer',
                    description: 'Max hop depth',
                    minimum: 1,
                    maximum: 6,
                    default: 2,
                },
            },
            required: ['slug'],
            additionalProperties: false,
        },
    },

    {
        name: 'path',
        description:
            'Breadth-first shortest path between two concepts in the knowledge graph. Returns null if no path exists within maxDepth.',
        parameters: {
            type: 'object',
            properties: {
                from: { type: 'string', description: 'Source concept slug', minLength: 1 },
                to: { type: 'string', description: 'Target concept slug', minLength: 1 },
                maxDepth: {
                    type: 'integer',
                    description: 'BFS depth limit',
                    minimum: 1,
                    maximum: 10,
                    default: 6,
                },
            },
            required: ['from', 'to'],
            additionalProperties: false,
        },
    },

    {
        name: 'communities',
        description:
            'Detect concept communities via label propagation. Each community is a cluster of tightly-connected concepts.',
        parameters: {
            type: 'object',
            properties: {
                maxIterations: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 200,
                    default: 50,
                },
            },
            additionalProperties: false,
        },
    },
];

/**
 * Recursively freeze so consumers can't mutate the schemas at runtime.
 * A single `Object.freeze(array)` only seals the outer array, leaving
 * inner `parameters.properties` maps writable — the test for
 * `Object.isFrozen(toolDefinitions)` would pass while mutations still
 * leak. Deep freeze matches the frozen-contract this array advertises.
 */
function deepFreeze<T>(value: T): T {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
        deepFreeze((value as Record<string, unknown>)[key]);
    }
    return value;
}

export const toolDefinitions: readonly ToolDefinition[] = deepFreeze(RAW_TOOL_DEFINITIONS);

/**
 * Dispatch a tool call against a Lumen instance. The arguments are trusted
 * to match the tool's schema — adapters / LLM runtimes validate before
 * calling. Returns whatever the underlying Lumen method returns; throws on
 * unknown tool name or invalid argument types.
 */
export async function handleToolCall(lumen: Lumen, call: ToolCall): Promise<unknown> {
    const args = call.arguments ?? {};

    switch (call.name) {
        case 'add':
            return lumen.add({ input: requireString(args.input, 'add', 'input') });

        case 'search':
            return lumen.search({
                query: requireString(args.query, 'search', 'query'),
                limit: optionalNumber(args.limit, 'search', 'limit'),
                mode: optionalSearchMode(args.mode),
            });

        case 'ask':
            return lumen.ask({
                question: requireString(args.question, 'ask', 'question'),
                limit: optionalNumber(args.limit, 'ask', 'limit'),
                budget: optionalNumber(args.budget, 'ask', 'budget'),
            });

        case 'status':
            return lumen.status();

        case 'profile':
            return lumen.profile({ refresh: optionalBool(args.refresh, 'profile', 'refresh') });

        case 'god_nodes':
            return lumen.graph.godNodes(optionalNumber(args.limit, 'god_nodes', 'limit'));

        case 'pagerank': {
            const limit = optionalNumber(args.limit, 'pagerank', 'limit');
            return limit !== undefined
                ? lumen.graph.pagerank().slice(0, limit)
                : lumen.graph.pagerank();
        }

        case 'neighbors':
            return lumen.graph.neighbors(
                requireString(args.slug, 'neighbors', 'slug'),
                optionalNumber(args.depth, 'neighbors', 'depth'),
            );

        case 'path':
            return lumen.graph.path(
                requireString(args.from, 'path', 'from'),
                requireString(args.to, 'path', 'to'),
                optionalNumber(args.maxDepth, 'path', 'maxDepth'),
            );

        case 'communities':
            return lumen.graph.communities(
                optionalNumber(args.maxIterations, 'communities', 'maxIterations'),
            );

        default:
            throw new LumenError('INVALID_ARGUMENT', `Unknown tool: "${call.name}"`);
    }
}

/**
 * Lookup helper — useful when an adapter needs a single definition
 * without filtering the array itself.
 */
export function getToolDefinition(name: string): ToolDefinition | undefined {
    return toolDefinitions.find((t) => t.name === name);
}

/* ─── arg-coercion helpers ─── */

function requireString(v: unknown, tool: string, field: string): string {
    if (typeof v !== 'string' || v.length === 0) {
        throw new LumenError(
            'INVALID_ARGUMENT',
            `${tool}: \`${field}\` must be a non-empty string`,
        );
    }
    return v;
}

function optionalNumber(v: unknown, tool: string, field: string): number | undefined {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new LumenError('INVALID_ARGUMENT', `${tool}: \`${field}\` must be a number`);
    }
    return v;
}

function optionalBool(v: unknown, tool: string, field: string): boolean | undefined {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'boolean') {
        throw new LumenError('INVALID_ARGUMENT', `${tool}: \`${field}\` must be a boolean`);
    }
    return v;
}

function optionalSearchMode(v: unknown): 'hybrid' | 'bm25' | 'tfidf' | undefined {
    if (v === undefined || v === null) return undefined;
    if (v === 'hybrid' || v === 'bm25' || v === 'tfidf') return v;
    throw new LumenError(
        'INVALID_ARGUMENT',
        `search: \`mode\` must be "hybrid" | "bm25" | "tfidf"`,
    );
}
