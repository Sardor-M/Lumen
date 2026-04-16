/**
 * Library-level typed errors. Throw from pure functions so callers can
 * branch on `instanceof` / `code` without parsing message strings.
 *
 * The CLI catches these in its action handlers and maps them to
 * `log.error` + `process.exitCode = 1`. Library consumers get the raw
 * error and decide their own policy.
 */

export type LumenErrorCode =
    /** The workspace at `dataDir` has no database yet. Pass `autoInit: true` or run `lumen init`. */
    | 'NOT_INITIALIZED'
    /** `lumen init` called on a workspace that already exists. */
    | 'ALREADY_INITIALIZED'
    /** Caller supplied a bad arg (empty query, out-of-range number, wrong type, etc.). */
    | 'INVALID_ARGUMENT'
    /** Target id/slug does not exist in the store. */
    | 'NOT_FOUND'
    /** A row with this id/hash already exists — `add()` uses `'skipped'` status for dedup instead. */
    | 'DUPLICATE'
    /** Method requires an LLM API key (ANTHROPIC_API_KEY / OPENROUTER_API_KEY) and none is configured. */
    | 'MISSING_API_KEY'
    /**
     * LLM provider returned an error, network/timeout, or any non-parse runtime failure.
     * Agents should treat this as retryable; the original error is preserved as `cause`.
     */
    | 'LLM_ERROR'
    /**
     * LLM returned a response that couldn't be parsed as the expected structured shape.
     * Usually fixable by retrying with a stricter prompt; `cause` carries the parser error.
     */
    | 'LLM_PARSE_ERROR'
    /** Build/invariant violation — caller did nothing wrong; file a bug. */
    | 'INTERNAL'
    /** Anything not classified above. Treat as non-retryable. */
    | 'UNKNOWN';

export class LumenError extends Error {
    readonly code: LumenErrorCode;
    readonly hint?: string;

    constructor(code: LumenErrorCode, message: string, opts?: { hint?: string; cause?: unknown }) {
        /** ES2022 `Error` supports `{ cause }` natively — target is es2022
         *  per tsconfig so this compiles directly without a cast shim. */
        super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
        this.name = 'LumenError';
        this.code = code;
        this.hint = opts?.hint;
    }
}

export class LumenNotInitializedError extends LumenError {
    constructor(dataDir: string) {
        super('NOT_INITIALIZED', `Lumen workspace not initialized at ${dataDir}`, {
            hint: 'Pass `{ autoInit: true }` to createLumen() or run `lumen init` first.',
        });
        this.name = 'LumenNotInitializedError';
    }
}
