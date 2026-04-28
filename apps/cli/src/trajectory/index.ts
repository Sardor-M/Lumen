/**
 * Public trajectory module - capture + replay primitives for coding-agent skills.
 *
 * See `docs/docs-temp/TRAJECTORY-FORMAT.md` for the on-disk shape and replay
 * semantics, and `docs/docs-temp/AGENT-LEARNING-SUBSTRATE.md` §6.3 for the
 * upstream design context.
 */

export { captureTrajectory } from './capture.js';
export type { CaptureTrajectoryInput } from './capture.js';
export { findReplay } from './replay.js';
export type { FindReplayOptions } from './replay.js';
export {
    validateTrajectory,
    TrajectoryValidationError,
    LIMIT_RESULT_SUMMARY_CHARS,
    LIMIT_ARGS_BYTES,
    LIMIT_METADATA_BYTES,
    LIMIT_STEPS,
} from './validate.js';
export { TRAJECTORY_FORMAT_VERSION } from './types.js';
export type {
    TrajectoryStep,
    TrajectoryOutcome,
    TrajectoryMetadata,
    TrajectoryInputs,
    CaptureResult,
    ReplayCaveat,
    ReplayMatch,
    FindReplayResult,
} from './types.js';
