/**
 * Observability hook shared by every public `createLumen()` method.
 *
 * Agents and harnesses plug in a single `onCall(event)` handler to trace
 * library calls — timing, arguments, outcome — without wrapping each
 * method themselves. Events fire twice per call (phase `'start'` then
 * either `'success'` or `'error'`) and carry a stable `call_id` so OTel /
 * Datadog / Langfuse-style correlation is a straight pass-through.
 *
 * Contract:
 * - Hook invocations are SYNCHRONOUS fire-and-forget. If you need async
 *   processing, schedule it from within your handler (e.g. `queueMicrotask`,
 *   `setImmediate`) — the library never awaits your code.
 * - Hook errors are swallowed. The underlying call always returns the
 *   value (or re-throws the original error) the caller expects.
 * - No hook = zero overhead. `withHook` returns the original function
 *   untouched when `onCall` is `undefined`.
 */

export type LumenCallEvent =
    | {
          phase: 'start';
          /** Stable per-call correlator — same id appears on the matching end event. */
          call_id: string;
          /** Dotted method name: `"ask"`, `"graph.path"`, `"sources.list"`, … */
          name: string;
          /** First positional argument, or `null` when the method takes none. */
          args: unknown;
          /** Epoch ms at the start of the call. */
          at: number;
      }
    | {
          phase: 'success';
          call_id: string;
          name: string;
          args: unknown;
          duration_ms: number;
          /** The value the method returned (unwrapped for async methods). */
          result: unknown;
      }
    | {
          phase: 'error';
          call_id: string;
          name: string;
          args: unknown;
          duration_ms: number;
          /** The thrown value — typically `LumenError` or `IngestError`, but could be anything. */
          error: unknown;
      };

export type LumenCallHook = (event: LumenCallEvent) => void;

let callCounter = 0;

/**
 * Generate a stable correlation id. Uses a monotonic counter plus a short
 * random suffix so ids are unique across parallel `Lumen` instances in the
 * same process (e.g. test workers) without pulling in `crypto`.
 */
function makeCallId(): string {
    callCounter = (callCounter + 1) & 0xffffff;
    const counter = callCounter.toString(36).padStart(5, '0');
    const suffix = Math.random().toString(36).slice(2, 6);
    return `lmn-${Date.now().toString(36)}-${counter}-${suffix}`;
}

/**
 * Wrap a function so each invocation emits start + success/error events.
 * Handles both sync and async functions — detected by Promise instanceof
 * check on the return value, so thenables from userland work too.
 */
export function withHook<Args extends unknown[], R>(
    name: string,
    fn: (...args: Args) => R,
    onCall: LumenCallHook | undefined,
): (...args: Args) => R {
    if (!onCall) return fn;

    return (...args: Args): R => {
        const call_id = makeCallId();
        const started = Date.now();
        const primaryArg: unknown = args.length === 0 ? null : args[0];

        safeFire(onCall, {
            phase: 'start',
            call_id,
            name,
            args: primaryArg,
            at: started,
        });

        let result: R;
        try {
            result = fn(...args);
        } catch (err) {
            safeFire(onCall, {
                phase: 'error',
                call_id,
                name,
                args: primaryArg,
                duration_ms: Date.now() - started,
                error: err,
            });
            throw err;
        }

        if (result instanceof Promise) {
            /** Async: attach .then to fire the matching end event. The
             *  returned promise preserves the original rejection. */
            return result.then(
                (value) => {
                    safeFire(onCall, {
                        phase: 'success',
                        call_id,
                        name,
                        args: primaryArg,
                        duration_ms: Date.now() - started,
                        result: value,
                    });
                    return value;
                },
                (err) => {
                    safeFire(onCall, {
                        phase: 'error',
                        call_id,
                        name,
                        args: primaryArg,
                        duration_ms: Date.now() - started,
                        error: err,
                    });
                    throw err;
                },
            ) as R;
        }

        safeFire(onCall, {
            phase: 'success',
            call_id,
            name,
            args: primaryArg,
            duration_ms: Date.now() - started,
            result,
        });
        return result;
    };
}

function safeFire(hook: LumenCallHook, event: LumenCallEvent): void {
    /** Hook errors must never propagate — the library contract is that
     *  onCall is observability only. Swallow silently; a misbehaving hook
     *  should not break the caller's control flow. */
    try {
        hook(event);
    } catch {
        /** Intentionally empty. */
    }
}
