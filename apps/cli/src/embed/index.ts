import { getDb } from '../store/database.js';
import { isVecAvailable } from '../store/database.js';
import type { LumenConfig } from '../types/index.js';
import { embedBatch, serializeVector } from './client.js';

/**
 * Embed all chunks that have not yet been embedded.
 * Processes in batches of `config.embedding.batch_size`.
 * Returns the number of chunks that were embedded.
 */
export async function embedPending(config: LumenConfig): Promise<number> {
    if (config.embedding.provider === 'none') return 0;
    if (!isVecAvailable()) {
        throw new Error(
            'sqlite-vec extension not available on this platform. Vector search is disabled.',
        );
    }

    const db = getDb();

    const pending = db
        .prepare(`SELECT rowid, id, content FROM chunks WHERE embedded_at IS NULL`)
        .all() as { rowid: number; id: string; content: string }[];

    if (pending.length === 0) return 0;

    const { batch_size, model } = config.embedding;
    const now = new Date().toISOString();

    const insertVec = db.prepare(
        `INSERT OR REPLACE INTO vec_chunks(rowid, embedding) VALUES (?, ?)`,
    );
    const markEmbedded = db.prepare(
        `UPDATE chunks SET embedding_model = ?, embedded_at = ? WHERE rowid = ?`,
    );

    let total = 0;

    for (let i = 0; i < pending.length; i += batch_size) {
        const batch = pending.slice(i, i + batch_size);
        const vectors = await embedBatch(
            batch.map((c) => c.content),
            config.embedding,
        );

        const runBatch = db.transaction(() => {
            for (let j = 0; j < batch.length; j++) {
                const row = batch[j];
                const vec = vectors[j];
                insertVec.run(row.rowid, serializeVector(vec));
                markEmbedded.run(model, now, row.rowid);
            }
        });

        runBatch();
        total += batch.length;
    }

    return total;
}

/**
 * Embed a single chunk immediately after it has been inserted.
 * No-op when embedding.provider is 'none' or sqlite-vec is unavailable.
 */
export async function embedChunk(
    chunkId: string,
    content: string,
    config: LumenConfig,
): Promise<void> {
    if (config.embedding.provider === 'none') return;
    if (!isVecAvailable()) return;

    const db = getDb();

    const row = db.prepare(`SELECT rowid FROM chunks WHERE id = ?`).get(chunkId) as
        | { rowid: number }
        | undefined;

    if (!row) return;

    const [vector] = await embedBatch([content], config.embedding);

    db.prepare(`INSERT OR REPLACE INTO vec_chunks(rowid, embedding) VALUES (?, ?)`).run(
        row.rowid,
        serializeVector(vector),
    );

    db.prepare(`UPDATE chunks SET embedding_model = ?, embedded_at = ? WHERE rowid = ?`).run(
        config.embedding.model,
        new Date().toISOString(),
        row.rowid,
    );
}

/**
 * Drop and recreate vec_chunks. Clears all embedding metadata from chunks.
 * Required when switching to a model with different output dimensions.
 */
export function resetVecTable(dimensions: number): void {
    if (!isVecAvailable()) return;
    const db = getDb();

    db.exec(`DROP TABLE IF EXISTS vec_chunks`);
    db.exec(`
        CREATE VIRTUAL TABLE vec_chunks USING vec0(
            embedding float[${dimensions}]
        )
    `);

    db.prepare(`UPDATE chunks SET embedded_at = NULL, embedding_model = NULL`).run();
}

/** Return embedding coverage stats for `lumen embed --status`. */
export function embeddingStats(): { total: number; embedded: number; pending: number } {
    const db = getDb();
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get() as { n: number }).n;
    const embedded = (
        db.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE embedded_at IS NOT NULL`).get() as {
            n: number;
        }
    ).n;
    return { total, embedded, pending: total - embedded };
}
