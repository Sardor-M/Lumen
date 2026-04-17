export type ChunkType =
    | 'heading'
    | 'paragraph'
    | 'code'
    | 'list'
    | 'blockquote'
    | 'table'
    | 'frontmatter';

export type SourceType = 'url' | 'pdf' | 'youtube' | 'arxiv' | 'file' | 'folder';

export type RelationType =
    | 'implements'
    | 'extends'
    | 'contradicts'
    | 'supports'
    | 'related'
    | 'part-of'
    | 'prerequisite'
    | 'alternative'
    | 'example-of';

export type Source = {
    id: string;
    title: string;
    url: string | null;
    content: string;
    content_hash: string;
    source_type: SourceType;
    added_at: string;
    compiled_at: string | null;
    word_count: number;
    language: string | null;
    metadata: string | null;
};

export type Chunk = {
    id: string;
    source_id: string;
    content: string;
    content_hash: string;
    chunk_type: ChunkType;
    heading: string | null;
    position: number;
    token_count: number;
};

/**
 * A single entry in a concept's immutable evidence trail.
 * Appended whenever new evidence arrives — never edited or removed.
 */
export type TimelineEntry = {
    /** ISO date string, e.g. "2025-01-15". */
    date: string;
    /** FK → sources.id that contributed this entry. Null for MCP-captured entries. */
    source_id: string | null;
    /** Denormalised source title for display without a join. */
    source_title: string;
    /** One-line description of what this source or event contributed. */
    event: string;
    /** Optional longer explanation. */
    detail: string | null;
};

/**
 * Enrichment tier — lower number = richer knowledge page.
 * 1 = full pipeline (6+ mentions, 3+ sources)
 * 2 = enriched summary (3+ mentions, 2+ sources)
 * 3 = stub (newly seen concept)
 */
export type EnrichmentTier = 1 | 2 | 3;

export type Concept = {
    slug: string;
    name: string;
    /** Legacy one-liner kept for backwards compatibility. */
    summary: string | null;
    /**
     * Mutable best-current-understanding.
     * Rewritten each time new evidence materially changes the picture.
     */
    compiled_truth: string | null;
    /**
     * Append-only evidence trail — parsed from the `timeline` JSON column.
     * Returned newest-first by getConcept().
     */
    timeline: TimelineEntry[];
    article: string | null;
    created_at: string;
    updated_at: string;
    mention_count: number;
    /** Tiered enrichment — 1 = full, 2 = enriched, 3 = stub. Managed by `updateEnrichmentTiers`. */
    enrichment_tier: EnrichmentTier;
    last_enriched_at: string | null;
    /** 1 = queued for enrichment, 0 = current. */
    enrichment_queued: number;
};

export type Edge = {
    from_slug: string;
    to_slug: string;
    relation: RelationType;
    weight: number;
    source_id: string | null;
};

export type SourceConcept = {
    source_id: string;
    concept_slug: string;
    relevance: number;
};

export type SearchResult = {
    chunk_id: string;
    source_id: string;
    source_title: string;
    content: string;
    snippet: string;
    score: number;
    chunk_type: ChunkType;
    heading: string | null;
};

export type IngestResult = {
    source_id: string;
    title: string;
    source_type: SourceType;
    chunk_count: number;
    word_count: number;
    deduplicated: boolean;
};

export type ExtractionResult = {
    title: string;
    content: string;
    url: string | null;
    source_type: SourceType;
    language: string | null;
    metadata: Record<string, unknown>;
};

export type CompilationResult = {
    source_id: string;
    concepts_created: string[];
    concepts_updated: string[];
    edges_created: number;
    tokens_used: number;
};

export type LintIssue = {
    type: 'orphan' | 'broken-link' | 'duplicate' | 'contradiction' | 'stale';
    severity: 'error' | 'warning' | 'info';
    message: string;
    target: string;
};

/** Embedding provider for vector search. 'none' disables embedding entirely. */
export type EmbeddingProvider = 'openai' | 'ollama' | 'none';

export type EmbeddingConfig = {
    provider: EmbeddingProvider;
    /** Model name — e.g. "text-embedding-3-small" or "nomic-embed-text". */
    model: string;
    /** Output vector dimensions — must match the model. */
    dimensions: number;
    api_key: string | null;
    base_url: string | null;
    /** Number of texts sent per API call. */
    batch_size: number;
};

export type LumenConfig = {
    data_dir: string;
    llm: {
        provider: 'anthropic' | 'openrouter' | 'ollama';
        model: string;
        api_key: string | null;
        base_url: string | null;
    };
    chunker: {
        min_chunk_tokens: number;
        max_chunk_tokens: number;
    };
    search: {
        max_results: number;
        token_budget: number;
        /** RRF weight for BM25 signal (ignored when embedding.provider is 'none'). */
        bm25_weight: number;
        /** RRF weight for TF-IDF signal. */
        tfidf_weight: number;
        /** RRF weight for vector similarity signal. */
        vector_weight: number;
    };
    embedding: EmbeddingConfig;
};

/** Directional link type stored in the concept_links table. */
export type LinkType = 'reference' | 'back-link' | 'manual' | 'co-occurs';

export type ConceptLink = {
    id: number;
    from_slug: string;
    to_slug: string;
    link_type: LinkType;
    /** Passage or context that generated this link. */
    context: string | null;
    /** FK → sources.id. Null for manually added or MCP-captured links. */
    source_id: string | null;
    created_at: string;
};

/**
 * Classified intent of a search query.
 * Used by the intent router to pick the most efficient retrieval path.
 */
export type QueryIntent =
    | 'entity_lookup' /** "who is X" / "what is X" — go straight to concept page */
    | 'graph_path' /** "path from X to Y" / "how does X connect to Y" */
    | 'neighborhood' /** "what is related to X" / "neighbors of X" */
    | 'temporal' /** "what happened in March" / "timeline of X" */
    | 'originals' /** "what have I said about X" / "my notes on X" */
    | 'hybrid_search'; /** everything else — full three-signal pipeline */

export type ConnectorType = 'rss' | 'folder' | 'arxiv' | 'github' | 'youtube-channel';

export type Connector = {
    id: string;
    type: ConnectorType;
    name: string;
    config: string;
    state: string;
    interval_seconds: number;
    last_run_at: string | null;
    last_error: string | null;
    created_at: string;
};

export type IngestErrorCode =
    | 'PAYWALL'
    | 'JS_RENDERED'
    | 'RATE_LIMITED'
    | 'NOT_FOUND'
    | 'MALFORMED'
    | 'NO_CONTENT'
    | 'NO_CAPTIONS'
    | 'NETWORK'
    | 'TIMEOUT'
    | 'PERMISSION'
    | 'UNKNOWN';

export type WikiStats = {
    source_count: number;
    chunk_count: number;
    concept_count: number;
    edge_count: number;
    total_words: number;
    total_tokens: number;
    compiled_count: number;
    uncompiled_count: number;
    sources_by_type: Record<SourceType, number>;
};
