import { readFileSync, existsSync } from 'node:fs';
import pdf from 'pdf-parse';
import type { ExtractionResult } from '../types/index.js';
import { IngestError, errorFromStatus } from './errors.js';

/**
 * Extract text content and metadata from a PDF file.
 * Supports both local file paths and URLs.
 */
export async function extractPdf(source: string): Promise<ExtractionResult> {
    let buffer: Buffer;

    if (source.startsWith('http://') || source.startsWith('https://')) {
        let res: Response;
        try {
            res = await fetch(source, { signal: AbortSignal.timeout(30000) });
        } catch (err) {
            if (err instanceof DOMException && err.name === 'TimeoutError') {
                throw new IngestError('TIMEOUT', `PDF download timed out: ${source}`, {
                    retryable: true,
                    hint: 'The PDF is large or the server is slow. Try downloading it manually.',
                });
            }
            throw new IngestError('NETWORK', `Failed to download PDF: ${source}`, {
                retryable: true,
            });
        }
        if (!res.ok) throw errorFromStatus(res.status, source);
        buffer = Buffer.from(await res.arrayBuffer());
    } else {
        if (!existsSync(source)) {
            throw new IngestError('NOT_FOUND', `File not found: ${source}`);
        }
        buffer = readFileSync(source);
    }

    if (buffer.length === 0) {
        throw new IngestError('NO_CONTENT', `PDF file is empty: ${source}`);
    }

    let data: Awaited<ReturnType<typeof pdf>>;
    try {
        data = await withSilencedPdfWarnings(() => pdf(buffer));
    } catch (err) {
        throw new IngestError('MALFORMED', `Failed to parse PDF: ${source}`, {
            hint: `The PDF may be corrupted, encrypted, or scanned (image-only). Error: ${err instanceof Error ? err.message : err}`,
        });
    }

    if (!data.text?.trim()) {
        throw new IngestError('NO_CONTENT', `No extractable text in PDF: ${source}`, {
            hint: 'This PDF may contain only scanned images. OCR is not yet supported.',
        });
    }

    return {
        title: data.info?.Title || filenameFromPath(source),
        content: data.text,
        url: source.startsWith('http') ? source : null,
        source_type: 'pdf',
        language: null,
        metadata: {
            pages: data.numpages,
            author: data.info?.Author || null,
            creator: data.info?.Creator || null,
            producer: data.info?.Producer || null,
            creation_date: data.info?.CreationDate || null,
        },
    };
}

function filenameFromPath(path: string): string {
    const name = path.split('/').pop() || path;
    return name.replace(/\.pdf$/i, '').replace(/[-_]/g, ' ');
}

/**
 *  The pdfjs build bundled with pdf-parse writes parser diagnostics
 *  ("Warning: TT: undefined function: N", "Warning: Empty FlateDecode stream",
 *  "Warning: Could not find a preferred cmap table", …) directly via
 *  `console.log` with no verbosity knob reachable from the public API. These
 *  are harmless for text extraction but spam the CLI. Swallow only those
 *  prefixed lines during parsing; unrelated log calls still pass through.
 */
async function withSilencedPdfWarnings<T>(fn: () => Promise<T>): Promise<T> {
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
        const first = args[0];
        if (
            typeof first === 'string' &&
            (first.startsWith('Warning:') || first.startsWith('Info:'))
        ) {
            return;
        }
        originalLog(...args);
    };
    try {
        return await fn();
    } finally {
        console.log = originalLog;
    }
}
