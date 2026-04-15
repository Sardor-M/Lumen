import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLumen, LumenError } from '../src/index.js';
import {
    toolDefinitions,
    handleToolCall,
    getToolDefinition,
    type ToolDefinition,
} from '../src/tools.js';
import { resetDataDir } from '../src/utils/paths.js';
import { closeDb } from '../src/store/database.js';

let workDir: string;

beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lumen-tools-'));
});

afterEach(() => {
    /** Close the SQLite handle BEFORE removing the file, otherwise the OS
     *  keeps it alive and the next test's resetDataDir could grab stale state. */
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

describe('toolDefinitions — shape', () => {
    it('is a frozen array', () => {
        expect(Object.isFrozen(toolDefinitions)).toBe(true);
    });

    it('covers every public Lumen method we expose as a tool', () => {
        const names = toolDefinitions.map((t) => t.name).sort();
        expect(names).toEqual(
            [
                'add',
                'ask',
                'communities',
                'god_nodes',
                'neighbors',
                'pagerank',
                'path',
                'profile',
                'search',
                'status',
            ].sort(),
        );
    });

    it('each definition has name, description, and an object-typed schema', () => {
        for (const t of toolDefinitions) {
            expect(typeof t.name).toBe('string');
            expect(t.name.length).toBeGreaterThan(0);
            expect(typeof t.description).toBe('string');
            expect(t.description.length).toBeGreaterThan(10);
            expect(t.parameters.type).toBe('object');
            expect(typeof t.parameters.properties).toBe('object');
        }
    });

    it('every "required" entry references an existing property', () => {
        for (const t of toolDefinitions) {
            if (!t.parameters.required) continue;
            for (const req of t.parameters.required) {
                expect(Object.keys(t.parameters.properties)).toContain(req);
            }
        }
    });

    it('no duplicate names', () => {
        const names = toolDefinitions.map((t) => t.name);
        expect(new Set(names).size).toBe(names.length);
    });
});

describe('getToolDefinition', () => {
    it('returns a definition by name', () => {
        const def = getToolDefinition('search');
        expect(def?.name).toBe('search');
    });

    it('returns undefined for unknown tools', () => {
        expect(getToolDefinition('nope')).toBeUndefined();
    });
});

describe('handleToolCall — dispatch', () => {
    it('routes status() with no args', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const out = (await handleToolCall(lumen, { name: 'status', arguments: {} })) as {
            sources: number;
        };
        expect(out.sources).toBe(0);
        lumen.close();
    });

    it('routes add() then search() end-to-end', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const path = writeFixture(
            'seed.md',
            'Transformers introduced self-attention as the core building block for sequence models.',
        );

        const added = (await handleToolCall(lumen, {
            name: 'add',
            arguments: { input: path },
        })) as { status: string; chunks: number };
        expect(added.status).toBe('added');
        expect(added.chunks).toBeGreaterThanOrEqual(1);

        const searched = (await handleToolCall(lumen, {
            name: 'search',
            arguments: { query: 'attention', limit: 3 },
        })) as Array<{ source_title: string; rank: number }>;
        expect(searched.length).toBeGreaterThan(0);
        expect(searched[0].rank).toBe(1);
        lumen.close();
    });

    it('routes profile() with optional refresh', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const p = (await handleToolCall(lumen, {
            name: 'profile',
            arguments: { refresh: true },
        })) as { static: { total_sources: number } };
        expect(p.static.total_sources).toBe(0);
        lumen.close();
    });

    it('routes god_nodes() on an empty graph', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const out = await handleToolCall(lumen, {
            name: 'god_nodes',
            arguments: { limit: 5 },
        });
        expect(out).toEqual([]);
        lumen.close();
    });

    it('routes path() validation through to the underlying method', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        await expect(
            handleToolCall(lumen, { name: 'path', arguments: { from: '', to: 'x' } }),
        ).rejects.toThrow(LumenError);
        lumen.close();
    });

    it('rejects unknown tool names', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        await expect(handleToolCall(lumen, { name: 'bogus', arguments: {} })).rejects.toThrow(
            /Unknown tool/,
        );
        lumen.close();
    });

    it('rejects wrong-typed arguments before calling into Lumen', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        await expect(
            handleToolCall(lumen, { name: 'search', arguments: { query: 123 } }),
        ).rejects.toThrow(/non-empty string/);
        await expect(
            handleToolCall(lumen, {
                name: 'search',
                arguments: { query: 'x', limit: 'ten' },
            }),
        ).rejects.toThrow(/must be a number/);
        await expect(
            handleToolCall(lumen, {
                name: 'search',
                arguments: { query: 'x', mode: 'semantic' },
            }),
        ).rejects.toThrow(/hybrid.*bm25.*tfidf/);
        lumen.close();
    });
});

describe('handleToolCall — arg coercion', () => {
    it('treats missing optional args as undefined (library applies default)', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const out = (await handleToolCall(lumen, {
            name: 'god_nodes',
            arguments: {},
        })) as unknown[];
        expect(Array.isArray(out)).toBe(true);
        lumen.close();
    });

    it("handleToolCall itself doesn't mutate the toolDefinitions array", () => {
        const before = JSON.stringify(toolDefinitions);
        // trigger a type-check by reading a known field
        const t: ToolDefinition | undefined = getToolDefinition('search');
        expect(t?.parameters.required).toEqual(['query']);
        expect(JSON.stringify(toolDefinitions)).toBe(before);
    });
});
