import {
    getSource as storeGetSource,
    listSources as storeListSources,
    countSources,
    countSourcesByType,
} from '../store/sources.js';
import type { Source, SourceType } from '../types/index.js';
import { LumenError } from './errors.js';

export type SourcesListOptions = {
    /** Cap results. Defaults to everything (no limit). */
    limit?: number;
    /** ISO timestamp — return sources added strictly after this time. */
    since?: string;
    type?: SourceType;
    /** Filter by compilation status. `true` → compiled; `false` → uncompiled; omit → both. */
    compiled?: boolean;
};

export type SourcesApi = {
    get(id: string): Source | null;
    list(opts?: SourcesListOptions): Source[];
    count(): number;
    countByType(): Record<string, number>;
};

/**
 * Library surface for browsing the `sources` table. Agents typically reach
 * these methods after a citation from `ask()` or a path from `graph.report()`
 * — they hold an id or slug and want the full row.
 *
 * `list()` extends the raw store variant with `limit` + `since` filtering so
 * an agent can say "what's been added this week?" without an in-memory scan.
 */
export function createSourcesApi(): SourcesApi {
    return {
        get(id: string): Source | null {
            requireString(id, 'sources.get', 'id');
            return storeGetSource(id);
        },

        list(opts: SourcesListOptions = {}): Source[] {
            /** Base filtering stays inside the store function (type + compiled).
             *  `since` + `limit` are layered here because the store helper
             *  doesn't support them and the data volume is small enough that
             *  a second in-memory filter is cheaper than adding SQL dialects. */
            let rows = storeListSources({ type: opts.type, compiled: opts.compiled });

            if (opts.since) {
                validateIsoTimestamp(opts.since, 'sources.list', 'since');
                rows = rows.filter((s) => s.added_at > opts.since!);
            }
            if (opts.limit !== undefined) {
                const n = coerceLimit(opts.limit, 'sources.list', 'limit');
                rows = rows.slice(0, n);
            }
            return rows;
        },

        count(): number {
            return countSources();
        },

        countByType(): Record<string, number> {
            return countSourcesByType();
        },
    };
}

/* ─── helpers shared with other lib modules via local copies
       (kept inline so each lib file stays self-contained) ─── */

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

function validateIsoTimestamp(raw: string, fn: string, field: string): void {
    /** Accept anything parseable by Date — we compare string-wise for perf
     *  but want to reject obviously-bad input early so filters aren't silent. */
    if (Number.isNaN(Date.parse(raw))) {
        throw new LumenError(
            'INVALID_ARGUMENT',
            `${fn}: \`${field}\` must be a valid ISO timestamp`,
        );
    }
}
