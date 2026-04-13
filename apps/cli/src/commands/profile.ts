import type { Command } from 'commander';
import { getDb } from '../store/database.js';
import { isInitialized } from '../utils/paths.js';
import { getProfile } from '../profile/cache.js';
import * as log from '../utils/logger.js';

export function registerProfile(program: Command): void {
    program
        .command('profile')
        .description(
            'Show a fast summary of your knowledge base — top concepts, recent activity, learned preferences',
        )
        .option('--json', 'Output as JSON')
        .option('--refresh', 'Force rebuild the profile cache')
        .action((opts: { json?: boolean; refresh?: boolean }) => {
            try {
                if (!isInitialized()) {
                    if (opts.json) {
                        console.log(JSON.stringify({ initialized: false }));
                    } else {
                        log.warn('Lumen is not initialized. Run `lumen init` first.');
                    }
                    return;
                }

                getDb();
                const profile = getProfile(opts.refresh);

                if (opts.json) {
                    console.log(JSON.stringify(profile, null, 2));
                    return;
                }

                log.heading('Lumen Profile');
                log.table({
                    Sources: profile.static.total_sources,
                    Concepts: profile.static.total_concepts,
                    Edges: profile.static.total_edges,
                    Density: profile.static.graph_density,
                    'Pending compilation': profile.dynamic.pending_compilation,
                });

                if (profile.static.god_nodes.length > 0) {
                    log.heading('Top Concepts');
                    for (const g of profile.static.god_nodes.slice(0, 5)) {
                        log.info(`  ${g.name} (${g.edges} edges)`);
                    }
                }

                if (profile.static.top_communities.length > 0) {
                    log.heading('Communities');
                    for (const c of profile.static.top_communities) {
                        log.info(
                            `  #${c.id} (${c.size} members): ${c.members.slice(0, 4).join(', ')}`,
                        );
                    }
                }

                if (profile.dynamic.recent_sources.length > 0) {
                    log.heading('Recent Sources');
                    for (const s of profile.dynamic.recent_sources.slice(0, 3)) {
                        log.info(`  ${s.title} (${s.type}, ${s.added_at.split('T')[0]})`);
                    }
                }

                if (profile.learned.frequent_topics.length > 0) {
                    log.heading('Frequent Queries');
                    for (const t of profile.learned.frequent_topics.slice(0, 5)) {
                        log.info(`  "${t.query_text}" (${t.count}x)`);
                    }
                }

                log.dim(`\nGenerated: ${profile.generated_at}`);
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });
}
