import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getOutputDir } from '../utils/paths.js';
import { countSources, countSourcesByType } from '../store/sources.js';
import { countChunks, totalTokens } from '../store/chunks.js';
import { countConcepts } from '../store/concepts.js';
import { countEdges, getEdgesFrom, getEdgesTo } from '../store/edges.js';
import { getConcept, getConceptSources } from '../store/concepts.js';
import { getSource } from '../store/sources.js';
import { godNodes } from './engine.js';
import { pagerank } from './pagerank.js';
import { detectCommunities } from './cluster.js';
import type { Edge } from '../types/index.js';

/**
 * Generate GRAPH_REPORT.md — a human-readable summary of the knowledge graph.
 * Returns the file path where the report was written.
 */
export function generateReport(): string {
    const lines: string[] = [];

    lines.push('# Knowledge Graph Report');
    lines.push('');
    lines.push(`*Generated: ${new Date().toISOString()}*`);
    lines.push('');

    /** Stats overview. */
    lines.push('## Overview');
    lines.push('');
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Sources | ${countSources()} |`);
    lines.push(`| Chunks | ${countChunks()} |`);
    lines.push(`| Tokens | ${totalTokens()} |`);
    lines.push(`| Concepts | ${countConcepts()} |`);
    lines.push(`| Edges | ${countEdges()} |`);
    lines.push('');

    const byType = countSourcesByType();
    if (Object.keys(byType).length > 0) {
        lines.push(
            'Sources by type: ' +
                Object.entries(byType)
                    .map(([t, n]) => `${t} (${n})`)
                    .join(', '),
        );
        lines.push('');
    }

    /** God concepts. */
    const gods = godNodes(10);
    if (gods.length > 0) {
        lines.push('## God Concepts');
        lines.push('');
        lines.push('Highest-connectivity concepts — what everything connects through.');
        lines.push('');

        for (let i = 0; i < gods.length; i++) {
            const g = gods[i];
            const sources = getConceptSources(g.slug);
            lines.push(`${i + 1}. **${g.name}** — ${g.edgeCount} edges, ${sources.length} sources`);
        }
        lines.push('');
    }

    /** PageRank. */
    const pr = pagerank();
    if (pr.length > 0) {
        lines.push('## Most Important Concepts (PageRank)');
        lines.push('');

        const top = pr.slice(0, 10);
        for (let i = 0; i < top.length; i++) {
            lines.push(`${i + 1}. **${top[i].name}** — score: ${top[i].score.toFixed(4)}`);
        }
        lines.push('');
    }

    /** Communities. */
    const communities = detectCommunities();
    if (communities.length > 0) {
        lines.push('## Communities');
        lines.push('');
        lines.push(
            `${communities.length} community${communities.length === 1 ? '' : 'ies'} detected via label propagation.`,
        );
        lines.push('');

        for (const community of communities.slice(0, 15)) {
            const memberNames = community.members.map((slug) => getConcept(slug)?.name ?? slug).slice(0, 8);
            const suffix = community.size > 8 ? ` +${community.size - 8} more` : '';
            lines.push(`${community.id + 1}. **[${community.size} concepts]** — ${memberNames.join(', ')}${suffix}`);
        }
        lines.push('');
    }

    /** Surprising connections — cross-community edges. */
    if (communities.length > 1) {
        const crossEdges = findCrossCommunityEdges(communities);
        if (crossEdges.length > 0) {
            lines.push('## Surprising Connections');
            lines.push('');
            lines.push('Edges connecting different communities — these bridge distinct topic clusters.');
            lines.push('');

            for (const ce of crossEdges.slice(0, 10)) {
                const fromName = getConcept(ce.edge.from_slug)?.name ?? ce.edge.from_slug;
                const toName = getConcept(ce.edge.to_slug)?.name ?? ce.edge.to_slug;
                const sourceName = ce.edge.source_id ? getSource(ce.edge.source_id)?.title : null;
                const via = sourceName ? ` — via "${sourceName}"` : '';
                lines.push(
                    `- **${fromName}** (community ${ce.fromCommunity + 1}) ←→ **${toName}** (community ${ce.toCommunity + 1}) [${ce.edge.relation}]${via}`,
                );
            }
            lines.push('');
        }
    }

    /** Suggested questions. */
    if (gods.length >= 2 && communities.length >= 1) {
        lines.push('## Suggested Questions');
        lines.push('');
        lines.push('Questions this graph is positioned to answer:');
        lines.push('');

        if (gods.length >= 2) {
            lines.push(`- How does **${gods[0].name}** relate to **${gods[1].name}**?`);
        }
        if (gods.length >= 3) {
            lines.push(`- What connects **${gods[0].name}** to **${gods[2].name}**?`);
        }
        if (communities.length >= 2) {
            const c0members = communities[0].members.slice(0, 2).map((s) => getConcept(s)?.name ?? s);
            const c1members = communities[1].members.slice(0, 2).map((s) => getConcept(s)?.name ?? s);
            lines.push(`- How do concepts in [${c0members.join(', ')}] relate to [${c1members.join(', ')}]?`);
        }
        lines.push(`- Which concepts are prerequisites for understanding **${gods[0].name}**?`);
        lines.push(`- What contradictions exist in the knowledge base?`);
        lines.push('');
    }

    const report = lines.join('\n');
    const outPath = join(getOutputDir(), 'GRAPH_REPORT.md');
    writeFileSync(outPath, report, 'utf-8');
    return outPath;
}

type CrossCommunityEdge = {
    edge: Edge;
    fromCommunity: number;
    toCommunity: number;
};

function findCrossCommunityEdges(communities: { id: number; members: string[] }[]): CrossCommunityEdge[] {
    /** Build slug → community lookup. */
    const slugToCommunity = new Map<string, number>();
    for (const c of communities) {
        for (const member of c.members) slugToCommunity.set(member, c.id);
    }

    const results: CrossCommunityEdge[] = [];
    const seen = new Set<string>();

    for (const community of communities) {
        for (const slug of community.members) {
            const edges = [...getEdgesFrom(slug), ...getEdgesTo(slug)];
            for (const edge of edges) {
                const key = `${edge.from_slug}:${edge.to_slug}:${edge.relation}`;
                if (seen.has(key)) continue;
                seen.add(key);

                const fromC = slugToCommunity.get(edge.from_slug) ?? -1;
                const toC = slugToCommunity.get(edge.to_slug) ?? -1;

                if (fromC !== toC && fromC >= 0 && toC >= 0) {
                    results.push({ edge, fromCommunity: fromC, toCommunity: toC });
                }
            }
        }
    }

    /** Sort by weight descending — strongest cross-community links first. */
    return results.sort((a, b) => b.edge.weight - a.edge.weight);
}
