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

export type Concept = {
    slug: string;
    name: string;
    summary: string | null;
    article: string | null;
    created_at: string;
    updated_at: string;
    mention_count: number;
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
    };
};

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
