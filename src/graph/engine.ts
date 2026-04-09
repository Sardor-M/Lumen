import { getDb } from '../store/database.js';
import { getEdgesFrom, getEdgesTo, getNeighbors } from '../store/edges.js';
import { getConcept, listConcepts } from '../store/concepts.js';
import type { Edge, Concept } from '../types/index.js';

type PathResult = {
    path: string[];
    edges: Edge[];
    hops: number;
};

type NeighborhoodResult = {
    center: string;
    nodes: Set<string>;
    edges: Edge[];
    depth: number;
};

/**
 * BFS shortest path between two concepts.
 * Returns null if no path exists.
 */
export function shortestPath(fromSlug: string, toSlug: string, maxDepth = 6): PathResult | null {
    if (fromSlug === toSlug) return { path: [fromSlug], edges: [], hops: 0 };

    const visited = new Set<string>([fromSlug]);
    const parent = new Map<string, { slug: string; edge: Edge }>();
    let frontier = [fromSlug];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
        const nextFrontier: string[] = [];

        for (const current of frontier) {
            const neighbors = getNeighbors(current);

            for (const neighbor of neighbors) {
                if (visited.has(neighbor)) continue;
                visited.add(neighbor);

                /** Find the edge connecting current → neighbor. */
                const outEdges = getEdgesFrom(current);
                const inEdges = getEdgesTo(current);
                const edge =
                    outEdges.find((e) => e.to_slug === neighbor) || inEdges.find((e) => e.from_slug === neighbor);

                if (edge) parent.set(neighbor, { slug: current, edge });

                if (neighbor === toSlug) {
                    return reconstructPath(fromSlug, toSlug, parent);
                }

                nextFrontier.push(neighbor);
            }
        }

        frontier = nextFrontier;
    }

    return null;
}

function reconstructPath(from: string, to: string, parent: Map<string, { slug: string; edge: Edge }>): PathResult {
    const path: string[] = [to];
    const edges: Edge[] = [];
    let current = to;

    while (current !== from) {
        const p = parent.get(current);
        if (!p) break;
        path.unshift(p.slug);
        edges.unshift(p.edge);
        current = p.slug;
    }

    return { path, edges, hops: path.length - 1 };
}

/**
 * Get all nodes within N hops of a concept.
 */
export function neighborhood(slug: string, depth = 2): NeighborhoodResult {
    const nodes = new Set<string>([slug]);
    const allEdges: Edge[] = [];
    let frontier = [slug];

    for (let d = 0; d < depth && frontier.length > 0; d++) {
        const nextFrontier: string[] = [];

        for (const current of frontier) {
            const outEdges = getEdgesFrom(current);
            const inEdges = getEdgesTo(current);

            for (const edge of [...outEdges, ...inEdges]) {
                const neighbor = edge.from_slug === current ? edge.to_slug : edge.from_slug;
                allEdges.push(edge);

                if (!nodes.has(neighbor)) {
                    nodes.add(neighbor);
                    nextFrontier.push(neighbor);
                }
            }
        }

        frontier = nextFrontier;
    }

    return { center: slug, nodes, edges: allEdges, depth };
}

/**
 * Find connected components in the concept graph.
 * Returns arrays of slugs, each array is one component.
 */
export function connectedComponents(): string[][] {
    const concepts = listConcepts();
    const visited = new Set<string>();
    const components: string[][] = [];

    for (const concept of concepts) {
        if (visited.has(concept.slug)) continue;

        const component: string[] = [];
        const queue = [concept.slug];

        while (queue.length > 0) {
            const current = queue.shift()!;
            if (visited.has(current)) continue;
            visited.add(current);
            component.push(current);

            for (const neighbor of getNeighbors(current)) {
                if (!visited.has(neighbor)) queue.push(neighbor);
            }
        }

        components.push(component);
    }

    return components.sort((a, b) => b.length - a.length);
}

/**
 * Get the top N concepts by edge count (god nodes).
 */
export function godNodes(limit = 10): { slug: string; name: string; edgeCount: number }[] {
    const rows = getDb()
        .prepare(
            `SELECT c.slug, c.name,
                (SELECT COUNT(*) FROM edges WHERE from_slug = c.slug OR to_slug = c.slug) as edge_count
             FROM concepts c
             ORDER BY edge_count DESC
             LIMIT ?`,
        )
        .all(limit) as { slug: string; name: string; edge_count: number }[];

    return rows.map((r) => ({ slug: r.slug, name: r.name, edgeCount: r.edge_count }));
}
