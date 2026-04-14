import { getDb } from '../store/database.js';
import {
    getConnector,
    listConnectors,
    dueConnectors,
    recordRunSuccess,
    recordRunFailure,
} from '../store/connectors.js';
import { insertSource } from '../store/sources.js';
import { insertChunks } from '../store/chunks.js';
import { sourceExists } from '../store/dedup.js';
import { chunk } from '../chunker/index.js';
import { shortId, contentHash } from '../utils/hash.js';
import { audit } from '../utils/logger.js';
import { getHandler } from './registry.js';
import type { Connector, ExtractionResult } from '../types/index.js';

export type PullSummary = {
    connector_id: string;
    connector_type: string;
    fetched: number;
    ingested: number;
    deduped: number;
    error: string | null;
};

/** Execute one connector — fetch, dedupe, chunk, store. Never throws; records
 *  failure state on the connector so the scheduler can display it. */
export async function runConnector(connector: Connector): Promise<PullSummary> {
    const handler = getHandler(connector.type);
    const summary: PullSummary = {
        connector_id: connector.id,
        connector_type: connector.type,
        fetched: 0,
        ingested: 0,
        deduped: 0,
        error: null,
    };

    if (!handler) {
        const msg = `No handler registered for connector type "${connector.type}"`;
        recordRunFailure(connector.id, msg);
        summary.error = msg;
        return summary;
    }

    try {
        const result = await handler.pull(connector);
        summary.fetched = result.new_items.length;

        for (const item of result.new_items) {
            if (ingestOne(item)) summary.ingested++;
            else summary.deduped++;
        }

        recordRunSuccess(connector.id, result.new_state);
        audit('connector:run', {
            id: connector.id,
            type: connector.type,
            fetched: summary.fetched,
            ingested: summary.ingested,
            deduped: summary.deduped,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recordRunFailure(connector.id, msg);
        summary.error = msg;
        audit('connector:error', { id: connector.id, type: connector.type, error: msg });
    }

    return summary;
}

/** Pull every registered connector whose interval has elapsed. */
export async function runDue(opts: { concurrency?: number } = {}): Promise<PullSummary[]> {
    return runMany(dueConnectors(), opts.concurrency ?? 1);
}

/** Pull all connectors regardless of interval. Useful for `lumen watch run`. */
export async function runAll(opts: { concurrency?: number } = {}): Promise<PullSummary[]> {
    return runMany(listConnectors(), opts.concurrency ?? 1);
}

async function runMany(items: Connector[], concurrency: number): Promise<PullSummary[]> {
    if (items.length === 0) return [];
    const limit = Math.max(1, concurrency);
    const results: PullSummary[] = new Array(items.length);
    let cursor = 0;

    async function worker() {
        while (cursor < items.length) {
            const i = cursor++;
            results[i] = await runConnector(items[i]);
        }
    }

    const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
    await Promise.all(workers);
    return results;
}

/** Pull a single connector by id. Throws if not found. */
export async function runOne(id: string): Promise<PullSummary> {
    const connector = getConnector(id);
    if (!connector) {
        throw new Error(`Connector not found: ${id}`);
    }
    return runConnector(connector);
}

/** Insert one extracted item if its content hash isn't already present.
 *  Returns true if inserted, false if deduped. */
function ingestOne(item: ExtractionResult): boolean {
    const db = getDb();
    const existing = sourceExists(db, item.content);
    if (existing) return false;

    const id = shortId(`${item.url ?? item.title}:${Date.now()}`);
    const hash = contentHash(item.content);
    const wordCount = item.content.split(/\s+/).filter(Boolean).length;

    insertSource({
        id,
        title: item.title,
        url: item.url,
        content: item.content,
        content_hash: hash,
        source_type: item.source_type,
        added_at: new Date().toISOString(),
        compiled_at: null,
        word_count: wordCount,
        language: item.language,
        metadata: item.metadata ? JSON.stringify(item.metadata) : null,
    });

    const chunks = chunk(item.content, id);
    insertChunks(chunks);
    return true;
}
