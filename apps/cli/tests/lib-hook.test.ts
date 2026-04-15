import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLumen, type LumenCallEvent } from '../src/index.js';
import { resetDataDir } from '../src/utils/paths.js';
import { closeDb } from '../src/store/database.js';

let workDir: string;

beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lumen-hook-'));
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

/** Capture-every-event helper shared by the suites below. */
function collector() {
    const events: LumenCallEvent[] = [];
    return {
        events,
        hook: (e: LumenCallEvent) => {
            events.push(e);
        },
    };
}

describe('onCall — sync method (status)', () => {
    it('fires start then success with matching call_id', () => {
        const c = collector();
        const lumen = createLumen({ dataDir: workDir, autoInit: true, onCall: c.hook });

        const result = lumen.status();
        expect(result.sources).toBe(0);

        expect(c.events).toHaveLength(2);
        expect(c.events[0].phase).toBe('start');
        expect(c.events[0].name).toBe('status');
        expect(c.events[1].phase).toBe('success');
        expect(c.events[0].call_id).toBe(c.events[1].call_id);
        lumen.close();
    });

    it('success event carries the return value and a non-negative duration', () => {
        const c = collector();
        const lumen = createLumen({ dataDir: workDir, autoInit: true, onCall: c.hook });
        lumen.status();

        const end = c.events[1];
        if (end.phase !== 'success') throw new Error('unreachable');
        expect(end.duration_ms).toBeGreaterThanOrEqual(0);
        expect((end.result as { sources: number }).sources).toBe(0);
        lumen.close();
    });
});

describe('onCall — async method (add)', () => {
    it('fires start then success for a resolved promise', async () => {
        const c = collector();
        const lumen = createLumen({ dataDir: workDir, autoInit: true, onCall: c.hook });

        const path = writeFixture('a.md', 'content for hook async test');
        await lumen.add(path);

        const addEvents = c.events.filter((e) => e.name === 'add');
        expect(addEvents).toHaveLength(2);
        expect(addEvents[0].phase).toBe('start');
        expect(addEvents[1].phase).toBe('success');
        expect(addEvents[0].call_id).toBe(addEvents[1].call_id);
        lumen.close();
    });

    it('captures the first positional argument on start', async () => {
        const c = collector();
        const lumen = createLumen({ dataDir: workDir, autoInit: true, onCall: c.hook });

        const path = writeFixture('a.md', 'content');
        await lumen.add(path);

        const start = c.events.find((e) => e.phase === 'start' && e.name === 'add');
        expect(start?.args).toBe(path);
        lumen.close();
    });
});

describe('onCall — error paths', () => {
    it('fires start then error for a sync throw', () => {
        const c = collector();
        const lumen = createLumen({ dataDir: workDir, autoInit: true, onCall: c.hook });

        expect(() => lumen.graph.path('', 'x')).toThrow();

        const pathEvents = c.events.filter((e) => e.name === 'graph.path');
        expect(pathEvents).toHaveLength(2);
        expect(pathEvents[0].phase).toBe('start');
        expect(pathEvents[1].phase).toBe('error');
        if (pathEvents[1].phase !== 'error') throw new Error('unreachable');
        expect(pathEvents[1].error).toBeInstanceOf(Error);
        lumen.close();
    });

    it('fires start then error for an async rejection and re-throws the original', async () => {
        const c = collector();
        const lumen = createLumen({ dataDir: workDir, autoInit: true, onCall: c.hook });

        await expect(lumen.add('')).rejects.toThrow(/non-empty/);

        const addEvents = c.events.filter((e) => e.name === 'add');
        expect(addEvents).toHaveLength(2);
        expect(addEvents[1].phase).toBe('error');
        lumen.close();
    });
});

describe('onCall — namespaced names', () => {
    it('dots the method path for namespaced calls', () => {
        const c = collector();
        const lumen = createLumen({ dataDir: workDir, autoInit: true, onCall: c.hook });

        lumen.sources.count();
        lumen.concepts.count();
        lumen.chunks.count();
        lumen.graph.godNodes();

        const names = c.events.filter((e) => e.phase === 'start').map((e) => e.name);
        expect(names).toContain('sources.count');
        expect(names).toContain('concepts.count');
        expect(names).toContain('chunks.count');
        expect(names).toContain('graph.godNodes');
        lumen.close();
    });
});

describe('onCall — call_id uniqueness', () => {
    it('mints a fresh call_id per invocation', () => {
        const c = collector();
        const lumen = createLumen({ dataDir: workDir, autoInit: true, onCall: c.hook });

        lumen.status();
        lumen.status();
        lumen.status();

        const startIds = c.events
            .filter((e) => e.phase === 'start' && e.name === 'status')
            .map((e) => e.call_id);
        expect(startIds).toHaveLength(3);
        expect(new Set(startIds).size).toBe(3);
        lumen.close();
    });
});

describe('onCall — robustness', () => {
    it('swallows hook errors without breaking the underlying call', () => {
        const lumen = createLumen({
            dataDir: workDir,
            autoInit: true,
            onCall: () => {
                throw new Error('hook boom');
            },
        });

        expect(() => lumen.status()).not.toThrow();
        lumen.close();
    });

    it('swallows hook errors on success AND error phases', async () => {
        let calls = 0;
        const lumen = createLumen({
            dataDir: workDir,
            autoInit: true,
            onCall: () => {
                calls++;
                throw new Error('always breaks');
            },
        });

        await expect(lumen.add('')).rejects.toThrow(/non-empty/);
        /** start + error both fire; both throw; library still returns cleanly. */
        expect(calls).toBe(2);
        lumen.close();
    });
});

describe('onCall — opt-out semantics', () => {
    it('omitting the hook leaves behavior unchanged', () => {
        /** If the wrap layer had a bug when onCall is undefined, this would
         *  surface (e.g. a wrapped sync method accidentally becoming async). */
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const result = lumen.status();
        expect(typeof result).toBe('object');
        expect(result.sources).toBe(0);
        lumen.close();
    });
});

describe('onCall — return types preserved', () => {
    it('wrapped sync methods still return values synchronously', () => {
        const c = collector();
        const lumen = createLumen({ dataDir: workDir, autoInit: true, onCall: c.hook });

        const result = lumen.status();
        /** Not a Promise — status() is sync. If the wrap layer accidentally
         *  wrapped it in a Promise, this assertion catches it. */
        expect(result).not.toBeInstanceOf(Promise);
        lumen.close();
    });

    it('wrapped async methods still return a Promise', () => {
        const c = collector();
        const lumen = createLumen({ dataDir: workDir, autoInit: true, onCall: c.hook });

        const p = lumen.add(writeFixture('a.md', 'content for promise check'));
        expect(p).toBeInstanceOf(Promise);
        return p.then(() => lumen.close());
    });
});
