/**
 * Library-level typed errors. Throw from pure functions so callers can
 * branch on `instanceof` / `code` without parsing message strings.
 *
 * The CLI catches these in its action handlers and maps them to
 * `log.error` + `process.exitCode = 1`. Library consumers get the raw
 * error and decide their own policy.
 */

export type LumenErrorCode =
    | 'NOT_INITIALIZED'
    | 'ALREADY_INITIALIZED'
    | 'INVALID_ARGUMENT'
    | 'NOT_FOUND'
    | 'DUPLICATE'
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
