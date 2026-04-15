/**
 * Vercel AI SDK adapter for Lumen.
 *
 * Exposes Lumen as a pair of ingredients callers spread into any AI SDK
 * generation call — a system-prompt preamble built from the workspace
 * profile, plus a `tools` map that matches the SDK's `CoreTool` shape.
 *
 *     import { generateText } from 'ai';
 *     import { openai } from '@ai-sdk/openai';
 *     import { createLumen } from '@lumen/cli';
 *     import { withLumen } from '@lumen/cli/ai-sdk';
 *
 *     const lumen = createLumen({ dataDir: '~/.lumen' });
 *     const { system, tools } = withLumen(lumen, { mode: 'profile+search' });
 *
 *     const { text } = await generateText({
 *         model: openai('gpt-4o'),
 *         system,
 *         tools,
 *         prompt: 'What do you know about transformers?',
 *     });
 *
 * Modes (spec lifted from the Phase 6 roadmap):
 * - `'profile'`        — system prompt only, no tools
 * - `'search'`         — tools only, no system injection
 * - `'profile+search'` — both (default)
 * - `'full'`           — profile injection + every registered tool
 *
 * Why a `withLumen()` helper and NOT a model wrapper:
 * Implementing `LanguageModelV1/V2` correctly means matching 20+ internal
 * SDK method signatures that change across minor releases. A helper that
 * returns `{ system, tools }` stays compatible with every AI SDK version
 * that accepts those same shapes (v3+ through today) and leaves the user
 * in full control of model selection, streaming, retries, and caching.
 *
 * Structural typing — no runtime dependency on `ai` or `zod`. If your AI
 * SDK version requires parameters wrapped via the `jsonSchema()` helper,
 * pass it in via `jsonSchema: fromAi`; otherwise the raw JSON Schema is
 * used directly, which works in all v3+ releases.
 */

import type { Lumen } from '../index.js';
import { toolDefinitions, handleToolCall } from '../tools.js';
import { LumenError } from '../lib/errors.js';

export type LumenMode = 'profile' | 'search' | 'profile+search' | 'full';

/**
 * A tool in the shape the Vercel AI SDK's `tools` map expects. Structural
 * only — matches `CoreTool` from `ai` without importing it.
 */
export type AiSdkTool = {
    description: string;
    parameters: unknown;
    execute: (args: Record<string, unknown>) => Promise<unknown>;
};

export type WithLumenOptions = {
    mode?: LumenMode;
    /**
     * Cap the number of tools exposed. `mode: 'search'` (default) returns a
     * curated read-only subset; `mode: 'full'` exposes everything incl. `add`.
     */
    includeTools?: readonly string[];
    /**
     * Optional `jsonSchema()` wrapper from `ai` — wrap each tool's JSON
     * Schema when provided. Leave undefined for AI SDK versions that accept
     * raw JSON Schema objects (v3+).
     */
    jsonSchema?: (schema: unknown) => unknown;
};

export type WithLumenResult = {
    /** Combined system prompt (empty string when mode excludes the profile). */
    system: string;
    /** Tool map keyed by tool name (empty object when mode excludes tools). */
    tools: Record<string, AiSdkTool>;
};

/** Read-only, side-effect-free tools for the default `'search'` / `'profile+search'` modes. */
const READ_ONLY_TOOL_NAMES: readonly string[] = [
    'search',
    'status',
    'profile',
    'god_nodes',
    'pagerank',
    'neighbors',
    'path',
    'communities',
];

/**
 * Build the pair of `{ system, tools }` ingredients the AI SDK expects.
 */
export function withLumen(lumen: Lumen, opts: WithLumenOptions = {}): WithLumenResult {
    const mode: LumenMode = opts.mode ?? 'profile+search';
    const wantsProfile = mode === 'profile' || mode === 'profile+search' || mode === 'full';
    const wantsTools = mode === 'search' || mode === 'profile+search' || mode === 'full';

    const system = wantsProfile ? buildSystemPrompt(lumen) : '';
    const tools = wantsTools ? buildToolMap(lumen, mode, opts) : {};

    return { system, tools };
}

/**
 * Just the tools map — useful when the caller is maintaining their own
 * system prompt and only wants Lumen's tool surface.
 */
export function lumenTools(
    lumen: Lumen,
    opts: { include?: readonly string[]; jsonSchema?: WithLumenOptions['jsonSchema'] } = {},
): Record<string, AiSdkTool> {
    return buildToolMap(lumen, 'full', {
        includeTools: opts.include,
        jsonSchema: opts.jsonSchema,
    });
}

/**
 * Just the system prompt — for callers who want to merge it into an
 * existing preamble (e.g. agent personality + Lumen context).
 */
export function lumenSystemPrompt(lumen: Lumen): string {
    return buildSystemPrompt(lumen);
}

/* ─── implementation ─── */

function buildSystemPrompt(lumen: Lumen): string {
    const s = lumen.status();
    if (s.sources === 0 && s.concepts === 0) {
        return 'You have access to a local Lumen knowledge base, but it is currently empty. Suggest the user ingest sources with the `add` tool before asking questions.';
    }

    /** Profile rebuild is cached; first call is ~100ms, subsequent <5ms. */
    const p = lumen.profile();
    const godNames = p.static.god_nodes
        .slice(0, 5)
        .map((g) => g.name)
        .join(', ');
    const recent = p.dynamic.recent_sources
        .slice(0, 3)
        .map((r) => r.title)
        .join('; ');

    const lines = [
        'You have access to a local Lumen knowledge base.',
        `Stats: ${p.static.total_sources} sources, ${p.static.total_concepts} concepts, ${p.static.total_edges} edges.`,
    ];
    if (godNames) lines.push(`Top concepts: ${godNames}.`);
    if (recent) lines.push(`Recently added: ${recent}.`);
    lines.push(
        'Prefer the provided Lumen tools for searching, graph traversal, and Q&A over guessing or external sources.',
    );
    return lines.join(' ');
}

function buildToolMap(
    lumen: Lumen,
    mode: LumenMode,
    opts: WithLumenOptions,
): Record<string, AiSdkTool> {
    const allow = resolveAllowedTools(mode, opts.includeTools);
    const out: Record<string, AiSdkTool> = {};

    for (const def of toolDefinitions) {
        if (!allow.has(def.name)) continue;
        out[def.name] = {
            description: def.description,
            parameters: opts.jsonSchema ? opts.jsonSchema(def.parameters) : def.parameters,
            execute: async (args: Record<string, unknown>) => {
                return handleToolCall(lumen, { name: def.name, arguments: args });
            },
        };
    }
    return out;
}

function resolveAllowedTools(
    mode: LumenMode,
    includeTools: readonly string[] | undefined,
): Set<string> {
    if (includeTools && includeTools.length > 0) {
        const known = new Set(toolDefinitions.map((t) => t.name));
        for (const name of includeTools) {
            if (!known.has(name)) {
                throw new LumenError(
                    'INVALID_ARGUMENT',
                    `withLumen(): unknown tool in \`includeTools\`: "${name}"`,
                );
            }
        }
        return new Set(includeTools);
    }
    if (mode === 'full') {
        return new Set(toolDefinitions.map((t) => t.name));
    }
    return new Set(READ_ONLY_TOOL_NAMES);
}
