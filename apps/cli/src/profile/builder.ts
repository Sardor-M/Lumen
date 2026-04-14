import { countSources, listSources } from '../store/sources.js';
import { countConcepts, listConcepts } from '../store/concepts.js';
import { countEdges } from '../store/edges.js';
import { godNodes } from '../graph/engine.js';
import { pagerank } from '../graph/pagerank.js';
import { detectCommunities } from '../graph/cluster.js';
import { recentQueries, frequentTopics } from '../store/query-log.js';
import type { SourceType } from '../types/index.js';

type ProfileStatic = {
    god_nodes: Array<{ slug: string; name: string; edges: number }>;
    top_communities: Array<{ id: number; size: number; members: string[] }>;
    pagerank_top: Array<{ slug: string; name: string; score: number }>;
    total_sources: number;
    total_concepts: number;
    total_edges: number;
    graph_density: number;
};

type ProfileDynamic = {
    recent_sources: Array<{ id: string; title: string; type: SourceType; added_at: string }>;
    recent_concepts: Array<{ slug: string; name: string; created_at: string }>;
    last_compiled_at: string | null;
    pending_compilation: number;
    last_activity: string;
};

type ProfileLearned = {
    frequent_topics: Array<{ query_text: string; count: number }>;
    recent_queries: Array<{ tool_name: string; query_text: string | null; timestamp: string }>;
};

export type LumenProfile = {
    static: ProfileStatic;
    dynamic: ProfileDynamic;
    learned: ProfileLearned;
    generated_at: string;
};

export function buildProfile(): LumenProfile {
    const concepts = countConcepts();
    const edges = countEdges();
    const density = concepts > 1 ? (2 * edges) / (concepts * (concepts - 1)) : 0;

    const gods = godNodes(10).map((g) => ({
        slug: g.slug,
        name: g.name,
        edges: g.edgeCount,
    }));

    const communities = detectCommunities()
        .slice(0, 5)
        .map((c) => ({
            id: c.id,
            size: c.size,
            members: c.members.slice(0, 10),
        }));

    const pr = concepts > 0 ? pagerank().slice(0, 10) : [];

    const allSources = listSources();
    const recentSources = allSources
        .sort((a, b) => b.added_at.localeCompare(a.added_at))
        .slice(0, 5)
        .map((s) => ({
            id: s.id,
            title: s.title,
            type: s.source_type,
            added_at: s.added_at,
        }));

    const allConcepts = listConcepts();
    const recentConceptList = allConcepts
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 5)
        .map((c) => ({
            slug: c.slug,
            name: c.name,
            created_at: c.created_at,
        }));

    const compiled = allSources.filter((s) => s.compiled_at !== null);
    const lastCompiled =
        compiled.length > 0
            ? compiled.sort((a, b) => (b.compiled_at ?? '').localeCompare(a.compiled_at ?? ''))[0]
                  .compiled_at
            : null;
    const pending = allSources.filter((s) => s.compiled_at === null).length;

    const lastActivity =
        recentSources.length > 0 ? recentSources[0].added_at : new Date().toISOString();

    return {
        static: {
            god_nodes: gods,
            top_communities: communities,
            pagerank_top: pr,
            total_sources: countSources(),
            total_concepts: concepts,
            total_edges: edges,
            graph_density: Math.round(density * 10000) / 10000,
        },
        dynamic: {
            recent_sources: recentSources,
            recent_concepts: recentConceptList,
            last_compiled_at: lastCompiled,
            pending_compilation: pending,
            last_activity: lastActivity,
        },
        learned: {
            frequent_topics: frequentTopics(10),
            recent_queries: recentQueries(10),
        },
        generated_at: new Date().toISOString(),
    };
}
