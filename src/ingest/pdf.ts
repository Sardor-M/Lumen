import { readFileSync } from 'node:fs';
import pdf from 'pdf-parse';
import type { ExtractionResult } from '../types/index.js';

/**
 * Extract text content and metadata from a PDF file.
 * Supports both local file paths and URLs.
 */
export async function extractPdf(source: string): Promise<ExtractionResult> {
    let buffer: Buffer;

    if (source.startsWith('http://') || source.startsWith('https://')) {
        const res = await fetch(source);
        if (!res.ok) throw new Error(`Failed to fetch PDF: ${res.status} ${res.statusText}`);
        buffer = Buffer.from(await res.arrayBuffer());
    } else {
        buffer = readFileSync(source);
    }

    const data = await pdf(buffer);

    if (!data.text?.trim()) throw new Error(`No extractable text in PDF: ${source}`);

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
