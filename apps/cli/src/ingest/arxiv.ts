import type { ExtractionResult } from '../types/index.js';
import { IngestError, errorFromStatus } from './errors.js';
import { extractPdf } from './pdf.js';

/**
 * Fetch an arXiv paper's metadata via the Atom API, then download
 * and extract the PDF for full text.
 */
export async function extractArxiv(input: string): Promise<ExtractionResult> {
    const arxivId = parseArxivId(input);
    if (!arxivId) throw new IngestError('MALFORMED', `Invalid arXiv URL or ID: ${input}`);

    /** Fetch metadata from the arXiv Atom API. */
    const apiUrl = `https://export.arxiv.org/api/query?id_list=${arxivId}`;
    let res: Response;
    try {
        res = await fetch(apiUrl, { signal: AbortSignal.timeout(15000) });
    } catch (err) {
        if (err instanceof DOMException && err.name === 'TimeoutError') {
            throw new IngestError('TIMEOUT', `arXiv API timed out for: ${arxivId}`, {
                retryable: true,
            });
        }
        throw new IngestError('NETWORK', `Failed to reach arXiv API: ${arxivId}`, {
            retryable: true,
        });
    }
    if (!res.ok) throw errorFromStatus(res.status, apiUrl);

    const xml = await res.text();

    /** Detect invalid paper IDs (arXiv returns XML with no entries). */
    if (!xml.includes('<entry>')) {
        throw new IngestError('NOT_FOUND', `No arXiv paper found for ID: ${arxivId}`);
    }

    const title =
        xml
            .match(/<title[^>]*>([\s\S]*?)<\/title>/g)?.[1]
            ?.replace(/<\/?title>/g, '')
            .trim() || `arXiv:${arxivId}`;
    const summary = xml.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1]?.trim() || '';
    const authors = [...xml.matchAll(/<name>(.*?)<\/name>/g)].map((m) => m[1]);
    const published = xml.match(/<published>(.*?)<\/published>/)?.[1] || null;
    const updated = xml.match(/<updated>(.*?)<\/updated>/)?.[1] || null;
    const categories = [...xml.matchAll(/term="([^"]+)"/g)].map((m) => m[1]);

    /** Download and extract the PDF for full content. */
    const pdfUrl = `https://arxiv.org/pdf/${arxivId}.pdf`;
    let fullText: string;
    try {
        const pdfResult = await extractPdf(pdfUrl);
        fullText = pdfResult.content;
    } catch (err) {
        /** Fall back to abstract-only if PDF extraction fails. */
        const reason = err instanceof IngestError ? err.code : 'unknown';
        fullText = `# ${title}\n\n## Abstract\n\n${summary}\n\n---\n*Note: PDF extraction failed (${reason}). Only the abstract is available.*`;
    }

    return {
        title: cleanTitle(title),
        content: fullText,
        url: `https://arxiv.org/abs/${arxivId}`,
        source_type: 'arxiv',
        language: 'en',
        metadata: {
            arxiv_id: arxivId,
            authors,
            published,
            updated,
            categories,
            abstract: summary,
            pdf_url: pdfUrl,
        },
    };
}

/** Parse an arXiv ID from various formats: full URL, abs URL, or raw ID. */
function parseArxivId(input: string): string | null {
    /** Raw ID formats: 2301.12345, hep-th/0601001 */
    const rawMatch = input.match(/^(\d{4}\.\d{4,5}(v\d+)?|[a-z-]+\/\d{7}(v\d+)?)$/);
    if (rawMatch) return rawMatch[1];

    /** URL formats: arxiv.org/abs/..., arxiv.org/pdf/... */
    const urlMatch = input.match(/arxiv\.org\/(?:abs|pdf)\/([^\s/?#]+)/);
    if (urlMatch) return urlMatch[1].replace(/\.pdf$/, '');

    return null;
}

/** Collapse whitespace and newlines in arXiv titles. */
function cleanTitle(title: string): string {
    return title.replace(/\s+/g, ' ').trim();
}
