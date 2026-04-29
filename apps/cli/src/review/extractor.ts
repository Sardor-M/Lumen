/**
 * LLM-driven trajectory extraction.
 *
 * Hands a `SessionLog` to an LLM with a structured-output prompt and parses
 * the response into a `ProposedTrajectory` (or null when the LLM judges the
 * session not worth capturing).
 *
 * The chat function is injectable so tests can pass a mock without spinning
 * up a real model call. Production callers pass `chatJson` from
 * `apps/cli/src/llm/client.ts`.
 */

import type { LumenConfig } from '../types/index.js';
import type { TrajectoryOutcome } from '../trajectory/index.js';
import type { ProposedTrajectory, SessionLog, SessionLogRow } from './types.js';

/**
 * Shape of the chat function the extractor depends on. Matches the signature
 * of `chatJson<T>` from the LLM client; defining a local alias lets tests
 * inject any compatible function without importing the real one.
 */
export type ChatJsonFn = <T>(
    config: LumenConfig,
    messages: { role: 'user' | 'assistant'; content: string }[],
    opts?: { system?: string; maxTokens?: number; temperature?: number },
) => Promise<T>;

/**
 * Wire format of the LLM response. Slightly more permissive than
 * `ProposedTrajectory` because we want to tolerate small LLM mistakes
 * (missing fields, lowercase outcome variants) and normalize them before
 * returning to the caller.
 */
type RawLlmExtraction = {
    /** When true, the rest of the fields may be absent. */
    is_skill?: boolean;
    task?: string;
    outcome?: string;
    steps?: Array<{
        tool?: string;
        args?: Record<string, unknown>;
        result_summary?: string;
        result_ok?: boolean;
    }>;
    reason?: string;
};

export type ExtractTrajectoryResult =
    | { kind: 'extracted'; trajectory: ProposedTrajectory }
    | { kind: 'no_skill'; reason: string }
    | { kind: 'failed'; reason: string };

const SYSTEM_PROMPT = `You analyze logged tool-call sessions and decide whether they
represent a successful, repeatable task that's worth saving as a "skill" for
future agents to replay.

A skill is a short multi-step recipe (3-15 steps) where each step is a single
tool call, and the steps together accomplish a recognizable task in a codebase
(e.g. "add a new MCP tool", "fix a typecheck error", "ingest a new format").

Reject sessions that are:
  - Read-only browsing with no edits or shell calls
  - Unrelated tool calls strung together without a coherent task
  - Already-failed exploration that didn't reach a conclusion
  - Sessions that look like the agent was thrashing (repeating the same call)

Return JSON ONLY, matching one of these two shapes:

  Worth saving:
    { "is_skill": true,
      "task": "<short imperative task description>",
      "outcome": "success" | "failure" | "partial",
      "steps": [ { "tool": "...", "args": {...}, "result_summary": "...", "result_ok": true|false }, ... ] }

  Not worth saving:
    { "is_skill": false, "reason": "<one-sentence justification>" }

Do NOT add any prose, markdown, or commentary outside the JSON. Do NOT
fabricate args or results — quote what the session actually shows. Cap
steps at 15 by collapsing redundant ones.`;

const MIN_STEPS = 3;
const MAX_STEPS = 15;

export type ExtractOptions = {
    /** Override the system prompt. Useful for evaluation runs. */
    system?: string;
    /** Max tokens for the LLM response. Default 2048. */
    maxTokens?: number;
    /** Temperature. Default 0.1 - we want deterministic extraction. */
    temperature?: number;
};

/**
 * Run the extractor on one session. Returns a tagged-union result so the
 * orchestrator can persist the right outcome without parsing prose.
 *
 * Failure modes:
 *   - LLM throws (network, API error)            -> {kind: 'failed', reason}
 *   - LLM returns invalid JSON                    -> {kind: 'failed', reason}
 *   - LLM says is_skill=false                     -> {kind: 'no_skill', reason}
 *   - LLM says is_skill=true but data is invalid  -> {kind: 'failed', reason}
 */
