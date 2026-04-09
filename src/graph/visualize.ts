import { listConcepts } from '../store/concepts.js';
import { listEdges } from '../store/edges.js';
import { detectCommunities } from './cluster.js';
import type { Concept, Edge } from '../types/index.js';

type GraphJson = {
    nodes: { slug: string; name: string; mention_count: number; community: number }[];
    edges: { from: string; to: string; relation: string; weight: number }[];
    communities: { id: number; size: number; members: string[] }[];
};

/** Export the knowledge graph as JSON (for D3.js or other visualizations). */
export function toJson(): GraphJson {
    const concepts = listConcepts();
    const edges = listEdges();
    const communities = detectCommunities();

    /** Build slug → community lookup. */
    const communityMap = new Map<string, number>();
    for (const c of communities) {
        for (const member of c.members) communityMap.set(member, c.id);
    }

    return {
        nodes: concepts.map((c) => ({
            slug: c.slug,
            name: c.name,
            mention_count: c.mention_count,
            community: communityMap.get(c.slug) ?? -1,
        })),
        edges: edges.map((e) => ({
            from: e.from_slug,
            to: e.to_slug,
            relation: e.relation,
            weight: e.weight,
        })),
        communities: communities.map((c) => ({
            id: c.id,
            size: c.size,
            members: c.members,
        })),
    };
}

/** Export the knowledge graph as DOT format (for Graphviz). */
export function toDot(): string {
    const concepts = listConcepts();
    const edges = listEdges();
    const communities = detectCommunities();

    const communityMap = new Map<string, number>();
    for (const c of communities) {
        for (const member of c.members) communityMap.set(member, c.id);
    }

    const colors = [
        '#FF6B6B',
        '#4ECDC4',
        '#45B7D1',
        '#FFA07A',
        '#98D8C8',
        '#F7DC6F',
        '#BB8FCE',
        '#85C1E2',
        '#F8B88B',
        '#52C41A',
    ];

    const lines: string[] = [
        'digraph knowledge_graph {',
        '  rankdir=LR;',
        '  node [shape=box, style=filled];',
        '',
    ];

    for (const concept of concepts) {
        const cid = communityMap.get(concept.slug) ?? 0;
        const color = colors[cid % colors.length];
        const label = concept.name.replace(/"/g, '\\"');
        lines.push(`  "${concept.slug}" [label="${label}", fillcolor="${color}"];`);
    }

    lines.push('');

    for (const edge of edges) {
        const label = edge.relation.replace(/"/g, '\\"');
        lines.push(
            `  "${edge.from_slug}" -> "${edge.to_slug}" [label="${label}", weight=${edge.weight}];`,
        );
    }

    lines.push('}');
    return lines.join('\n');
}
