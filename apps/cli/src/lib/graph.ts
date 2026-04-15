import { shortestPath, neighborhood, godNodes, connectedComponents } from '../graph/engine.js';
import { pagerank } from '../graph/pagerank.js';
import { detectCommunities } from '../graph/cluster.js';
import { toJson, toDot } from '../graph/visualize.js';
import { generateReport } from '../graph/report.js';
import { LumenError } from './errors.js';

export type GraphApi = {
    godNodes(limit?: number): ReturnType<typeof godNodes>;
    pagerank(opts?: Parameters<typeof pagerank>[0]): ReturnType<typeof pagerank>;
    neighbors(slug: string, depth?: number): ReturnType<typeof neighborhood>;
    path(from: string, to: string, maxDepth?: number): ReturnType<typeof shortestPath>;
    communities(maxIterations?: number): ReturnType<typeof detectCommunities>;
    components(): ReturnType<typeof connectedComponents>;
    toJson(): ReturnType<typeof toJson>;
    toDot(): string;
    report(): string;
};

/**
 * Namespaced graph operations. All functions read from the store
 * singleton; callers should not instantiate multiple graph APIs.
 */
export function createGraphApi(): GraphApi {
    return {
        godNodes(limit = 10) {
            return godNodes(limit);
        },

        pagerank(opts) {
            return pagerank(opts);
        },

        neighbors(slug: string, depth = 2) {
            requireSlug(slug, 'graph.neighbors');
            return neighborhood(slug, depth);
        },

        path(from: string, to: string, maxDepth = 6) {
            requireSlug(from, 'graph.path (from)');
            requireSlug(to, 'graph.path (to)');
            return shortestPath(from, to, maxDepth);
        },

        communities(maxIterations = 50) {
            return detectCommunities(maxIterations);
        },

        components() {
            return connectedComponents();
        },

        toJson() {
            return toJson();
        },

        toDot() {
            return toDot();
        },

        report() {
            return generateReport();
        },
    };
}

function requireSlug(slug: string, fn: string): void {
    if (!slug || typeof slug !== 'string') {
        throw new LumenError('INVALID_ARGUMENT', `${fn}: slug must be a non-empty string`);
    }
}
