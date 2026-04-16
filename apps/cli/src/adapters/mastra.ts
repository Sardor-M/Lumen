/**
 * Mastra agent-framework adapter for Lumen.
 *
 * Returns Lumen tool definitions shaped for Mastra's `Agent({ tools })` map.
 * Each tool has `id`, `description`, `parameters` (JSON Schema), and an
 * async `execute`. Mastra users who need strict Zod validation can wrap
 * these with `createTool()` from `@mastra/core` — this adapter ships
 * zero-dep so consumers don't pay for `@mastra/core` unless they use it.
 *
 *     import { Agent } from '@mastra/core';
 *     import { createLumen } from '@lumen/cli';
 *     import { lumenMastraTools } from '@lumen/cli/mastra';
 *
 *     const lumen = createLumen({ dataDir: '~/.lumen' });
 *
 *     const agent = new Agent({
 *         tools: lumenMastraTools(lumen),
 *     });
 */

import type { Lumen } from '../index.js';
import { toolDefinitions, handleToolCall } from '../tools.js';
import { LumenError } from '../lib/errors.js';

/**
 * Mastra tool shape — structurally matches what `Agent({ tools })` accepts.
 * Generic on output because Mastra infers return types from the execute fn.
 */
export type MastraTool = {
    id: string;
    description: string;
    /** JSON Schema for the tool input. Mastra can validate this or the
     *  user can wrap it with `z.object()` via `createTool`. */
    parameters: Record<string, unknown>;
    execute: (input: Record<string, unknown>) => Promise<unknown>;
};

export type MastraToolsOptions = {
    /** Restrict tools to a specific subset. Default: all registered tools. */
    include?: readonly string[];
};

/**
 * Build a Mastra-compatible tools map keyed by tool name.
 *
 * Usage with raw Agent:
 *     const agent = new Agent({ tools: lumenMastraTools(lumen) });
 *
 * Usage with `createTool` (adds Zod validation):
 *     import { createTool } from '@mastra/core';
 *     import { z } from 'zod';
 *     const raw = lumenMastraTools(lumen);
 *     const searchTool = createTool({
 *         id: raw.search.id,
 *         description: raw.search.description,
 *         inputSchema: z.object({ query: z.string(), limit: z.number().optional() }),
 *         execute: raw.search.execute,
 *     });
 */
export function lumenMastraTools(
    lumen: Lumen,
    opts: MastraToolsOptions = {},
): Record<string, MastraTool> {
    const allowed = resolveAllowed(opts.include);
    const out: Record<string, MastraTool> = {};

    for (const def of toolDefinitions) {
        if (!allowed.has(def.name)) continue;
        out[def.name] = {
            id: def.name,
            description: def.description,
            parameters: def.parameters,
            execute: async (input: Record<string, unknown>) => {
                return handleToolCall(lumen, { name: def.name, arguments: input });
            },
        };
    }
    return out;
}

function resolveAllowed(include: readonly string[] | undefined): Set<string> {
    if (!include || include.length === 0) {
        return new Set(toolDefinitions.map((t) => t.name));
    }
    const known = new Set(toolDefinitions.map((t) => t.name));
    for (const name of include) {
        if (!known.has(name)) {
            throw new LumenError('INVALID_ARGUMENT', `lumenMastraTools(): unknown tool "${name}"`);
        }
    }
    return new Set(include);
}
