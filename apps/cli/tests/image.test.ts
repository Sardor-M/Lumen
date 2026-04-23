import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { extractImage, isImagePath } from '../src/ingest/image.js';
import { IngestError } from '../src/ingest/errors.js';

const tesseractAvailable = (() => {
    const probe = spawnSync('tesseract', ['--version'], { stdio: 'ignore' });
    return probe.status === 0;
})();

let workDir: string;

beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lumen-image-test-'));
});

afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
});

/** Writes the minimum PNG byte signature plus a short body. Enough to pass our
 *  extension sniff; not a valid decodable PNG. Tests that need OCR to succeed
 *  are skipped when tesseract isn't on PATH. */
function writeFakePng(path: string, body: Buffer = Buffer.from('payload')): Buffer {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const bytes = Buffer.concat([signature, body]);
    writeFileSync(path, bytes);
    return bytes;
}

describe('isImagePath', () => {
    it('matches common image extensions', () => {
        expect(isImagePath('foo.png')).toBe(true);
        expect(isImagePath('foo.jpg')).toBe(true);
        expect(isImagePath('foo.jpeg')).toBe(true);
        expect(isImagePath('foo.webp')).toBe(true);
        expect(isImagePath('foo.gif')).toBe(true);
        expect(isImagePath('foo.bmp')).toBe(true);
        expect(isImagePath('foo.tiff')).toBe(true);
    });

    it('is case-insensitive on extension', () => {
        expect(isImagePath('Screenshot.PNG')).toBe(true);
    });

    it('rejects non-image extensions', () => {
        expect(isImagePath('foo.pdf')).toBe(false);
        expect(isImagePath('foo.svg')).toBe(false);
        expect(isImagePath('README.md')).toBe(false);
    });
});

describe('extractImage — metadata-only path (ocr disabled)', () => {
    it('produces a source with SHA-256, MIME, size, and caption placeholder', () => {
        const path = join(workDir, 'diagram.png');
        const bytes = writeFakePng(path);
        const expectedSha = createHash('sha256').update(bytes).digest('hex');

        const result = extractImage(path, { ocr: false });
        expect(result.source_type).toBe('image');
        expect(result.url).toBeNull();
        expect(result.title).toBe('diagram');

        const meta = result.metadata as Record<string, unknown>;
        expect(meta.sha256).toBe(expectedSha);
        expect(meta.mime).toBe('image/png');
        expect(meta.size_bytes).toBeGreaterThan(0);
        expect(meta.ocr_used).toBe(false);
        expect(meta.caption).toBeNull();
    });

    it('titles are derived from the filename with separators normalised', () => {
        const path = join(workDir, 'my_system_diagram.png');
        writeFakePng(path);
        const result = extractImage(path, { ocr: false });
        expect(result.title).toBe('my system diagram');
    });

    it('renders a markdown body with OCR-skipped note when ocr=false', () => {
        const path = join(workDir, 'noop.png');
        writeFakePng(path);
        const result = extractImage(path, { ocr: false });
        expect(result.content).toContain('# noop');
        expect(result.content).toMatch(/OCR skipped/i);
    });

    it('MIME falls back correctly for jpeg', () => {
        const path = join(workDir, 'photo.jpeg');
        writeFileSync(path, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
        const result = extractImage(path, { ocr: false });
        const meta = result.metadata as Record<string, unknown>;
        expect(meta.mime).toBe('image/jpeg');
    });
});

describe('extractImage — OCR fallback paths', () => {
    it.skipIf(tesseractAvailable)(
        'captures a clear install hint when tesseract is missing and ocr is enabled',
        () => {
            const path = join(workDir, 'no-ocr.png');
            writeFakePng(path);
            const result = extractImage(path); /** default ocr=true */

            const meta = result.metadata as Record<string, unknown>;
            expect(meta.ocr_used).toBe(false);
            expect(result.content).toMatch(/tesseract binary not found/i);
        },
    );

    it.skipIf(!tesseractAvailable)(
        'records an OCR failure note for an undecodable image when tesseract is present',
        () => {
            const path = join(workDir, 'bad.png');
            writeFakePng(path);
            const result = extractImage(path);
            const meta = result.metadata as Record<string, unknown>;
            /** Our fake PNG isn't decodable — tesseract should exit non-zero and we
             *  record the failure in the markdown body rather than throwing. */
            expect(meta.ocr_used).toBe(false);
            expect(result.content).toMatch(/## OCR/);
        },
    );
});

describe('extractImage — error paths', () => {
    it('throws NOT_FOUND for missing files', () => {
        try {
            extractImage(join(workDir, 'missing.png'), { ocr: false });
            expect.fail('expected NOT_FOUND');
        } catch (err) {
            expect(err).toBeInstanceOf(IngestError);
            expect((err as IngestError).code).toBe('NOT_FOUND');
        }
    });

    it('throws MALFORMED for non-image extensions', () => {
        const path = join(workDir, 'notes.txt');
        writeFileSync(path, 'not an image');
        try {
            extractImage(path, { ocr: false });
            expect.fail('expected MALFORMED');
        } catch (err) {
            expect(err).toBeInstanceOf(IngestError);
            expect((err as IngestError).code).toBe('MALFORMED');
            expect((err as IngestError).hint).toMatch(/Supported extensions/);
        }
    });

    it('throws MALFORMED when the path is a directory', () => {
        try {
            extractImage(workDir, { ocr: false });
            expect.fail('expected MALFORMED');
        } catch (err) {
            expect(err).toBeInstanceOf(IngestError);
            /** Directory is rejected by the extension check since it has no image ext. */
            expect((err as IngestError).code).toBe('MALFORMED');
        }
    });
});
