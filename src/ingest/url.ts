import { extract } from '@extractus/article-extractor';
import type { ExtractionResult } from '../types/index.js';
import { IngestError, errorFromStatus, detectJsRendered, detectPaywall } from './errors.js';

/**
 * Extract article content from a URL.
 * Primary: @extractus/article-extractor (readability-based).
 * Fallback: raw fetch + basic HTML stripping.
 */
export async function extractUrl(url: string): Promise<ExtractionResult> {
    const article = await extract(url).catch(() => null);

    if (article?.content) {
        return {
            title: article.title || titleFromUrl(url),
            content: article.content,
            url,
            source_type: 'url',
            language: ((article as Record<string, unknown>).language as string) || null,
            metadata: {
                author: article.author || null,
                published: article.published || null,
                description: article.description || null,
                source: article.source || null,
            },
        };
    }

    /** Fallback: raw fetch with specific error detection. */
    let res: Response;
    try {
        res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Lumen/1.0)' },
            signal: AbortSignal.timeout(15000),
        });
    } catch (err) {
        if (err instanceof DOMException && err.name === 'TimeoutError') {
            throw new IngestError('TIMEOUT', `Request timed out: ${url}`, {
                retryable: true,
                hint: 'The server took too long to respond. Try again later.',
            });
        }
        throw new IngestError('NETWORK', `Network error fetching ${url}: ${err instanceof Error ? err.message : err}`, {
            retryable: true,
        });
    }

    if (!res.ok) throw errorFromStatus(res.status, url);

    const html = await res.text();

    /** Detect JS-rendered pages with no server-side content. */
    if (detectJsRendered(html)) {
        throw new IngestError('JS_RENDERED', `Page is JS-rendered with no server-side content: ${url}`, {
            hint: 'This page requires JavaScript to render. Try saving it as HTML from your browser and using `lumen add ./page.html`.',
        });
    }

    /** Detect paywalled content. */
    if (detectPaywall(html)) {
        throw new IngestError('PAYWALL', `Page appears to be behind a paywall: ${url}`, {
            hint: 'Save the full article from your browser and use `lumen add ./article.html`.',
        });
    }

    const title = html.match(/<title[^>]*>(.*?)<\/title>/i)?.[1]?.trim() || titleFromUrl(url);
    const body = extractBodyText(html);

    if (!body.trim()) {
        throw new IngestError('NO_CONTENT', `No extractable text content from ${url}`, {
            hint: 'The page may be an image, video, or empty. Check the URL is correct.',
        });
    }

    return {
        title,
        content: body,
        url,
        source_type: 'url',
        language: null,
        metadata: { fallback: true },
    };
}

/** Strip HTML tags and collapse whitespace for the fallback extractor. */
function extractBodyText(html: string): string {
    let text = html;
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');
    text = text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');
    text = text.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');
    text = text.replace(/<[^>]+>/g, ' ');
    text = text.replace(/&nbsp;/g, ' ');
    text = text.replace(/\s+/g, ' ');
    return text.trim();
}

function titleFromUrl(url: string): string {
    try {
        const { hostname, pathname } = new URL(url);
        const slug = pathname.split('/').filter(Boolean).pop() || hostname;
        return decodeURIComponent(slug).replace(/[-_]/g, ' ');
    } catch {
        return url;
    }
}
