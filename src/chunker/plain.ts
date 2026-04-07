import type { RawChunk } from './markdown.js';
import { estimateTokens } from '../compress/tokenizer.js';

/**
 * Chunk plain text by paragraph boundaries.
 * Merges tiny paragraphs, splits huge ones at sentence boundaries.
 */
export function chunkPlain(text: string, minTokens = 50, maxTokens = 1000): RawChunk[] {
    const paragraphs = text
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean);
    const raw: RawChunk[] = [];

    let buffer = '';
    for (const para of paragraphs) {
        if (!buffer) {
            buffer = para;
            continue;
        }

        if (estimateTokens(buffer) < minTokens) {
            buffer += '\n\n' + para;
        } else {
            raw.push(...splitIfNeeded(buffer, maxTokens));
            buffer = para;
        }
    }

    if (buffer) {
        raw.push(...splitIfNeeded(buffer, maxTokens));
    }

    return raw;
}

function splitIfNeeded(text: string, maxTokens: number): RawChunk[] {
    if (estimateTokens(text) <= maxTokens) {
        return [{ content: text, chunk_type: 'paragraph', heading: null }];
    }

    const sentences = text.match(/[^.!?]+[.!?]+[\s]*/g) || [text];
    const chunks: RawChunk[] = [];
    let current = '';

    for (const sentence of sentences) {
        if (estimateTokens(current + sentence) > maxTokens && current) {
            chunks.push({ content: current.trim(), chunk_type: 'paragraph', heading: null });
            current = sentence;
        } else {
            current += sentence;
        }
    }

    if (current.trim()) {
        chunks.push({ content: current.trim(), chunk_type: 'paragraph', heading: null });
    }

    return chunks;
}
