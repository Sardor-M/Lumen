import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLumen, LumenError } from '../src/index.js';
import { lumenMastraTools } from '../src/adapters/mastra.js';
import { toolDefinitions } from '../src/tools.js';
import { resetDataDir } from '../src/utils/paths.js';
import { closeDb } from '../src/store/database.js';

let workDir: string;

beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lumen-mastra-'));
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

describe('lumenMastraTools — shape', () => {
    it('returns every tool by default', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const tools = lumenMastraTools(lumen);
        expect(Object.keys(tools).sort()).toEqual(toolDefinitions.map((t) => t.name).sort());
        lumen.close();
    });

    it('each tool has id, description, parameters, and async execute', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const tools = lumenMastraTools(lumen);
        for (const [name, t] of Object.entries(tools)) {
            expect(t.id).toBe(name);
            expect(typeof t.description).toBe('string');
            expect(typeof t.parameters).toBe('object');
            expect(typeof t.execute).toBe('function');
        }
        lumen.close();
    });
});

describe('lumenMastraTools — include filter', () => {
    it('narrows tools to specified subset', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const tools = lumenMastraTools(lumen, { include: ['search', 'status'] });
        expect(Object.keys(tools).sort()).toEqual(['search', 'status']);
        lumen.close();
    });

    it('rejects unknown tool names', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        expect(() => lumenMastraTools(lumen, { include: ['nope'] })).toThrow(LumenError);
        lumen.close();
    });
});

describe('lumenMastraTools — execute dispatch', () => {
    it('status tool returns workspace stats', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const tools = lumenMastraTools(lumen);
        const result = (await tools.status.execute({})) as { sources: number };
        expect(result.sources).toBe(0);
        lumen.close();
    });

    it('add → search round-trip works', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const tools = lumenMastraTools(lumen);
        const path = writeFixture(
            'a.md',
            'Reinforcement learning optimizes policies through reward signals.',
        );
        const added = (await tools.add.execute({ input: path })) as { status: string };
        expect(added.status).toBe('added');

        const results = (await tools.search.execute({
            query: 'reinforcement',
            limit: 3,
        })) as Array<{ source_title: string }>;
        expect(results.length).toBeGreaterThan(0);
        lumen.close();
    });
});
