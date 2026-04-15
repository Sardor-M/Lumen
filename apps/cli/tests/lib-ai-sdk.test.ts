import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLumen, LumenError } from '../src/index.js';
import { withLumen, lumenTools, lumenSystemPrompt } from '../src/adapters/ai-sdk.js';
import { toolDefinitions } from '../src/tools.js';
import { resetDataDir } from '../src/utils/paths.js';
import { closeDb } from '../src/store/database.js';

let workDir: string;

beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lumen-ai-sdk-'));
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

describe('withLumen — mode handling', () => {
    it('default "profile+search" returns both system and tools', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const { system, tools } = withLumen(lumen);
        expect(system.length).toBeGreaterThan(0);
        expect(Object.keys(tools).length).toBeGreaterThan(0);
        lumen.close();
    });

    it('"profile" returns system only, no tools', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const { system, tools } = withLumen(lumen, { mode: 'profile' });
        expect(system.length).toBeGreaterThan(0);
        expect(tools).toEqual({});
        lumen.close();
    });

    it('"search" returns tools only, empty system', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const { system, tools } = withLumen(lumen, { mode: 'search' });
        expect(system).toBe('');
        expect(Object.keys(tools).length).toBeGreaterThan(0);
        lumen.close();
    });

    it('"full" exposes every registered tool (including `add`)', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const { tools } = withLumen(lumen, { mode: 'full' });
        expect(Object.keys(tools).sort()).toEqual(toolDefinitions.map((t) => t.name).sort());
        lumen.close();
    });

    it('non-full modes exclude the mutating `add` tool', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const { tools } = withLumen(lumen, { mode: 'profile+search' });
        expect(tools.add).toBeUndefined();
        expect(tools.search).toBeDefined();
        lumen.close();
    });
});

describe('withLumen — system prompt', () => {
    it('handles an empty workspace with a seed-prompt hint', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const { system } = withLumen(lumen, { mode: 'profile' });
        expect(system).toMatch(/currently empty/i);
        expect(system).toMatch(/add/);
        lumen.close();
    });

    it('includes stats and recent sources after ingestion', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const path = writeFixture(
            'a.md',
            'Self-attention is the core building block of the transformer architecture.',
        );
        await lumen.add(path);

        const { system } = withLumen(lumen, { mode: 'profile' });
        expect(system).toMatch(/1 sources/);
        expect(system).toMatch(/Recently added: a/);
        lumen.close();
    });
});

describe('withLumen — tool shape', () => {
    it('each exported tool has description, parameters, and an async execute()', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const { tools } = withLumen(lumen, { mode: 'search' });
        for (const [name, t] of Object.entries(tools)) {
            expect(typeof t.description).toBe('string');
            expect(t.parameters).toBeTypeOf('object');
            expect(typeof t.execute).toBe('function');
            void name;
        }
        lumen.close();
    });

    it('execute() routes through handleToolCall and returns the same payload', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const { tools } = withLumen(lumen, { mode: 'search' });

        const status = (await tools.status.execute({})) as { sources: number };
        expect(status.sources).toBe(0);

        const gods = await tools.god_nodes.execute({ limit: 3 });
        expect(gods).toEqual([]);
        lumen.close();
    });

    it('execute() propagates LumenError from validation failures', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const { tools } = withLumen(lumen, { mode: 'search' });
        await expect(tools.path.execute({ from: '', to: 'x' })).rejects.toThrow(LumenError);
        lumen.close();
    });
});

describe('withLumen — includeTools override', () => {
    it('narrows the exposed tool set', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const { tools } = withLumen(lumen, {
            mode: 'search',
            includeTools: ['search', 'status'],
        });
        expect(Object.keys(tools).sort()).toEqual(['search', 'status']);
        lumen.close();
    });

    it('rejects unknown tool names in includeTools', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        expect(() => withLumen(lumen, { mode: 'search', includeTools: ['bogus'] })).toThrow(
            /unknown tool/i,
        );
        lumen.close();
    });
});

describe('withLumen — jsonSchema wrapper', () => {
    it("wraps each tool's parameters when a helper is provided", () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const wrap = (schema: unknown) => ({ wrapped: true, schema });
        const { tools } = withLumen(lumen, {
            mode: 'search',
            includeTools: ['search'],
            jsonSchema: wrap,
        });
        const wrappedParams = tools.search.parameters as {
            wrapped: boolean;
            schema: { type: string };
        };
        expect(wrappedParams.wrapped).toBe(true);
        expect(wrappedParams.schema.type).toBe('object');
        lumen.close();
    });

    it('passes through raw JSON Schema when no wrapper is given', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const { tools } = withLumen(lumen, { mode: 'search', includeTools: ['status'] });
        const params = tools.status.parameters as { type: string };
        expect(params.type).toBe('object');
        lumen.close();
    });
});

describe('lumenTools — standalone', () => {
    it('returns every tool when invoked with no filter', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const tools = lumenTools(lumen);
        expect(Object.keys(tools).sort()).toEqual(toolDefinitions.map((t) => t.name).sort());
        lumen.close();
    });

    it('narrows via `include`', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const tools = lumenTools(lumen, { include: ['search'] });
        expect(Object.keys(tools)).toEqual(['search']);
        lumen.close();
    });
});

describe('lumenSystemPrompt — standalone', () => {
    it('returns a non-empty string for any workspace state', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const prompt = lumenSystemPrompt(lumen);
        expect(prompt.length).toBeGreaterThan(10);
        lumen.close();
    });
});
