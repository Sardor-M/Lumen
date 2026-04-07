import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { ExtractionResult, SourceType } from '../types/index.js';
import { extractUrl } from './url.js';
import { extractPdf } from './pdf.js';
import { extractYoutube } from './youtube.js';
import { extractArxiv } from './arxiv.js';

/**
 * Detect input type and route to the appropriate extractor.
 * Supports: URLs, PDFs, YouTube, arXiv, local markdown/text files, and folders.
 */
export async function ingestInput(input: string): Promise<ExtractionResult> {
    const sourceType = detectSourceType(input);

    switch (sourceType) {
        case 'youtube':
            return extractYoutube(input);
        case 'arxiv':
            return extractArxiv(input);
        case 'url':
            return extractUrl(input);
        case 'pdf':
            return extractPdf(input);
        case 'file':
            return extractLocalFile(input);
        case 'folder':
            return extractFolder(input);
    }
}

/** Detect the source type from the input string. */
export function detectSourceType(input: string): SourceType {
    /** YouTube URLs and video IDs. */
    if (/youtu\.?be/i.test(input) || /^[\w-]{11}$/.test(input)) return 'youtube';

    /** arXiv URLs and paper IDs. */
    if (/arxiv\.org/i.test(input) || /^\d{4}\.\d{4,5}(v\d+)?$/.test(input)) return 'arxiv';

    /** Remote URLs (non-YouTube, non-arXiv). */
    if (/^https?:\/\//i.test(input)) {
        if (input.toLowerCase().endsWith('.pdf')) return 'pdf';
        return 'url';
    }

    /** Local file system paths. */
    try {
        const stat = statSync(input);
        if (stat.isDirectory()) return 'folder';
        if (extname(input).toLowerCase() === '.pdf') return 'pdf';
        return 'file';
    } catch {
        throw new Error(`Input not found: ${input}`);
    }
}

/** Extract content from a local text/markdown file. */
function extractLocalFile(path: string): ExtractionResult {
    const content = readFileSync(path, 'utf-8');
    if (!content.trim()) throw new Error(`Empty file: ${path}`);

    const filename = path.split('/').pop() || path;
    const title = filename.replace(/\.\w+$/, '').replace(/[-_]/g, ' ');

    return {
        title,
        content,
        url: null,
        source_type: 'file',
        language: null,
        metadata: { path, extension: extname(path) },
    };
}

/**
 * Recursively collect and concatenate all text/markdown files in a folder.
 * Each file becomes a section with a heading.
 */
function extractFolder(dir: string): ExtractionResult {
    const files = collectFiles(dir);
    if (files.length === 0) throw new Error(`No readable files found in: ${dir}`);

    const sections = files.map((f) => {
        const content = readFileSync(f, 'utf-8');
        const name = f.replace(dir, '').replace(/^\//, '');
        return `## ${name}\n\n${content}`;
    });

    const folderName = dir.split('/').filter(Boolean).pop() || dir;

    return {
        title: folderName,
        content: sections.join('\n\n---\n\n'),
        url: null,
        source_type: 'folder',
        language: null,
        metadata: { path: dir, file_count: files.length },
    };
}

const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.markdown', '.rst', '.org', '.adoc', '.tex']);

function collectFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
            results.push(...collectFiles(fullPath));
        } else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
            results.push(fullPath);
        }
    }
    return results.sort();
}
