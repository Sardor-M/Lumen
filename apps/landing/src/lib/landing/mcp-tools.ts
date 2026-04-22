export type McpCategory = 'brain' | 'ingest' | 'graph' | 'meta';

export type McpTool = {
    name: string;
    category: McpCategory;
    description: string;
};

export const MCP_TOOLS: readonly McpTool[] = [
    {
        name: 'brain_ops',
        category: 'brain',
        description:
            'Brain-first lookup — auto-routes by intent (concept · path · neighborhood · search).',
    },
    {
        name: 'search',
        category: 'brain',
        description: 'Hybrid BM25 + TF-IDF + vector search. RRF k=60 fusion.',
    },
    {
        name: 'query',
        category: 'brain',
        description: 'Search + streamed LLM-synthesized answer with citations.',
    },
    {
        name: 'capture',
        category: 'brain',
        description: 'Write an idea / fact / entity to the graph from conversation.',
    },
    {
        name: 'session_summary',
        category: 'brain',
        description: 'End-of-session digest with concept updates + new edges.',
    },
    {
        name: 'add',
        category: 'ingest',
        description: 'Ingest URL, PDF, YouTube, arXiv, file, or folder. SHA-256 dedup.',
    },
    {
        name: 'compile',
        category: 'ingest',
        description: 'Extract concepts + edges + timeline from unprocessed sources.',
    },
    {
        name: 'concept',
        category: 'graph',
        description: 'Full concept detail — compiled truth, timeline, edges.',
    },
    { name: 'neighbors', category: 'graph', description: 'N-hop neighborhood around a concept.' },
    { name: 'path', category: 'graph', description: 'Shortest path between two concepts (BFS).' },
    {
        name: 'pagerank',
        category: 'graph',
        description: 'Rank concepts by stationary distribution of random walk (d=0.85).',
    },
    { name: 'god_nodes', category: 'graph', description: 'Most-connected concepts by PageRank.' },
    {
        name: 'communities',
        category: 'graph',
        description: 'Topic clusters via label propagation.',
    },
    { name: 'community', category: 'graph', description: 'Concepts inside a specific cluster.' },
    {
        name: 'add_link',
        category: 'graph',
        description: 'Manually cross-link two concepts with a weight.',
    },
    { name: 'links', category: 'graph', description: 'Outgoing links from a concept.' },
    { name: 'backlinks', category: 'graph', description: 'What references a given concept.' },
    {
        name: 'status',
        category: 'meta',
        description: 'KB statistics — sources, chunks, concepts, tiers, density.',
    },
    {
        name: 'profile',
        category: 'meta',
        description: 'Corpus summary with caching. Invalidated on write.',
    },
];
