import { readFileSync, statSync, readdirSync, accessSync, existsSync, constants } from 'node:fs';
import { join, extname } from 'node:path';
import type { ExtractionResult, SourceType } from '../types/index.js';
import { IngestError, withRetry } from './errors.js';
import { extractUrl } from './url.js';
import { extractPdf } from './pdf.js';
import { extractYoutube } from './youtube.js';
import { extractArxiv } from './arxiv.js';
import { extractCode, isGithubRepoUrl } from './code.js';
import { extractDataset, isDatasetPath, isHuggingFaceUrl } from './dataset.js';
import { extractImage, isImagePath } from './image.js';

export type IngestOptions = {
    /** Enable OCR for image ingest. Default: true. */
    ocr?: boolean;
    /** Force dataset handling for ambiguous files. */
    as_dataset?: boolean;
    /** Override auto-detection and force a specific source type. */
    forcedType?: SourceType;
};

/**
 * Detect input type, route to the appropriate extractor,
 * and retry transient failures automatically.
 */
export async function ingestInput(
    input: string,
    options: IngestOptions = {},
): Promise<ExtractionResult> {
    const sourceType = detectSourceType(input, options);

    return withRetry(() => {
        switch (sourceType) {
            case 'youtube':
                return extractYoutube(input);
            case 'arxiv':
                return extractArxiv(input);
            case 'url':
                return extractUrl(input);
            case 'pdf':
                return extractPdf(input);
            case 'code':
                return Promise.resolve(extractCode(input));
            case 'dataset':
                return extractDataset(input);
            case 'image':
                return Promise.resolve(extractImage(input, { ocr: options.ocr }));
            case 'file':
                return Promise.resolve(extractLocalFile(input));
            case 'folder':
                return Promise.resolve(extractFolder(input));
        }
    });
}

/** Detect the source type from the input string. */
export function detectSourceType(input: string, options: IngestOptions = {}): SourceType {
    if (options.forcedType) return options.forcedType;

    /** YouTube URLs and video IDs. */
    if (/youtu\.?be/i.test(input) || /^[\w-]{11}$/.test(input)) return 'youtube';

    /** arXiv URLs and paper IDs. */
    if (/arxiv\.org/i.test(input) || /^\d{4}\.\d{4,5}(v\d+)?$/.test(input)) return 'arxiv';

    /** GitHub repository URLs — cloned and ingested as a code source. */
    if (isGithubRepoUrl(input)) return 'code';

    /** HuggingFace dataset URLs — fetched via the datasets API. */
    if (isHuggingFaceUrl(input)) return 'dataset';

    /** Remote URLs (non-YouTube, non-arXiv, non-GitHub, non-HF). */
    if (/^https?:\/\//i.test(input)) {
        if (input.toLowerCase().endsWith('.pdf')) return 'pdf';
        return 'url';
    }

    /** Local file system paths — inspect the file or directory. */
    try {
        const stat = statSync(input);
        if (stat.isDirectory()) {
            if (existsSync(join(input, '.git'))) return 'code';
            return 'folder';
        }

        if (options.as_dataset || isDatasetPath(input)) return 'dataset';
        if (isImagePath(input)) return 'image';
        if (extname(input).toLowerCase() === '.pdf') return 'pdf';
        return 'file';
    } catch {
        throw new IngestError('NOT_FOUND', `Input not found: ${input}`);
    }
}

/** Extract content from a local text/markdown file. */
function extractLocalFile(path: string): ExtractionResult {
    try {
        accessSync(path, constants.R_OK);
    } catch {
        throw new IngestError('PERMISSION', `Cannot read file (permission denied): ${path}`);
    }

    const content = readFileSync(path, 'utf-8');
    if (!content.trim()) throw new IngestError('NO_CONTENT', `Empty file: ${path}`);

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
    try {
        accessSync(dir, constants.R_OK);
    } catch {
        throw new IngestError('PERMISSION', `Cannot read directory (permission denied): ${dir}`);
    }

    const files = collectFiles(dir);
    if (files.length === 0) {
        throw new IngestError('NO_CONTENT', `No readable text files found in: ${dir}`, {
            hint: 'Supported extensions: .md, .txt, .markdown, .rst, .org, .adoc, .tex',
        });
    }

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
