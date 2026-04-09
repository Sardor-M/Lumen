import type { RawChunk } from './markdown.js';
import { chunkMarkdown } from './markdown.js';

/**
 * Chunk HTML content by stripping tags and falling through to the markdown chunker.
 * Most ingested HTML (from article-extractor) is already fairly clean.
 */
export function chunkHtml(html: string, minTokens = 50, maxTokens = 1000): RawChunk[] {
    const markdown = htmlToMarkdown(html);
    return chunkMarkdown(markdown, minTokens, maxTokens);
}

function htmlToMarkdown(html: string): string {
    let text = html;

    /** Convert headings. */
    for (let level = 6; level >= 1; level--) {
        const prefix = '#'.repeat(level);
        text = text.replace(
            new RegExp(`<h${level}[^>]*>(.*?)</h${level}>`, 'gi'),
            (_, inner) => `\n${prefix} ${stripTags(inner).trim()}\n`,
        );
    }

    /** Convert code blocks. */
    text = text.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, inner) => {
        return '\n```\n' + decodeEntities(inner).trim() + '\n```\n';
    });
    text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => {
        return '\n```\n' + decodeEntities(stripTags(inner)).trim() + '\n```\n';
    });

    /** Inline code. */
    text = text.replace(/<code[^>]*>(.*?)<\/code>/gi, (_, inner) => '`' + stripTags(inner) + '`');

    /** Bold / italic. */
    text = text.replace(
        /<(strong|b)[^>]*>(.*?)<\/\1>/gi,
        (_, __, inner) => `**${stripTags(inner)}**`,
    );
    text = text.replace(/<(em|i)[^>]*>(.*?)<\/\1>/gi, (_, __, inner) => `*${stripTags(inner)}*`);

    /** Links. */
    text = text.replace(/<a[^>]+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, (_, href, inner) => {
        return `[${stripTags(inner)}](${href})`;
    });

    /** Lists. */
    text = text.replace(
        /<li[^>]*>([\s\S]*?)<\/li>/gi,
        (_, inner) => `- ${stripTags(inner).trim()}\n`,
    );

    /** Blockquotes. */
    text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner) => {
        return (
            stripTags(inner)
                .trim()
                .split('\n')
                .map((l) => `> ${l}`)
                .join('\n') + '\n'
        );
    });

    /** Paragraphs and line breaks. */
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/p>/gi, '\n\n');
    text = text.replace(/<p[^>]*>/gi, '');

    /** Strip remaining tags. */
    text = stripTags(text);

    /** Decode HTML entities. */
    text = decodeEntities(text);

    /** Collapse excessive whitespace. */
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    return text;
}

function stripTags(html: string): string {
    return html.replace(/<[^>]+>/g, '');
}

function decodeEntities(text: string): string {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ');
}
