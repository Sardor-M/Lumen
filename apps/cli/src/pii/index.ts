/**
 * Public PII gate API.
 *
 * Two-stage scrubber per `docs/docs-temp/AGENT-LEARNING-SUBSTRATE.md` §6.4.
 * This module is the regex stage - deterministic, ~80% coverage, zero deps.
 * The optional LLM second pass lands later as part of the broker tier.
 *
 * Used by:
 *   - `capture` MCP tool (this branch)
 *   - `session_summary` MCP tool (this branch)
 *   - `capture_trajectory` MCP tool (follow-up after Tier 2b merges)
 */

export { scrubPii } from './scrub.js';
export type { ScrubOptions, ScrubResult, ScrubSuccess, ScrubFailure } from './scrub.js';
export { PII_PATTERNS } from './patterns.js';
export type { PiiPattern, PiiPatternName } from './patterns.js';
