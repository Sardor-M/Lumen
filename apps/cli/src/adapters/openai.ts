/**
 * OpenAI function-calling adapter for Lumen.
 *
 * Wraps the provider-agnostic `toolDefinitions` from `@lumen/cli/tools` into
 * OpenAI's Chat Completions envelope and dispatches `tool_calls[i]` back to
 * the underlying Lumen instance.
 *
 *     import OpenAI from 'openai';
 *     import { createLumen } from '@lumen/cli';
 *     import { openaiTools, handleOpenAIToolCall } from '@lumen/cli/openai';
 *
 *     const lumen = createLumen({ dataDir: '~/.lumen' });
 *     const client = new OpenAI();
 *
 *     const first = await client.chat.completions.create({
 *         model: 'gpt-4o',
 *         messages,
 *         tools: openaiTools,
 *     });
 *
 *     for (const call of first.choices[0].message.tool_calls ?? []) {
 *         const toolMsg = await handleOpenAIToolCall(lumen, call);
 *         messages.push(first.choices[0].message, toolMsg);
 *     }
 *
 *     const final = await client.chat.completions.create({ model, messages });
 *
 * Zero runtime dependency on `openai` — types are structural so host apps
 * can plug in any SDK version (or the raw Responses/Assistants API) that
 * matches the shape.
 */

import type { Lumen } from '../index.js';
import { toolDefinitions, handleToolCall } from '../tools.js';
import { LumenError } from '../lib/errors.js';

/* ─── OpenAI envelope types (structural, dep-free) ─── */

export type OpenAITool = {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
};

export type OpenAIToolCall = {
    id: string;
    type?: 'function';
    function: {
        name: string;
        /** OpenAI always stringifies the arguments JSON. */
        arguments: string;
    };
};

export type OpenAIToolMessage = {
    role: 'tool';
    tool_call_id: string;
    content: string;
};

/**
 * Lumen tool definitions pre-wrapped in OpenAI's `{ type: 'function', ... }`
 * envelope. Pass directly to `chat.completions.create({ tools })`.
 *
 * Frozen — do not mutate. Build a new array if you need to extend or filter.
 */
export const openaiTools: readonly OpenAITool[] = Object.freeze(
    toolDefinitions.map(
        (t): OpenAITool =>
            Object.freeze({
                type: 'function',
                function: Object.freeze({
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                }),
            }),
    ),
);

/**
 * Convenience accessor for a single tool envelope. Returns `undefined` when
 * the name isn't registered.
 */
export function getOpenAITool(name: string): OpenAITool | undefined {
    return openaiTools.find((t) => t.function.name === name);
}

/**
 * Dispatch a single OpenAI `tool_calls[i]` against the Lumen instance.
 * Returns the `{ role: 'tool', tool_call_id, content }` message ready to
 * append to the conversation.
 *
 * Tool failures (`LumenError`, `IngestError`, anything thrown by the engine)
 * are captured into a JSON error payload rather than re-thrown — OpenAI's
 * flow expects a tool message even on failure so the model can react.
 * Callers wanting the raw error can use `handleToolCall` from `./tools`.
 */
export async function handleOpenAIToolCall(
    lumen: Lumen,
    call: OpenAIToolCall,
): Promise<OpenAIToolMessage> {
    const name = call.function?.name;
    const rawArgs = call.function?.arguments ?? '{}';

    if (!call.id || typeof call.id !== 'string') {
        throw new LumenError('INVALID_ARGUMENT', 'handleOpenAIToolCall: missing `id` on tool call');
    }
    if (!name) {
        throw new LumenError(
            'INVALID_ARGUMENT',
            'handleOpenAIToolCall: missing `function.name` on tool call',
        );
    }

    let args: Record<string, unknown>;
    try {
        args = parseArgs(rawArgs);
    } catch (err) {
        return {
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({
                error: 'INVALID_ARGUMENT',
                message: `Could not parse arguments JSON: ${err instanceof Error ? err.message : String(err)}`,
            }),
        };
    }

    try {
        const result = await handleToolCall(lumen, { name, arguments: args });
        return {
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(result ?? null),
        };
    } catch (err) {
        /** Return the error as content so the conversation can continue.
         *  Shape mirrors the typed-error surface of LumenError for
         *  adapters that want to branch on `code`. */
        const payload =
            err instanceof LumenError
                ? { error: err.code, message: err.message, hint: err.hint }
                : { error: 'UNKNOWN', message: err instanceof Error ? err.message : String(err) };
        return {
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(payload),
        };
    }
}

/**
 * Batch convenience — run every `tool_calls[i]` from a single assistant
 * message and return the matching tool-role messages in order. Runs
 * sequentially so store writes (e.g. two consecutive `add` calls) observe
 * each other, matching the single-process semantics of the engine.
 */
export async function handleOpenAIToolCalls(
    lumen: Lumen,
    calls: readonly OpenAIToolCall[],
): Promise<OpenAIToolMessage[]> {
    const out: OpenAIToolMessage[] = [];
    for (const call of calls) {
        out.push(await handleOpenAIToolCall(lumen, call));
    }
    return out;
}

function parseArgs(raw: string): Record<string, unknown> {
    if (!raw || raw.trim() === '') return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('arguments JSON must decode to an object');
    }
    return parsed as Record<string, unknown>;
}
