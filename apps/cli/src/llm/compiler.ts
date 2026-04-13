import { chatJson } from './client.js';
import { COMPILE_SYSTEM, compileUserPrompt } from './prompts.js';
import type { CompileResponse } from './prompts.js';
import { getChunksBySource } from '../store/chunks.js';
import { upsertConcept } from '../store/concepts.js';
import { upsertEdge } from '../store/edges.js';
import { linkSourceConcept } from '../store/concepts.js';
import { markCompiled } from '../store/sources.js';
import { toSlug } from '../utils/slug.js';
import { audit } from '../utils/logger.js';
import type { LumenConfig, CompilationResult, RelationType } from '../types/index.js';

const VALID_RELATIONS: Set<string> = new Set([
    'implements',
    'extends',
    'contradicts',
    'supports',
    'related',
    'part-of',
    'prerequisite',
    'alternative',
    'example-of',
]);

/**
 * Compile a single source: send its chunks to the LLM,
 * parse the response, upsert concepts and edges.
 */
export async function compileSource(
    sourceId: string,
    sourceTitle: string,
    config: LumenConfig,
): Promise<CompilationResult> {
    const chunks = getChunksBySource(sourceId);
    if (chunks.length === 0) {
        markCompiled(sourceId);
        return {
            source_id: sourceId,
            concepts_created: [],
            concepts_updated: [],
            edges_created: 0,
            tokens_used: 0,
        };
    }

    /** Select representative chunks (skip headings-only, limit to ~30 for token budget). */
    const representativeChunks = chunks
        .filter((c) => c.chunk_type !== 'heading' && c.content.length > 20)
        .slice(0, 30)
        .map((c) => ({ content: c.content, heading: c.heading }));

    const userPrompt = compileUserPrompt(sourceTitle, representativeChunks);
    const tokensUsed = Math.ceil(userPrompt.length / 4);

    const response = await chatJson<CompileResponse>(
        config,
        [{ role: 'user', content: userPrompt }],
        {
            system: COMPILE_SYSTEM,
            maxTokens: 4096,
            temperature: 0.2,
        },
    );

    const now = new Date().toISOString();
    const conceptsCreated: string[] = [];
    const conceptsUpdated: string[] = [];

    /** Upsert concepts. */
    for (const concept of response.concepts) {
        const slug = toSlug(concept.slug || concept.name);
        if (!slug) continue;

        const existing = (await import('../store/concepts.js')).getConcept(slug);
        upsertConcept({
            slug,
            name: concept.name,
            summary: concept.summary || null,
            article: null,
            created_at: existing ? existing.created_at : now,
            updated_at: now,
            mention_count: 1,
        });

        linkSourceConcept({ source_id: sourceId, concept_slug: slug, relevance: 0.8 });

        if (existing) {
            conceptsUpdated.push(slug);
        } else {
            conceptsCreated.push(slug);
        }
    }

    /** Upsert edges (only between concepts we actually have). */
    const knownSlugs = new Set(response.concepts.map((c) => toSlug(c.slug || c.name)));
    let edgesCreated = 0;

    for (const edge of response.edges) {
        const fromSlug = toSlug(edge.from);
        const toSlug_ = toSlug(edge.to);

        if (!fromSlug || !toSlug_ || fromSlug === toSlug_) continue;
        if (!knownSlugs.has(fromSlug) || !knownSlugs.has(toSlug_)) continue;

        const relation = VALID_RELATIONS.has(edge.relation)
            ? (edge.relation as RelationType)
            : 'related';
        const weight = Math.max(0, Math.min(1, edge.weight || 0.5));

        upsertEdge({
            from_slug: fromSlug,
            to_slug: toSlug_,
            relation,
            weight,
            source_id: sourceId,
        });
        edgesCreated++;
    }

    markCompiled(sourceId);

    audit('source:compile', {
        source_id: sourceId,
        concepts_created: conceptsCreated.length,
        concepts_updated: conceptsUpdated.length,
        edges_created: edgesCreated,
        tokens_used: tokensUsed,
    });

    return {
        source_id: sourceId,
        concepts_created: conceptsCreated,
        concepts_updated: conceptsUpdated,
        edges_created: edgesCreated,
        tokens_used: tokensUsed,
    };
}
