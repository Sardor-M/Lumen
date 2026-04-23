import { readFileSync, existsSync } from 'node:fs';
import type { Command } from 'commander';
import { ingestInput, detectSourceType } from '../ingest/file.js';
import { IngestError } from '../ingest/errors.js';
import { chunk } from '../chunker/index.js';
import { getDb } from '../store/database.js';
import { insertSource } from '../store/sources.js';
import { insertChunks } from '../store/chunks.js';
import { sourceExists } from '../store/dedup.js';
import { shortId, contentHash } from '../utils/hash.js';
import { audit } from '../utils/logger.js';
import * as log from '../utils/logger.js';
import { loadConfig } from '../utils/config.js';

type AddOptions = {
    type?: string;
    from?: string;
    asDataset?: boolean;
    ocr?: boolean;
};

export function registerAdd(program: Command): void {
    program
        .command('add [inputs...]')
        .description(
            'Ingest URLs, PDFs, YouTube videos, arXiv papers, files, folders, code repos, datasets, or images',
        )
        .option(
            '-t, --type <type>',
            'Force source type (url, pdf, youtube, arxiv, file, folder, code, dataset, image)',
        )
        .option('-f, --from <file>', 'Read inputs from a file (one per line)')
        .option('--as-dataset', 'Force dataset handling for ambiguous text files')
        .option('--no-ocr', 'Skip OCR when ingesting images (metadata-only)')
        .action(async (inputs: string[], opts: AddOptions) => {
            const config = loadConfig();
            const db = getDb();

            const ingestOptions = {
                ocr: opts.ocr,
                as_dataset: opts.asDataset,
            };

            /** Collect all inputs from args + file. */
            const allInputs = [...inputs];

            if (opts.from) {
                if (!existsSync(opts.from)) {
                    log.error(`File not found: ${opts.from}`);
                    process.exitCode = 1;
                    return;
                }
                const lines = readFileSync(opts.from, 'utf-8')
                    .split('\n')
                    .map((l) => l.trim())
                    .filter((l) => l && !l.startsWith('#'));
                allInputs.push(...lines);
            }

            if (allInputs.length === 0) {
                log.error('No inputs provided. Usage: lumen add <url|file|folder> [more...]');
                log.dim('  Or: lumen add --from sources.txt');
                process.exitCode = 1;
                return;
            }

            let added = 0;
            let skipped = 0;
            let failed = 0;

            for (const input of allInputs) {
                try {
                    const sourceType = opts.type || detectSourceType(input, ingestOptions);
                    log.info(
                        `[${added + skipped + failed + 1}/${allInputs.length}] ${sourceType}: ${input}`,
                    );

                    const result = await ingestInput(input, ingestOptions);

                    /** Check for duplicate content. */
                    const existingId = sourceExists(db, result.content);
                    if (existingId) {
                        log.warn(`Skipped (duplicate): ${result.title}`);
                        skipped++;
                        continue;
                    }

                    const id = shortId(result.content);
                    const hash = contentHash(result.content);
                    const wordCount = result.content.split(/\s+/).length;

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

                    log.success(
                        `Added "${result.title}" (${chunks.length} chunks, ${wordCount} words)`,
                    );
                    added++;
                } catch (err) {
                    failed++;
                    if (err instanceof IngestError) {
                        log.error(`[${err.code}] ${err.message}`);
                        if (err.hint) log.dim(`  Hint: ${err.hint}`);
                    } else {
                        log.error(err instanceof Error ? err.message : String(err));
                    }
                }
            }

            /** Summary for batch operations. */
            if (allInputs.length > 1) {
                console.log();
                log.heading('Summary');
                log.table({
                    Added: added,
                    Skipped: skipped,
                    Failed: failed,
                    Total: allInputs.length,
                });
            }

            if (failed > 0) process.exitCode = 1;
        });
}
