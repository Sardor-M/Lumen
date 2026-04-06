import type { ChunkType } from '../types/index.js';
import { estimateTokens } from '../compress/tokenizer.js';

export type RawChunk = {
  content: string;
  chunk_type: ChunkType;
  heading: string | null;
};

/**
 * Split markdown into structural chunks.
 *
 * 1. Extract frontmatter and fenced code blocks as atomic units
 * 2. Split remaining text by headings into sections
 * 3. Within each section, split by paragraph boundaries
 * 4. Detect lists, blockquotes, and tables
 * 5. Merge tiny chunks (< minTokens) with their neighbor
 * 6. Split huge chunks (> maxTokens) at sentence boundaries
 */
export function chunkMarkdown(
  text: string,
  minTokens = 50,
  maxTokens = 1000,
): RawChunk[] {
  const raw: RawChunk[] = [];
  let remaining = text;
  let currentHeading: string | null = null;

  /** Extract YAML frontmatter if present. */
  const fmMatch = remaining.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fmMatch) {
    raw.push({ content: fmMatch[0].trim(), chunk_type: 'frontmatter', heading: null });
    remaining = remaining.slice(fmMatch[0].length);
  }

  /**
   * Replace fenced code blocks with placeholders before heading-splitting
   * so they are preserved as atomic units.
   */
  const codeBlocks: string[] = [];
  remaining = remaining.replace(/^(`{3,})[^\n]*\n[\s\S]*?\n\1$/gm, (match) => {
    const idx = codeBlocks.length;
    codeBlocks.push(match);
    return `\n%%CODE_BLOCK_${idx}%%\n`;
  });

  /** Split by headings (any level) into alternating [heading, body] segments. */
  const sections = remaining.split(/^(#{1,6}\s+.+)$/m);

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    if (!section.trim()) continue;

    const headingMatch = section.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      currentHeading = headingMatch[2].trim();
      raw.push({ content: section.trim(), chunk_type: 'heading', heading: currentHeading });
      continue;
    }

    /** Split section body by double newlines into individual blocks. */
    const blocks = section.split(/\n{2,}/);

    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;

      /** Restore code block placeholders back to their original content. */
      const codePlaceholder = trimmed.match(/^%%CODE_BLOCK_(\d+)%%$/);
      if (codePlaceholder) {
        const code = codeBlocks[parseInt(codePlaceholder[1])];
        raw.push({ content: code, chunk_type: 'code', heading: currentHeading });
        continue;
      }

      const chunkType = detectBlockType(trimmed);
      raw.push({ content: trimmed, chunk_type: chunkType, heading: currentHeading });
    }
  }

  const merged = mergeTiny(raw, minTokens);
  return splitHuge(merged, maxTokens);
}

/**
 * Classify a text block as table, blockquote, list, or paragraph
 * based on its leading characters.
 */
function detectBlockType(block: string): ChunkType {
  if (/^\|.+\|$/m.test(block) && block.includes('|')) {
    const lines = block.split('\n').filter(l => l.trim().startsWith('|'));
    if (lines.length >= 2) return 'table';
  }

  if (/^>\s/m.test(block)) return 'blockquote';

  if (/^[\t ]*[-*+]\s/m.test(block) || /^[\t ]*\d+[.)]\s/m.test(block)) return 'list';

  return 'paragraph';
}

/**
 * Merge chunks smaller than {@link minTokens} into their next neighbor.
 * Headings, code blocks, and frontmatter are never merged.
 */
function mergeTiny(chunks: RawChunk[], minTokens: number): RawChunk[] {
  if (chunks.length <= 1) return chunks;

  const result: RawChunk[] = [];
  let buffer: RawChunk | null = null;

  for (const chunk of chunks) {
    if (chunk.chunk_type === 'heading' || chunk.chunk_type === 'code' || chunk.chunk_type === 'frontmatter') {
      if (buffer) result.push(buffer);
      buffer = null;
      result.push(chunk);
      continue;
    }

    if (!buffer) {
      buffer = { ...chunk };
      continue;
    }

    if (estimateTokens(buffer.content) < minTokens) {
      buffer.content += '\n\n' + chunk.content;
      /** When merging, promote to the more specific type. */
      if (buffer.chunk_type === 'paragraph' && chunk.chunk_type !== 'paragraph') {
        buffer.chunk_type = chunk.chunk_type;
      }
    } else {
      result.push(buffer);
      buffer = { ...chunk };
    }
  }

  if (buffer) result.push(buffer);
  return result;
}

/**
 * Split chunks larger than {@link maxTokens} at sentence boundaries.
 * Code blocks are kept atomic regardless of size.
 */
function splitHuge(chunks: RawChunk[], maxTokens: number): RawChunk[] {
  const result: RawChunk[] = [];

  for (const chunk of chunks) {
    if (estimateTokens(chunk.content) <= maxTokens) {
      result.push(chunk);
      continue;
    }

    if (chunk.chunk_type === 'code') {
      result.push(chunk);
      continue;
    }

    /** Greedily pack sentences until the token budget is exceeded. */
    const sentences = chunk.content.match(/[^.!?]+[.!?]+[\s]*/g) || [chunk.content];
    let current = '';

    for (const sentence of sentences) {
      if (estimateTokens(current + sentence) > maxTokens && current) {
        result.push({ content: current.trim(), chunk_type: chunk.chunk_type, heading: chunk.heading });
        current = sentence;
      } else {
        current += sentence;
      }
    }

    if (current.trim()) {
      result.push({ content: current.trim(), chunk_type: chunk.chunk_type, heading: chunk.heading });
    }
  }

  return result;
}
