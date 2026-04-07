import { extract } from '@extractus/article-extractor';
import type { ExtractionResult } from '../types/index.js';

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

    /** Fallback: raw fetch with basic HTML stripping. */
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);

    const html = await res.text();
    const title = html.match(/<title[^>]*>(.*?)<\/title>/i)?.[1]?.trim() || titleFromUrl(url);
    const body = extractBodyText(html);

    if (!body.trim()) throw new Error(`No extractable content from ${url}`);

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
