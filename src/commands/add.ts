import type { Command } from 'commander';
import { ingestInput, detectSourceType } from '../ingest/file.js';
import { chunk } from '../chunker/index.js';
import { getDb } from '../store/database.js';
import { insertSource } from '../store/sources.js';
import { insertChunks } from '../store/chunks.js';
import { sourceExists } from '../store/dedup.js';
import { shortId, contentHash } from '../utils/hash.js';
import { audit } from '../utils/logger.js';
import * as log from '../utils/logger.js';
import { loadConfig } from '../utils/config.js';

export function registerAdd(program: Command): void {
    program
        .command('add <input>')
        .description('Ingest a URL, PDF, YouTube video, arXiv paper, file, or folder')
        .option('-t, --type <type>', 'Force source type (url, pdf, youtube, arxiv, file, folder)')
        .action(async (input: string, opts: { type?: string }) => {
            try {
                const config = loadConfig();
                const db = getDb();

                const sourceType = opts.type || detectSourceType(input);
                log.info(`Detecting source type: ${sourceType}`);

                log.info(`Extracting content from ${input}...`);
                const result = await ingestInput(input);

                /** Check for duplicate content. */
                const existingId = sourceExists(db, result.content);
                if (existingId) {
                    log.warn(`Content already exists (source: ${existingId}). Skipping.`);
                    return;
                }

                const id = shortId(result.content);
                const hash = contentHash(result.content);
                const wordCount = result.content.split(/\s+/).length;

                /** Store the source. */
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

                /** Chunk the content. */
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

                log.success(`Added "${result.title}"`);
                log.table({
                    'Source ID': id,
                    Type: result.source_type,
                    Words: wordCount,
                    Chunks: chunks.length,
                });
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });
}
