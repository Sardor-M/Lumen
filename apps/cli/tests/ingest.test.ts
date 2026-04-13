import { describe, it, expect } from 'vitest';
import { detectSourceType } from '../src/ingest/file.js';
import {
    IngestError,
    errorFromStatus,
    detectJsRendered,
    detectPaywall,
} from '../src/ingest/errors.js';

describe('detectSourceType', () => {
    it('detects YouTube URLs', () => {
        expect(detectSourceType('https://www.youtube.com/watch?v=dQw4w9WgXcB')).toBe('youtube');
        expect(detectSourceType('https://youtu.be/dQw4w9WgXcB')).toBe('youtube');
    });

    it('detects arXiv URLs and IDs', () => {
        expect(detectSourceType('https://arxiv.org/abs/2301.12345')).toBe('arxiv');
        expect(detectSourceType('2301.12345')).toBe('arxiv');
    });

    it('detects PDF URLs', () => {
        expect(detectSourceType('https://example.com/paper.pdf')).toBe('pdf');
    });

    it('detects regular URLs', () => {
        expect(detectSourceType('https://example.com/article')).toBe('url');
    });

    it('detects local files', () => {
        expect(detectSourceType('./package.json')).toBe('file');
    });

    it('detects local directories', () => {
        expect(detectSourceType('./src')).toBe('folder');
    });

    it('throws for non-existent paths', () => {
        expect(() => detectSourceType('/nonexistent/path/xyz')).toThrow(IngestError);
    });
});

describe('errorFromStatus', () => {
    it('classifies 401/403 as PAYWALL', () => {
        const err = errorFromStatus(401, 'https://example.com');
        expect(err.code).toBe('PAYWALL');
        expect(err.retryable).toBe(false);
    });

    it('classifies 404 as NOT_FOUND', () => {
        const err = errorFromStatus(404, 'https://example.com');
        expect(err.code).toBe('NOT_FOUND');
    });

    it('classifies 429 as RATE_LIMITED and retryable', () => {
        const err = errorFromStatus(429, 'https://example.com');
        expect(err.code).toBe('RATE_LIMITED');
        expect(err.retryable).toBe(true);
        expect(err.hint).toBeTruthy();
    });

    it('classifies 500+ as NETWORK and retryable', () => {
        const err = errorFromStatus(500, 'https://example.com');
        expect(err.code).toBe('NETWORK');
        expect(err.retryable).toBe(true);
    });
});

describe('detectJsRendered', () => {
    it('detects React/Next.js shells', () => {
        const html =
            '<html><body><div id="__next"></div>' + '<script>'.repeat(10) + '</body></html>';
        expect(detectJsRendered(html)).toBe(true);
    });

    it('does not flag content-rich pages', () => {
        const html =
            '<html><body><h1>Article</h1><p>' + 'Content. '.repeat(100) + '</p></body></html>';
        expect(detectJsRendered(html)).toBe(false);
    });
});

describe('detectPaywall', () => {
    it('detects paywall keywords', () => {
        expect(detectPaywall('<div class="paywall-overlay">Subscribe to read</div>')).toBe(true);
        expect(detectPaywall('<p>Sign in to continue reading this article</p>')).toBe(true);
        expect(detectPaywall('<div>Premium content for members only</div>')).toBe(true);
    });

    it('does not flag normal content', () => {
        expect(detectPaywall('<p>This is a normal article about machine learning.</p>')).toBe(
            false,
        );
    });
});

describe('IngestError', () => {
    it('has code, retryable, and hint properties', () => {
        const err = new IngestError('TIMEOUT', 'Request timed out', {
            retryable: true,
            hint: 'Try again later.',
        });

        expect(err.code).toBe('TIMEOUT');
        expect(err.retryable).toBe(true);
        expect(err.hint).toBe('Try again later.');
        expect(err.message).toBe('Request timed out');
        expect(err).toBeInstanceOf(Error);
    });

    it('defaults to non-retryable with empty hint', () => {
        const err = new IngestError('MALFORMED', 'Bad data');
        expect(err.retryable).toBe(false);
        expect(err.hint).toBe('');
    });
});
