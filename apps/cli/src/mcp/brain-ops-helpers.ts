/**
 * Pure helpers for shaping `brain_ops` responses.
 *
 * Extracted from `server.ts` so tests can verify the projection logic and
 * budget-hint computation without spinning up the stdio MCP server.
 */

import type { Concept, KnownSkill, ExplorationBudgetHint, ScopeKind } from '../types/index.js';
import { explorationCostAvoided } from '../store/query-log.js';

/**
 * Project a Concept row into the user-facing KnownSkill shape. Discards the
 * timeline + retirement fields - callers that want the full row should use
 * the `concept` MCP tool, not brain_ops.
 */
export function toKnownSkill(concept: Concept): KnownSkill {
    return {
        slug: concept.slug,
        name: concept.name,
        compiled_truth: concept.compiled_truth ?? concept.summary,
        score: concept.score,
        scope: { kind: concept.scope_kind, key: concept.scope_key },
        mention_count: concept.mention_count,
        last_used_at: concept.updated_at,
    };
}

/**
 * Build the per-scope exploration budget hint from the last 7 days of
 * telemetry. When scope is unknown (path / hybrid search), returns the
 * global aggregate so agents always have *some* signal to read.
 *
 * Days window is fixed at 7 to match the `profile.learned.*_7d` surfaces -
 * different windows would produce inconsistent numbers across the two
 * touchpoints.
 */
export function budgetHint(
    scopeKind: ScopeKind | null,
    scopeKey: string | null,
): ExplorationBudgetHint {
    const t = explorationCostAvoided(7);
    if (scopeKind && scopeKey) {
        const scoped = t.by_scope.find(
            (s) => s.scope_kind === scopeKind && s.scope_key === scopeKey,
        );
        if (scoped) {
            return {
                prior_tasks_in_scope: scoped.sessions,
                avg_tokens_with_skill: t.with_skill_tokens,
                avg_tokens_without_skill: t.baseline_tokens,
                estimated_savings_tokens: scoped.estimated_savings_tokens,
                skill_hit_rate: scoped.hit_rate,
            };
        }
    }
    return {
        prior_tasks_in_scope: t.total_sessions,
        avg_tokens_with_skill: t.with_skill_tokens,
        avg_tokens_without_skill: t.baseline_tokens,
        estimated_savings_tokens: t.estimated_savings_tokens,
        skill_hit_rate: t.hit_rate,
    };
}
