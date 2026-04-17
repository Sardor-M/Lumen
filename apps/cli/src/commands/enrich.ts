import type { Command } from 'commander';
import { getDb } from '../store/database.js';
import { updateEnrichmentTiers, processEnrichmentQueue } from '../enrich/index.js';
import { loadConfig } from '../utils/config.js';
import * as log from '../utils/logger.js';

export function registerEnrich(program: Command): void {
    program
        .command('enrich')
        .description('Enrich concepts that have crossed tier thresholds')
        .option('--status', 'Show enrichment tier distribution without running enrichment')
        .option('--all', 'Re-queue all concepts and enrich everything')
        .action(async (opts: { status?: boolean; all?: boolean }) => {
            try {
                const config = loadConfig();
                getDb();

                if (opts.status) {
                    const tiers = getDb()
                        .prepare(
                            `SELECT enrichment_tier,
                                    COUNT(*) AS count,
                                    SUM(enrichment_queued) AS queued
                             FROM concepts
                             GROUP BY enrichment_tier
                             ORDER BY enrichment_tier`,
                        )
                        .all() as { enrichment_tier: number; count: number; queued: number }[];

                    for (const t of tiers) {
                        const label =
                            t.enrichment_tier === 1
                                ? 'Full'
                                : t.enrichment_tier === 2
                                  ? 'Enriched'
                                  : 'Stub';
                        log.table({
                            [`Tier ${t.enrichment_tier} (${label})`]: `${t.count} concepts, ${t.queued ?? 0} queued`,
                        });
                    }
                    return;
                }

                if (opts.all) {
                    getDb().prepare(`UPDATE concepts SET enrichment_queued = 1`).run();
                    log.info('All concepts queued for enrichment');
                } else {
                    const { queued } = updateEnrichmentTiers();
                    log.info(`${queued} concept${queued === 1 ? '' : 's'} queued for enrichment`);
                    if (queued === 0) return;
                }

                log.heading('Processing enrichment queue');
                const { enriched } = await processEnrichmentQueue(config);
                log.success(`Enriched ${enriched} concept${enriched === 1 ? '' : 's'}`);
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });
}
