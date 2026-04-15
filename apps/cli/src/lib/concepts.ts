import {
    getConcept as storeGetConcept,
    listConcepts as storeListConcepts,
    countConcepts,
    getConceptSources,
} from '../store/concepts.js';
import { getEdgesFrom, getEdgesTo } from '../store/edges.js';
import { getSource } from '../store/sources.js';
import type { Concept, RelationType } from '../types/index.js';
import { LumenError } from './errors.js';

export type EdgeRef = {
    /** The peer concept slug — `to` for outgoing, `from` for incoming. */
    peer: string;
    relation: RelationType;
    weight: number;
    /** The source the edge was extracted from, if any. */
    source_id: string | null;
};

export type ConceptDetail = Concept & {
    outgoing_edges: EdgeRef[];
    incoming_edges: EdgeRef[];
    sources: Array<{ id: string; title: string }>;
};

export type ConceptsListOptions = {
    /** Cap results. Defaults to all concepts. */
    limit?: number;
};

export type ConceptsApi = {
    /** Returns a concept with its full edge neighborhood + source titles in one call. */
    get(slug: string): ConceptDetail | null;
    list(opts?: ConceptsListOptions): Concept[];
    count(): number;
};

/**
 * Concepts live at the heart of a Lumen knowledge graph — every `ask()`
 * citation, every `graph.path()` hop, and every profile god-node surfaces
 * a concept slug. This API hydrates a slug into the full context an agent
 * needs to reason about it (summary, article, mention count, incoming +
 * outgoing edges, and the sources that support it) without forcing the
 * caller to wire five separate store calls.
 */
export function createConceptsApi(): ConceptsApi {
    return {
        get(slug: string): ConceptDetail | null {
            requireString(slug, 'concepts.get', 'slug');

            const concept = storeGetConcept(slug);
            if (!concept) return null;

            const outgoing: EdgeRef[] = getEdgesFrom(slug).map((e) => ({
                peer: e.to_slug,
                relation: e.relation,
                weight: e.weight,
                source_id: e.source_id,
            }));

            const incoming: EdgeRef[] = getEdgesTo(slug).map((e) => ({
                peer: e.from_slug,
                relation: e.relation,
                weight: e.weight,
                source_id: e.source_id,
            }));

            /** Resolve titles eagerly so agents can render "supported by:
             *  <titles>" without a second round-trip. Source rows are small
             *  and concepts rarely have more than a handful of supporters. */
            const sources = getConceptSources(slug).map((id) => {
                const src = getSource(id);
                return { id, title: src?.title ?? id };
            });

            return {
                ...concept,
                outgoing_edges: outgoing,
                incoming_edges: incoming,
                sources,
            };
        },

        list(opts: ConceptsListOptions = {}): Concept[] {
            const rows = storeListConcepts();
            if (opts.limit === undefined) return rows;
            const n = coerceLimit(opts.limit, 'concepts.list', 'limit');
            return rows.slice(0, n);
        },

        count(): number {
            return countConcepts();
        },
    };
}

function requireString(v: unknown, fn: string, field: string): void {
    if (typeof v !== 'string' || v.length === 0) {
        throw new LumenError('INVALID_ARGUMENT', `${fn}: \`${field}\` must be a non-empty string`);
    }
}

function coerceLimit(raw: unknown, fn: string, field: string): number {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
        throw new LumenError('INVALID_ARGUMENT', `${fn}: \`${field}\` must be a positive integer`);
    }
    return raw;
}
