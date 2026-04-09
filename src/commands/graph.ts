import { writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { getDb } from '../store/database.js';
import { getConcept } from '../store/concepts.js';
import { shortestPath, neighborhood, godNodes, connectedComponents } from '../graph/engine.js';
import { pagerank } from '../graph/pagerank.js';
import { detectCommunities } from '../graph/cluster.js';
import { toJson, toDot } from '../graph/visualize.js';
import { generateReport } from '../graph/report.js';
import * as log from '../utils/logger.js';

export function registerGraph(program: Command): void {
    const cmd = program.command('graph').description('Explore the knowledge graph (local, no LLM)');

    cmd.command('status')
        .description('Show graph overview — components, communities, top concepts')
        .action(() => {
            try {
                getDb();
                const components = connectedComponents();
                const communities = detectCommunities();
                const gods = godNodes(5);

                log.heading('Knowledge Graph');
                log.table({
                    Components: components.length,
                    Communities: communities.length,
                    'Largest component': components[0]?.length ?? 0,
                });

                if (gods.length > 0) {
                    console.log();
                    log.heading('Top Concepts');
                    for (const g of gods) {
                        console.log(`  ${g.name} (${g.edgeCount} edges)`);
                    }
                }

                if (communities.length > 0) {
                    console.log();
                    log.heading('Communities');
                    for (const c of communities.slice(0, 10)) {
                        const names = c.members.slice(0, 5).map((s) => getConcept(s)?.name ?? s);
                        const suffix = c.size > 5 ? ` +${c.size - 5} more` : '';
                        console.log(`  [${c.size}] ${names.join(', ')}${suffix}`);
                    }
                }
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });

    cmd.command('path <from> <to>')
        .description('Find shortest path between two concepts')
        .action((from: string, to: string) => {
            try {
                getDb();
                const result = shortestPath(from, to);

                if (!result) {
                    log.warn(`No path found between "${from}" and "${to}"`);
                    return;
                }

                log.heading(`Path: ${from} → ${to} (${result.hops} hops)`);
                for (let i = 0; i < result.path.length; i++) {
                    const name = getConcept(result.path[i])?.name ?? result.path[i];
                    const arrow = i < result.edges.length ? ` —[${result.edges[i].relation}]→` : '';
                    console.log(`  ${name}${arrow}`);
                }
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });

    cmd.command('neighbors <concept>')
        .description('Show concepts connected within N hops')
        .option('-d, --depth <n>', 'Hop depth', '2')
        .action((concept: string, opts: { depth: string }) => {
            try {
                getDb();
                const depth = parseInt(opts.depth) || 2;
                const result = neighborhood(concept, depth);

                log.heading(
                    `Neighborhood of "${concept}" (${depth} hops, ${result.nodes.size} nodes)`,
                );
                for (const slug of result.nodes) {
                    if (slug === concept) continue;
                    const name = getConcept(slug)?.name ?? slug;
                    console.log(`  ${name}`);
                }
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });

    cmd.command('pagerank')
        .description('Show concepts ranked by PageRank importance')
        .option('-n, --limit <n>', 'Number of results', '15')
        .action((opts: { limit: string }) => {
            try {
                getDb();
                const limit = parseInt(opts.limit) || 15;
                const results = pagerank();

                if (results.length === 0) {
                    log.warn('No concepts in the graph. Run `lumen compile` first.');
                    return;
                }

                log.heading('PageRank — Concept Importance');
                for (let i = 0; i < Math.min(limit, results.length); i++) {
                    const r = results[i];
                    console.log(`  ${i + 1}. ${r.name} (${r.score.toFixed(4)})`);
                }
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });

    cmd.command('report')
        .description('Generate GRAPH_REPORT.md')
        .action(() => {
            try {
                getDb();
                const path = generateReport();
                log.success(`Report written to ${path}`);
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });

    cmd.command('export')
        .description('Export graph as JSON or DOT')
        .option('-f, --format <format>', 'Output format: json or dot', 'json')
        .option('-o, --output <path>', 'Output file path')
        .action((opts: { format: string; output?: string }) => {
            try {
                getDb();

                let content: string;
                let defaultName: string;

                if (opts.format === 'dot') {
                    content = toDot();
                    defaultName = 'graph.dot';
                } else {
                    content = JSON.stringify(toJson(), null, 2);
                    defaultName = 'graph.json';
                }

                const outPath = opts.output ?? defaultName;
                writeFileSync(outPath, content, 'utf-8');
                log.success(`Exported graph to ${outPath}`);
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });
}
