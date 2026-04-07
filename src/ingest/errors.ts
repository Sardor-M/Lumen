import type { IngestErrorCode } from '../types/index.js';

export class IngestError extends Error {
    code: IngestErrorCode;
    retryable: boolean;
    hint: string;

    constructor(code: IngestErrorCode, message: string, opts?: { retryable?: boolean; hint?: string }) {
        super(message);
        this.name = 'IngestError';
        this.code = code;
        this.retryable = opts?.retryable ?? false;
        this.hint = opts?.hint ?? '';
    }
}

/** Classify an HTTP status code into an IngestError. */
export function errorFromStatus(status: number, url: string): IngestError {
    if (status === 401 || status === 403) {
        return new IngestError('PAYWALL', `Access denied (${status}): ${url}`, {
            hint: 'This page may be behind a paywall or login wall. Try saving the page as a file and using `lumen add ./file.html`.',
        });
    }
    if (status === 404 || status === 410) {
        return new IngestError('NOT_FOUND', `Not found (${status}): ${url}`);
    }
    if (status === 429) {
        return new IngestError('RATE_LIMITED', `Rate limited (429): ${url}`, {
            retryable: true,
            hint: 'Wait a minute and try again.',
        });
    }
    if (status >= 500) {
        return new IngestError('NETWORK', `Server error (${status}): ${url}`, { retryable: true });
    }
    return new IngestError('NETWORK', `HTTP ${status}: ${url}`);
}

/** Detect if HTML content is a JS-rendered shell with no real text. */
export function detectJsRendered(html: string): boolean {
    const textLength = html
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim().length;
    const hasReactRoot = /id=["'](__next|root|app|__nuxt)["']/.test(html);
    const hasNoscript = /<noscript/i.test(html);
    const scriptCount = (html.match(/<script/gi) || []).length;

    /** Very little text but lots of scripts = JS-rendered page. */
    return (textLength < 200 && scriptCount > 5) || (hasReactRoot && textLength < 500) || hasNoscript;
}

/** Detect common paywall indicators in HTML. */
export function detectPaywall(html: string): boolean {
    const paywallPatterns = [
        /paywall/i,
        /subscribe to (read|continue|access)/i,
        /premium (content|article|member)/i,
        /sign[- ]?in to (read|continue|view)/i,
        /create (a |an )?account to/i,
        /class="[^"]*paywall[^"]*"/i,
        /class="[^"]*subscriber-only[^"]*"/i,
        /meter-count/i,
    ];
    return paywallPatterns.some((p) => p.test(html));
}

/**
 * Retry an async operation with exponential backoff.
 * Only retries on errors where `retryable` is true.
 */
export async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2, baseDelayMs = 1000): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            const isRetryable = err instanceof IngestError && err.retryable;
            if (!isRetryable || attempt === maxRetries) break;
            await sleep(baseDelayMs * Math.pow(2, attempt));
        }
    }
    throw lastError;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
