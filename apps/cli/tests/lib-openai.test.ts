import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLumen } from '../src/index.js';
import {
    openaiTools,
    getOpenAITool,
    handleOpenAIToolCall,
    handleOpenAIToolCalls,
    type OpenAIToolCall,
} from '../src/adapters/openai.js';
import { toolDefinitions } from '../src/tools.js';
import { resetDataDir } from '../src/utils/paths.js';
import { closeDb } from '../src/store/database.js';

let workDir: string;

beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lumen-openai-'));
});

afterEach(() => {
    try {
        closeDb();
    } catch {
        /** Already closed. */
    }
    resetDataDir();
    rmSync(workDir, { recursive: true, force: true });
});

function writeFixture(name: string, content: string): string {
    const path = join(workDir, name);
    writeFileSync(path, content, 'utf-8');
    return path;
}

function call(id: string, name: string, args: Record<string, unknown>): OpenAIToolCall {
    return {
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
    };
}

describe('openaiTools — envelope shape', () => {
    it('wraps every tool definition in OpenAI "function" shape', () => {
        expect(openaiTools.length).toBe(toolDefinitions.length);
        for (const t of openaiTools) {
            expect(t.type).toBe('function');
            expect(typeof t.function.name).toBe('string');
            expect(typeof t.function.description).toBe('string');
            expect(t.function.parameters).toBeTypeOf('object');
        }
    });

    it('is deep-frozen so consumers cannot mutate the envelope', () => {
        expect(Object.isFrozen(openaiTools)).toBe(true);
        expect(Object.isFrozen(openaiTools[0])).toBe(true);
        expect(Object.isFrozen(openaiTools[0].function)).toBe(true);
    });

    it('preserves tool name ordering from toolDefinitions', () => {
        const libNames = toolDefinitions.map((t) => t.name);
        const openaiNames = openaiTools.map((t) => t.function.name);
        expect(openaiNames).toEqual(libNames);
    });
});

describe('getOpenAITool', () => {
    it('returns a single tool by name', () => {
        const t = getOpenAITool('search');
        expect(t?.function.name).toBe('search');
    });

    it('returns undefined for unknown tools', () => {
        expect(getOpenAITool('nope')).toBeUndefined();
    });
});

describe('handleOpenAIToolCall — success path', () => {
    it('returns { role: "tool", tool_call_id, content } with JSON-stringified result', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const msg = await handleOpenAIToolCall(lumen, call('call_abc', 'status', {}));
        expect(msg.role).toBe('tool');
        expect(msg.tool_call_id).toBe('call_abc');
        const parsed = JSON.parse(msg.content);
        expect(parsed.sources).toBe(0);
        lumen.close();
    });

    it('routes add() then search() end-to-end', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const path = writeFixture(
            'seed.md',
            'The transformer architecture relies on self-attention to weigh token relationships.',
        );

        const addMsg = await handleOpenAIToolCall(lumen, call('call_1', 'add', { input: path }));
        const added = JSON.parse(addMsg.content);
        expect(added.status).toBe('added');

        const searchMsg = await handleOpenAIToolCall(
            lumen,
            call('call_2', 'search', { query: 'attention', limit: 3 }),
        );
        const results = JSON.parse(searchMsg.content);
        expect(Array.isArray(results)).toBe(true);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].source_title).toMatch(/seed/);
        lumen.close();
    });
});

describe('handleOpenAIToolCall — error capture', () => {
    it('returns a tool-role error payload when the underlying call throws', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const msg = await handleOpenAIToolCall(
            lumen,
            call('call_err', 'path', { from: '', to: 'x' }),
        );
        expect(msg.role).toBe('tool');
        expect(msg.tool_call_id).toBe('call_err');
        const parsed = JSON.parse(msg.content);
        expect(parsed.error).toBe('INVALID_ARGUMENT');
        expect(parsed.message).toMatch(/non-empty/);
        lumen.close();
    });

    it('captures unknown-tool errors without re-throwing', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const msg = await handleOpenAIToolCall(lumen, call('call_x', 'bogus', {}));
        const parsed = JSON.parse(msg.content);
        expect(parsed.error).toBe('INVALID_ARGUMENT');
        expect(parsed.message).toMatch(/Unknown tool/);
        lumen.close();
    });

    it('handles malformed JSON arguments as an INVALID_ARGUMENT tool response', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const bad: OpenAIToolCall = {
            id: 'call_bad',
            type: 'function',
            function: { name: 'search', arguments: '{not valid json' },
        };
        const msg = await handleOpenAIToolCall(lumen, bad);
        const parsed = JSON.parse(msg.content);
        expect(parsed.error).toBe('INVALID_ARGUMENT');
        expect(parsed.message).toMatch(/parse arguments/);
        lumen.close();
    });

    it('treats empty arguments string as `{}`', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const msg = await handleOpenAIToolCall(lumen, {
            id: 'call_empty',
            type: 'function',
            function: { name: 'status', arguments: '' },
        });
        const parsed = JSON.parse(msg.content);
        expect(parsed.sources).toBe(0);
        lumen.close();
    });
});

describe('handleOpenAIToolCall — envelope validation', () => {
    it('throws a LumenError when `id` is missing (caller bug, not a model error)', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        await expect(
            handleOpenAIToolCall(lumen, {
                id: '',
                function: { name: 'status', arguments: '{}' },
            } as OpenAIToolCall),
        ).rejects.toThrow(/missing `id`/);
        lumen.close();
    });

    it('throws when `function.name` is missing', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        await expect(
            handleOpenAIToolCall(lumen, {
                id: 'x',
                function: { name: '', arguments: '{}' },
            } as OpenAIToolCall),
        ).rejects.toThrow(/missing `function\.name`/);
        lumen.close();
    });
});

describe('handleOpenAIToolCalls — batch', () => {
    it('runs calls sequentially and returns results in order', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const results = await handleOpenAIToolCalls(lumen, [
            call('a', 'status', {}),
            call('b', 'god_nodes', { limit: 3 }),
        ]);
        expect(results.map((r) => r.tool_call_id)).toEqual(['a', 'b']);
        expect(JSON.parse(results[0].content).sources).toBe(0);
        expect(JSON.parse(results[1].content)).toEqual([]);
        lumen.close();
    });
});
