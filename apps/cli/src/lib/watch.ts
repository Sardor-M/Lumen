import {
    deleteConnector,
    getConnector,
    insertConnector,
    listConnectors,
} from '../store/connectors.js';
import {
    initConnectors,
    runAll,
    runDue,
    runOne,
    getHandler,
    listHandlerTypes,
} from '../connectors/index.js';
import type { PullSummary } from '../connectors/index.js';
import type { Connector, ConnectorType } from '../types/index.js';
import { LumenError } from './errors.js';

const DEFAULT_INTERVAL_SECONDS = 3600;
const MIN_INTERVAL_SECONDS = 60;
const MAX_INTERVAL_SECONDS = 86400 * 7;

export type WatchAddOptions = {
    type: string;
    target: string;
    interval?: number;
    name?: string;
    /** Handler-specific options forwarded to `parseTarget` (e.g. arxiv `max_results`). */
    options?: Record<string, unknown>;
};

export type WatchApi = {
    add(opts: WatchAddOptions): Connector;
    list(opts?: { type?: ConnectorType }): Connector[];
    get(id: string): Connector | null;
    remove(id: string): boolean;
    pull(id: string): Promise<PullSummary>;
    /** Run every connector unconditionally — ignores `interval`. */
    run(): Promise<PullSummary[]>;
    /** Run only connectors whose `interval` has elapsed. */
    runDue(): Promise<PullSummary[]>;
    handlerTypes(): ConnectorType[];
};

/**
 * Library-facing wrapper over the connectors subsystem.
 *
 * Handlers are registered lazily on first use via `initConnectors()`. All
 * methods throw `LumenError` for validation problems; downstream pull
 * failures surface on the `PullSummary.error` field, mirroring CLI
 * behaviour.
 */
export function createWatchApi(): WatchApi {
    return {
        add(opts: WatchAddOptions): Connector {
            initConnectors();
            const type = validateType(opts.type);
            const interval = parseInterval(opts.interval);
            const target = (opts.target ?? '').trim();
            if (!target) {
                throw new LumenError('INVALID_ARGUMENT', 'watch.add(): `target` is required');
            }

            const handler = getHandler(type);
            if (!handler) {
                /** validateType already checked the registry, so this is a
                 *  truly unregistered handler (build skew). */
                throw new LumenError(
                    'UNKNOWN',
                    `Connector type "${type}" has no registered handler`,
                );
            }

            const parsed = handler.parseTarget(target, opts.options ?? {});
            if (getConnector(parsed.id)) {
                throw new LumenError('DUPLICATE', `Connector already exists: ${parsed.id}`);
            }

            const connector: Connector = {
                id: parsed.id,
                type,
                name: opts.name ?? parsed.name,
                config: JSON.stringify(parsed.config),
                state: JSON.stringify(parsed.initialState),
                interval_seconds: interval,
                last_run_at: null,
                last_error: null,
                created_at: new Date().toISOString(),
            };
            insertConnector(connector);
            return connector;
        },

        list(opts?: { type?: ConnectorType }): Connector[] {
            return listConnectors(opts);
        },

        get(id: string): Connector | null {
            return getConnector(id);
        },

        remove(id: string): boolean {
            return deleteConnector(id);
        },

        async pull(id: string): Promise<PullSummary> {
            initConnectors();
            return runOne(id);
        },

        async run(): Promise<PullSummary[]> {
            initConnectors();
            return runAll();
        },

        async runDue(): Promise<PullSummary[]> {
            initConnectors();
            return runDue();
        },

        handlerTypes(): ConnectorType[] {
            return listHandlerTypes();
        },
    };
}

function validateType(raw: string): ConnectorType {
    if (typeof raw !== 'string' || !raw) {
        throw new LumenError('INVALID_ARGUMENT', 'watch.add(): `type` is required');
    }
    /** Call `initConnectors()` before invoking — the registry is the single
     *  source of truth for which connector types actually have handlers,
     *  avoiding drift between a hard-coded list here and the real registry. */
    const registered = listHandlerTypes();
    if (!registered.includes(raw as ConnectorType)) {
        throw new LumenError(
            'INVALID_ARGUMENT',
            `Unknown connector type "${raw}". Known: ${registered.join(', ') || '(none registered)'}`,
        );
    }
    return raw as ConnectorType;
}

function parseInterval(raw: number | undefined): number {
    if (raw === undefined) return DEFAULT_INTERVAL_SECONDS;
    if (!Number.isInteger(raw)) {
        throw new LumenError('INVALID_ARGUMENT', `interval must be an integer, got ${raw}`);
    }
    if (raw < MIN_INTERVAL_SECONDS || raw > MAX_INTERVAL_SECONDS) {
        throw new LumenError(
            'INVALID_ARGUMENT',
            `interval must be between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS} seconds`,
        );
    }
    return raw;
}
