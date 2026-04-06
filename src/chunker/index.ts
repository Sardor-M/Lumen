import type { Chunk } from '../types/index.js';
import type { RawChunk } from './markdown.js';
import { chunkMarkdown } from './markdown.js';
import { chunkHtml } from './html.js';
import { chunkPlain } from './plain.js';
import { shortId, contentHash } from '../utils/hash.js';
import { estimateTokens } from '../compress/tokenizer.js';

type ContentFormat = 'markdown' | 'html' | 'plain';

export function detectFormat(content: string): ContentFormat {
  const trimmed = content.trim();

  // HTML: starts with doctype or contains significant tag density
  if (/^<!doctype\s+html/i.test(trimmed) || /^<html/i.test(trimmed)) return 'html';
  const tagCount = (trimmed.match(/<\/?[a-z][\w-]*[^>]*>/gi) || []).length;
  if (tagCount > 5 && tagCount / trimmed.split('\n').length > 0.3) return 'html';

  // Markdown: has headings, code fences, or links
  if (/^#{1,6}\s/m.test(trimmed)) return 'markdown';
  if (/^```/m.test(trimmed)) return 'markdown';
  if (/^---\n/.test(trimmed)) return 'markdown';

  return 'plain';
}

export function chunk(
  content: string,
  sourceId: string,
  opts?: { format?: ContentFormat; minTokens?: number; maxTokens?: number },
): Chunk[] {
  const format = opts?.format ?? detectFormat(content);
  const min = opts?.minTokens ?? 50;
  const max = opts?.maxTokens ?? 1000;

  let raw: RawChunk[];
  switch (format) {
    case 'markdown':
      raw = chunkMarkdown(content, min, max);
      break;
    case 'html':
      raw = chunkHtml(content, min, max);
      break;
    case 'plain':
      raw = chunkPlain(content, min, max);
      break;
  }

  return raw.map((r, i) => ({
    id: shortId(`${sourceId}:${i}:${r.content}`),
    source_id: sourceId,
    content: r.content,
    content_hash: contentHash(r.content),
    chunk_type: r.chunk_type,
    heading: r.heading,
    position: i,
    token_count: estimateTokens(r.content),
  }));
}

export { chunkMarkdown } from './markdown.js';
export { chunkHtml } from './html.js';
export { chunkPlain } from './plain.js';
export type { RawChunk } from './markdown.js';