export async function extractTrajectory(
    session: SessionLog,
    config: LumenConfig,
    chatJson: ChatJsonFn,
    opts: ExtractOptions = {},
): Promise<ExtractTrajectoryResult> {
    const userPrompt = buildUserPrompt(session);

    let raw: RawLlmExtraction;
    try {
        raw = await chatJson<RawLlmExtraction>(config, [{ role: 'user', content: userPrompt }], {
            system: opts.system ?? SYSTEM_PROMPT,
            maxTokens: opts.maxTokens ?? 2048,
            temperature: opts.temperature ?? 0.1,
        });
    } catch (err) {
        return { kind: 'failed', reason: errorMessage(err) };
    }

    if (raw.is_skill === false) {
        return { kind: 'no_skill', reason: raw.reason ?? 'LLM judged session not worth capturing' };
    }

    /** Anything other than is_skill === true is malformed. */
    if (raw.is_skill !== true) {
        return { kind: 'failed', reason: 'LLM response missing is_skill flag' };
    }

    const validated = validateExtraction(raw);
    if (validated.kind === 'failed') return validated;
    return { kind: 'extracted', trajectory: validated.trajectory };
}

/**
 * Render the session into the prompt. Intentionally compact: tool name,
 * truncated query text, skill_hit flag. Don't dump full args - the LLM
 * doesn't need them for the is-this-a-skill decision and they can blow up
 * the context window.
 */
function buildUserPrompt(session: SessionLog): string {
    const lines: string[] = [];
    lines.push(`Session: ${session.session_id}`);
    lines.push(`Started: ${session.started_at}`);
    lines.push(`Ended:   ${session.ended_at}`);
    lines.push(`Total tool calls: ${session.rows.length}`);
    lines.push(`Skill hits: ${session.total_skill_hits}`);
    if (session.inferred_scope) {
        lines.push(`Scope: ${session.inferred_scope.kind}/${session.inferred_scope.key}`);
    }
    lines.push('');
    lines.push('Tool-call sequence:');
    for (let i = 0; i < session.rows.length; i++) {
        lines.push(formatRow(i, session.rows[i]));
    }
    return lines.join('\n');
}

function formatRow(index: number, row: SessionLogRow): string {
    const query = row.query_text ? `"${truncate(row.query_text, 120)}"` : '';
    const hit = row.skill_hit === 1 ? ' (skill_hit)' : '';
    const tokens = row.tokens_spent !== null ? ` ${row.tokens_spent}t` : '';
    return `  ${index + 1}. ${row.tool_name}${query ? ' ' + query : ''}${hit}${tokens}`;
}

function truncate(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/**
 * Normalize and validate the LLM's positive-case payload. Returns either a
 * clean ProposedTrajectory or a failure reason that explains exactly what
 * was missing - useful for the review record's `notes` column.
 */
function validateExtraction(
    raw: RawLlmExtraction,
): { kind: 'extracted'; trajectory: ProposedTrajectory } | { kind: 'failed'; reason: string } {
    if (typeof raw.task !== 'string' || raw.task.trim().length === 0) {
        return { kind: 'failed', reason: 'missing or empty task' };
    }
    const outcome = normalizeOutcome(raw.outcome);
    if (!outcome) {
        return { kind: 'failed', reason: `invalid outcome: ${JSON.stringify(raw.outcome)}` };
    }
    if (!Array.isArray(raw.steps) || raw.steps.length < MIN_STEPS) {
        return {
            kind: 'failed',
            reason: `not enough steps (${raw.steps?.length ?? 0} < ${MIN_STEPS})`,
        };
    }
    if (raw.steps.length > MAX_STEPS) {
        return {
            kind: 'failed',
            reason: `too many steps (${raw.steps.length} > ${MAX_STEPS})`,
        };
    }

    const steps: ProposedTrajectory['steps'] = [];
    for (let i = 0; i < raw.steps.length; i++) {
        const s = raw.steps[i];
        if (typeof s.tool !== 'string' || !s.tool) {
            return { kind: 'failed', reason: `step ${i} missing tool` };
        }
        if (typeof s.result_summary !== 'string') {
            return { kind: 'failed', reason: `step ${i} missing result_summary` };
        }
        steps.push({
            tool: s.tool,
            args: s.args && typeof s.args === 'object' ? s.args : {},
            result_summary: s.result_summary,
            result_ok: typeof s.result_ok === 'boolean' ? s.result_ok : true,
        });
    }

    return {
        kind: 'extracted',
        trajectory: { task: raw.task.trim(), outcome, steps },
    };
}

function normalizeOutcome(raw: unknown): TrajectoryOutcome | null {
    if (typeof raw !== 'string') return null;
    const lower = raw.toLowerCase().trim();
    if (lower === 'success' || lower === 'failure' || lower === 'partial') return lower;
    return null;
}

function errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}
