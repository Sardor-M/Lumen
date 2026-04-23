import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ExtractionResult } from '../types/index.js';
import { IngestError } from './errors.js';

const IMAGE_EXTENSIONS = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.webp',
    '.gif',
    '.bmp',
    '.tiff',
    '.tif',
]);

const MIME_BY_EXTENSION: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
};

export type ImageExtractOptions = {
    /** When false, skip OCR and store only the image metadata. */
    ocr?: boolean;
    /** Tesseract language code, e.g. 'eng' or 'eng+jpn'. */
    language?: string;
};

/**
 * Ingest an image file. When OCR is enabled (default), shells out to the local
 * `tesseract` binary. The binary is not bundled — if it's missing we either
 * raise with an install hint (ocr=true) or fall back to metadata-only (ocr=false).
 */
export function extractImage(path: string, options: ImageExtractOptions = {}): ExtractionResult {
    const absolutePath = resolve(path);
    if (!existsSync(absolutePath)) {
        throw new IngestError('NOT_FOUND', `Image not found: ${path}`);
    }

    const stat = statSync(absolutePath);
    if (!stat.isFile()) {
        throw new IngestError('MALFORMED', `Image source must be a file: ${path}`);
    }

    const ext = extname(absolutePath).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) {
        throw new IngestError('MALFORMED', `Not a supported image format: ${path}`, {
            hint: `Supported extensions: ${[...IMAGE_EXTENSIONS].join(', ')}`,
        });
    }

    const bytes = readFileSync(absolutePath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const mime = MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
    const filename = basename(absolutePath);
    const title = filename.replace(/\.\w+$/, '').replace(/[-_]/g, ' ');

    const wantOcr = options.ocr !== false;
    const ocrResult = wantOcr ? tryRunTesseract(absolutePath, options.language ?? 'eng') : null;

    const content = renderImageDocument({
        title,
        filename,
        path: absolutePath,
        sha256,
        mime,
        sizeBytes: stat.size,
        ocrText: ocrResult?.text ?? null,
        ocrError: ocrResult?.error ?? null,
    });

    return {
        title,
        content,
        url: null,
        source_type: 'image',
        language: null,
        metadata: {
            image_path: absolutePath,
            filename,
            sha256,
            mime,
            size_bytes: stat.size,
            ocr_used: ocrResult !== null && ocrResult.error === null,
            ocr_language: ocrResult?.error === null ? (options.language ?? 'eng') : null,
            /** Caption is populated by a later compile step if Claude Vision is enabled. */
            caption: null,
        },
    };
}

export function isImagePath(path: string): boolean {
    return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

type OcrResult = { text: string; error: null } | { text: null; error: string };

function tryRunTesseract(imagePath: string, language: string): OcrResult {
    /** Tesseract's `stdout` target means text goes to stdout; last arg is config. */
    const result = spawnSync('tesseract', [imagePath, 'stdout', '-l', language], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
    });

    if (result.error && 'code' in result.error && result.error.code === 'ENOENT') {
        return {
            text: null,
            error: 'tesseract binary not found on PATH. Install with `brew install tesseract` (macOS) or `apt install tesseract-ocr` (Linux), or pass --no-ocr to skip.',
        };
    }
    if (result.status !== 0) {
        const stderr =
            result.stderr?.toString().trim() ?? 'tesseract exited with a non-zero status';
        return { text: null, error: stderr };
    }

    const text = result.stdout.toString().trim();
    return { text, error: null };
}

function renderImageDocument(input: {
    title: string;
    filename: string;
    path: string;
    sha256: string;
    mime: string;
    sizeBytes: number;
    ocrText: string | null;
    ocrError: string | null;
}): string {
    const parts: string[] = [`# ${input.title}`];

    parts.push(
        [
            `- File: \`${input.filename}\``,
            `- Path: \`${input.path}\``,
            `- MIME: ${input.mime}`,
            `- Size: ${formatBytes(input.sizeBytes)}`,
            `- SHA-256: \`${input.sha256}\``,
        ].join('\n'),
    );

    if (input.ocrText && input.ocrText.length > 0) {
        parts.push('## OCR text\n\n' + input.ocrText);
    } else if (input.ocrError) {
        parts.push(`## OCR\n\n_OCR failed: ${input.ocrError}_`);
    } else {
        parts.push('## OCR\n\n_OCR skipped._');
    }

    return parts.join('\n\n');
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
