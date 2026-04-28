/**
 * Trajectory validation + truncation.
 *
 * Size limits per `docs/docs-temp/TRAJECTORY-FORMAT.md` §5:
 *   - per-step result_summary: 500 chars
 *   - per-step args JSON: 2 KB serialized
 *   - per-trajectory metadata total: 256 KB serialized
 *   - steps per trajectory: 50
 *
 * Truncation is lossy but bounded. Oversized fields are replaced with stubs
 * indicating bytes dropped; over-50-step trajectories throw because that's a
 * call-site bug (the agent should split the task).
 */

import type { TrajectoryMetadata, TrajectoryStep } from './types.js';

export const LIMIT_RESULT_SUMMARY_CHARS = 500;
export const LIMIT_ARGS_BYTES = 2_048;
export const LIMIT_METADATA_BYTES = 256 * 1024;
export const LIMIT_STEPS = 50;

export type ValidationDiagnostics = {
    truncations: number;
    args_bytes_dropped: number;
};

export type ValidationResult = {
    metadata: TrajectoryMetadata;
    diagnostics: ValidationDiagnostics;
};

export class TrajectoryValidationError extends Error {
    code: 'TOO_MANY_STEPS' | 'METADATA_TOO_LARGE' | 'EMPTY_STEPS';
    constructor(code: 'TOO_MANY_STEPS' | 'METADATA_TOO_LARGE' | 'EMPTY_STEPS', message: string) {
        super(message);
        this.code = code;
        this.name = 'TrajectoryValidationError';
    }
}

/**
 * Validate + truncate a trajectory in place. Returns a sanitized copy plus
 * diagnostics describing the truncations applied.
 */
export function validateTrajectory(metadata: TrajectoryMetadata): ValidationResult {
    if (metadata.steps.length === 0) {
        throw new TrajectoryValidationError(
            'EMPTY_STEPS',
            'trajectory must have at least one step',
        );
    }
    if (metadata.steps.length > LIMIT_STEPS) {
        throw new TrajectoryValidationError(
            'TOO_MANY_STEPS',
            `trajectory has ${metadata.steps.length} steps; max is ${LIMIT_STEPS}. Split into smaller tasks.`,
        );
    }

    let truncations = 0;
    let argsBytesDropped = 0;

    const steps: TrajectoryStep[] = metadata.steps.map((s, i) => {
        let result_summary = s.result_summary;
        if (result_summary.length > LIMIT_RESULT_SUMMARY_CHARS) {
            result_summary = result_summary.slice(0, LIMIT_RESULT_SUMMARY_CHARS - 3) + '...';
            truncations++;
        }

        let args = s.args;
        const argsJson = JSON.stringify(args);
        if (Buffer.byteLength(argsJson, 'utf-8') > LIMIT_ARGS_BYTES) {
            const originalBytes = Buffer.byteLength(argsJson, 'utf-8');
            args = { __truncated: `<${originalBytes} bytes dropped>` };
            argsBytesDropped += originalBytes;
            truncations++;
        }

        return {
            n: typeof s.n === 'number' ? s.n : i,
            tool: s.tool,
            args,
            result_summary,
            result_ok: !!s.result_ok,
            elapsed_ms: s.elapsed_ms ?? null,
        };
    });

    const sanitized: TrajectoryMetadata = { ...metadata, steps };

    /** Final size check after per-step truncation. */
    const totalBytes = Buffer.byteLength(JSON.stringify(sanitized), 'utf-8');
    if (totalBytes > LIMIT_METADATA_BYTES) {
        throw new TrajectoryValidationError(
            'METADATA_TOO_LARGE',
            `trajectory metadata is ${totalBytes} bytes; max is ${LIMIT_METADATA_BYTES}. ` +
                `Consider splitting the task or shortening result_summary entries.`,
        );
    }

    return {
        metadata: sanitized,
        diagnostics: { truncations, args_bytes_dropped: argsBytesDropped },
    };
}
