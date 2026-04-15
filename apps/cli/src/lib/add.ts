import { ingestInput } from '../ingest/file.js';
import { chunk } from '../chunker/index.js';
import { getDb } from '../store/database.js';
import { insertSource } from '../store/sources.js';
import { insertChunks } from '../store/chunks.js';
import { sourceExists } from '../store/dedup.js';
import { shortId, contentHash } from '../utils/hash.js';
import { audit } from '../utils/logger.js';
import { loadConfig } from '../utils/config.js';
import { invalidateProfile } from '../profile/invalidate.js';
import type { SourceType } from '../types/index.js';
import { LumenError } from './errors.js';

/**
 * Accept a bare string or an object form for forward-compatibility —
 * additional options (chunker overrides, metadata, etc.) can go on the
 * object without breaking callers.
 */
export type AddInput = string | { input: string };

export type AddResult =
    | {
          status: 'added';
          id: string;
          title: string;
          source_type: SourceType;
          chunks: number;
          words: number;
      }
    | {
          status: 'skipped';
          reason: 'duplicate';
          id: string;
          title: string;
      };

/**
 * Pure ingest pipeline: fetch → dedupe → insert source → chunk → insert chunks.
 *
 * Returns an `AddResult` on success (including the `'skipped'` dedup case so
 * the caller can distinguish it from a fresh insert). Throws `IngestError`
 * for network/parse failures and `LumenError` for invalid arguments. The
 * caller is responsible for retries and user-facing messaging.
 *
 * The CLI's `lumen add` is a loop over this function with log wrapping.
 */
export async function addSource(input: AddInput): Promise<AddResult> {
    const raw = normalize(input);
    if (!raw) {
        throw new LumenError('INVALID_ARGUMENT', 'add(): `input` must be a non-empty string');
    }

    const config = loadConfig();
    const db = getDb();

    const result = await ingestInput(raw);

    const existingId = sourceExists(db, result.content);
    if (existingId) {
        return {
            status: 'skipped',
            reason: 'duplicate',
            id: existingId,
            title: result.title,
        };
    }

    const id = shortId(result.content);
    const hash = contentHash(result.content);
    const wordCount = result.content.split(/\s+/).filter(Boolean).length;

    insertSource({
        id,
        title: result.title,
        url: result.url,
        content: result.content,
        content_hash: hash,
        source_type: result.source_type,
        added_at: new Date().toISOString(),
        compiled_at: null,
        word_count: wordCount,
        language: result.language,
        metadata: result.metadata ? JSON.stringify(result.metadata) : null,
    });

    const chunks = chunk(result.content, id, {
        minTokens: config.chunker.min_chunk_tokens,
        maxTokens: config.chunker.max_chunk_tokens,
    });
    insertChunks(chunks);

    audit('source:add', {
        id,
        title: result.title,
        source_type: result.source_type,
        chunks: chunks.length,
        words: wordCount,
    });

    /** Cached profile is now stale — the next `profile()` read will rebuild. */
    invalidateProfile();

    return {
        status: 'added',
        id,
        title: result.title,
        source_type: result.source_type,
        chunks: chunks.length,
        words: wordCount,
    };
}

function normalize(input: AddInput): string {
    if (typeof input === 'string') return input.trim();
    if (input && typeof input === 'object' && typeof input.input === 'string') {
        return input.input.trim();
    }
    return '';
}
