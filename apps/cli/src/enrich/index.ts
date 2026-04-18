import { getDb } from '../store/database.js';
import type { LumenConfig, EnrichmentTier } from '../types/index.js';
import { computeTier } from './tiers.js';
import { updateCompiledTruth, appendTimeline } from '../store/concepts.js';
import { chat } from '../llm/client.js';

type ConceptRow = {
    slug: string;
    mention_count: number;
    enrichment_tier: number;
    distinct_sources: number;
};

type EnrichRow = {
    slug: string;
    name: string;
    enrichment_tier: number;
    compiled_truth: string | null;
};

/**
 * Scan all concepts and update enrichment tiers based on evidence density.
 * Queues concepts whose tier has improved for enrichment.
 * Called automatically at the end of `lumen compile`.
 */
export function updateEnrichmentTiers(): { queued: number } {
    const db = getDb();

    const concepts = db
        .prepare(
            `SELECT c.slug, c.mention_count, c.enrichment_tier,
                    COUNT(DISTINCT sc.source_id) AS distinct_sources
             FROM concepts c
             LEFT JOIN source_concepts sc ON sc.concept_slug = c.slug
             GROUP BY c.slug`,
        )
        .all() as ConceptRow[];

    let queued = 0;

    const update = db.prepare(
        `UPDATE concepts SET enrichment_tier = ?, enrichment_queued = CASE WHEN ? = 1 THEN 1 ELSE enrichment_queued END WHERE slug = ?`,
    );

    const batch = db.transaction(() => {
        for (const c of concepts) {
            const newTier = computeTier(c.mention_count, c.distinct_sources);
            /** Lower number = higher tier — only queue when tier improves. */
            const improved = newTier < c.enrichment_tier;
            update.run(newTier, improved ? 1 : 0, c.slug);
            if (improved) queued++;
        }
    });
    batch();

    return { queued };
}

/**
 * Process the enrichment queue: synthesise richer compiled_truth for each queued concept
 * using all source chunks that mention it.
 * Tier 2 → rich summary (2-4 sentences). Tier 1 → comprehensive article (4-8 sentences).
 */
export async function processEnrichmentQueue(config: LumenConfig): Promise<{ enriched: number }> {
    const db = getDb();

    const queued = db
        .prepare(
            `SELECT c.slug, c.name, c.enrichment_tier, c.compiled_truth
             FROM concepts c
             WHERE c.enrichment_queued = 1
             ORDER BY c.enrichment_tier ASC, c.mention_count DESC
             LIMIT 10`,
        )
        .all() as EnrichRow[];

    let enriched = 0;

    for (const concept of queued) {
        const tier = concept.enrichment_tier as EnrichmentTier;

        const sourceIds = db
            .prepare(
                `SELECT source_id FROM source_concepts
                 WHERE concept_slug = ?
                 ORDER BY relevance DESC
                 LIMIT 5`,
            )
            .all(concept.slug) as { source_id: string }[];

        const chunks = sourceIds.flatMap(
            ({ source_id }) =>
                db
                    .prepare(
                        `SELECT content FROM chunks WHERE source_id = ? ORDER BY position LIMIT 8`,
                    )
                    .all(source_id) as { content: string }[],
        );

        if (chunks.length === 0) continue;

        const contextText = chunks.map((c) => c.content).join('\n\n');
        const depth = tier === 1 ? 'comprehensive article' : 'rich summary';
        const sentenceRange = tier === 1 ? '4-8 sentences' : '2-4 sentences';

        const prompt = `You are writing a knowledge page entry for the concept "${concept.name}".

Source material:
${contextText.slice(0, 3000)}

Write a ${depth} (${sentenceRange}) that:
1. Synthesises what this concept IS and WHY it matters
2. Notes key relationships to other concepts where clear from the text
3. Is written from a knowledge-base perspective, not a summary of a single source

Return only the text, no headers or metadata.`;

        try {
            const enrichedTruth = await chat(config, [{ role: 'user', content: prompt }], {
                maxTokens: tier === 1 ? 1000 : 400,
                temperature: 0.3,
            });

            updateCompiledTruth(concept.slug, enrichedTruth);
            appendTimeline(concept.slug, {
                date: new Date().toISOString().slice(0, 10),
                source_id: null,
                source_title: `Tier ${tier} enrichment`,
                event: `Enriched to Tier ${tier} — synthesised from ${sourceIds.length} source${sourceIds.length === 1 ? '' : 's'}`,
                detail: null,
            });

            db.prepare(
                `UPDATE concepts SET enrichment_queued = 0, last_enriched_at = ? WHERE slug = ?`,
            ).run(new Date().toISOString(), concept.slug);

            enriched++;
        } catch {
            /** Leave in queue — will retry next run. */
        }
    }

    return { enriched };
}
