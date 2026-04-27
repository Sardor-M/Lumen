import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { setDataDir, resetDataDir } from '../src/utils/paths.js';
import { getDb, resetDb } from '../src/store/database.js';
import { normalizeGitRemote } from '../src/scope/normalize.js';
import { resolveCodebaseScope, findProjectRoot } from '../src/scope/codebase.js';
import { detectFrameworks } from '../src/scope/framework.js';
import { detectLanguages } from '../src/scope/language.js';
import { resolveScopes } from '../src/scope/index.js';
import {
    upsertScope,
    getScope,
    listScopes,
    touchScope,
    setScopeLabel,
    countScopes,
} from '../src/store/scopes.js';
import { insertSource } from '../src/store/sources.js';
import { upsertConcept, getConcept } from '../src/store/concepts.js';

let workDir: string;

beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lumen-scope-'));
});

afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
});

function initGitRepo(path: string, remoteUrl?: string): void {
    spawnSync('git', ['init', '-q', '--initial-branch=main', path], { stdio: 'ignore' });
    spawnSync('git', ['-C', path, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
    spawnSync('git', ['-C', path, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
    if (remoteUrl) {
        spawnSync('git', ['-C', path, 'remote', 'add', 'origin', remoteUrl], { stdio: 'ignore' });
    }
}

describe('normalizeGitRemote', () => {
    it('normalizes SSH form to HTTPS', () => {
        expect(normalizeGitRemote('git@github.com:Sardor-M/Lumen.git')).toBe(
            'https://github.com/sardor-m/lumen',
        );
    });

    it('normalizes HTTPS with .git suffix', () => {
        expect(normalizeGitRemote('https://github.com/Sardor-M/Lumen.git')).toBe(
            'https://github.com/sardor-m/lumen',
        );
    });

    it('strips embedded credentials', () => {
        expect(
            normalizeGitRemote('https://x-access-token:abc123@github.com/Sardor-M/Lumen.git'),
        ).toBe('https://github.com/sardor-m/lumen');
    });

    it('strips trailing slash', () => {
        expect(normalizeGitRemote('https://github.com/Sardor-M/Lumen/')).toBe(
            'https://github.com/sardor-m/lumen',
        );
    });

    it('strips query string and fragment', () => {
        expect(normalizeGitRemote('https://github.com/sardor-m/lumen?ref=main#readme')).toBe(
            'https://github.com/sardor-m/lumen',
        );
    });

    it('produces the same output for SSH and HTTPS forms', () => {
        const ssh = normalizeGitRemote('git@github.com:Sardor-M/Lumen.git');
        const https = normalizeGitRemote('https://github.com/Sardor-M/Lumen');
        expect(ssh).toBe(https);
    });

    it('returns null for empty input', () => {
        expect(normalizeGitRemote('')).toBeNull();
        expect(normalizeGitRemote('   ')).toBeNull();
    });

    it('returns null for non-URL garbage', () => {
        expect(normalizeGitRemote('not a url at all')).toBeNull();
    });
});

describe('findProjectRoot', () => {
    it('walks up to a directory containing package.json', () => {
        writeFileSync(join(workDir, 'package.json'), '{}');
        const nested = join(workDir, 'src', 'deeply', 'nested');
        mkdirSync(nested, { recursive: true });
        expect(findProjectRoot(nested)).toBe(workDir);
    });

    it('walks up to a directory containing .git', () => {
        mkdirSync(join(workDir, '.git'));
        const nested = join(workDir, 'src');
        mkdirSync(nested);
        expect(findProjectRoot(nested)).toBe(workDir);
    });

    it('falls back to cwd when no marker is found', () => {
        const nested = join(workDir, 'a', 'b');
        mkdirSync(nested, { recursive: true });
        const result = findProjectRoot(nested);
        /** Either cwd itself or a real ancestor (filesystem might have markers above tmp). */
        expect([nested, workDir]).toContain(result);
    });
});

describe('resolveCodebaseScope', () => {
    it('uses git remote when available', () => {
        initGitRepo(workDir, 'git@github.com:Sardor-M/Lumen.git');
        const scope = resolveCodebaseScope(workDir);
        expect(scope.source).toBe('git-remote');
        expect(scope.origin).toBe('https://github.com/sardor-m/lumen');
        expect(scope.key).toMatch(/^[a-f0-9]{16}$/);
        expect(scope.root).toBe(workDir);
    });

    it('produces the same key for SSH and HTTPS clones of the same repo', () => {
        const sshDir = mkdtempSync(join(tmpdir(), 'lumen-scope-ssh-'));
        const httpsDir = mkdtempSync(join(tmpdir(), 'lumen-scope-https-'));
        try {
            initGitRepo(sshDir, 'git@github.com:Sardor-M/Lumen.git');
            initGitRepo(httpsDir, 'https://github.com/Sardor-M/Lumen.git');
            const a = resolveCodebaseScope(sshDir);
            const b = resolveCodebaseScope(httpsDir);
            expect(a.key).toBe(b.key);
        } finally {
            rmSync(sshDir, { recursive: true, force: true });
            rmSync(httpsDir, { recursive: true, force: true });
        }
    });

    it('falls back to fingerprint when no git remote', () => {
        writeFileSync(
            join(workDir, 'package.json'),
            JSON.stringify({ name: 'tester', version: '1.0.0' }),
        );
        const scope = resolveCodebaseScope(workDir);
        expect(scope.source).toBe('fingerprint');
        expect(scope.key).toMatch(/^[a-f0-9]{16}$/);
    });

    it('falls back to local-* path SHA1 when no git and no markers', () => {
        const scope = resolveCodebaseScope(workDir);
        expect(scope.source).toBe('path');
        expect(scope.key).toMatch(/^local-[a-f0-9]{16}$/);
    });
});

describe('detectFrameworks', () => {
    it('detects deps from package.json', () => {
        writeFileSync(
            join(workDir, 'package.json'),
            JSON.stringify({
                dependencies: { next: '15.0.0', react: '19.0.0' },
                devDependencies: { vitest: '3.0.0', '@types/node': '*' },
            }),
        );
        const found = detectFrameworks(workDir)
            .map((f) => f.key)
            .sort();
        expect(found).toEqual(['next', 'react', 'vitest']);
    });

    it('returns empty list for projects without recognized deps', () => {
        writeFileSync(
            join(workDir, 'package.json'),
            JSON.stringify({ dependencies: { 'random-unknown-pkg': '1.0.0' } }),
        );
        expect(detectFrameworks(workDir)).toEqual([]);
    });

    it('detects fastapi from pyproject.toml', () => {
        writeFileSync(
            join(workDir, 'pyproject.toml'),
            `[project]\nname = "x"\ndependencies = ["fastapi", "pydantic"]`,
        );
        const found = detectFrameworks(workDir)
            .map((f) => f.key)
            .sort();
        expect(found).toContain('fastapi');
        expect(found).toContain('pydantic');
    });
});

describe('detectLanguages', () => {
    it('emits scopes for languages above the threshold', () => {
        const src = join(workDir, 'src');
        mkdirSync(src);
        for (let i = 0; i < 60; i++) {
            writeFileSync(join(src, `file${i}.ts`), 'export const x = 1;');
        }
        for (let i = 0; i < 5; i++) {
            writeFileSync(join(src, `f${i}.md`), '# h');
        }
        const scopes = detectLanguages(workDir);
        const tags = scopes.map((s) => s.key);
        expect(tags).toContain('ts');
    });

    it('returns empty list for an empty project', () => {
        expect(detectLanguages(workDir)).toEqual([]);
    });

    it('skips node_modules and dist', () => {
        const nm = join(workDir, 'node_modules', 'pkg');
        mkdirSync(nm, { recursive: true });
        for (let i = 0; i < 100; i++) {
            writeFileSync(join(nm, `noise${i}.ts`), 'x');
        }
        const dist = join(workDir, 'dist');
        mkdirSync(dist);
        for (let i = 0; i < 100; i++) {
            writeFileSync(join(dist, `built${i}.js`), 'x');
        }
        const scopes = detectLanguages(workDir);
        expect(scopes).toEqual([]);
    });
});

describe('resolveScopes (aggregated)', () => {
    it('returns primary + frameworks + languages + flattened all', () => {
        initGitRepo(workDir, 'https://github.com/test/aggregator.git');
        writeFileSync(
            join(workDir, 'package.json'),
            JSON.stringify({ dependencies: { next: '15.0.0' } }),
        );
        const src = join(workDir, 'src');
        mkdirSync(src);
        for (let i = 0; i < 60; i++) {
            writeFileSync(join(src, `f${i}.ts`), 'x');
        }

        const r = resolveScopes(workDir);
        expect(r.primary.kind).toBe('codebase');
        expect(r.primary.key).toMatch(/^[a-f0-9]{16}$/);
        expect(r.frameworks.map((f) => f.key)).toContain('next');
        expect(r.languages.map((l) => l.key)).toContain('ts');
        expect(r.all[0]).toEqual(r.primary);
        expect(r.all.length).toBe(1 + r.frameworks.length + r.languages.length);
    });
});

/* ─── Store / migration tests ─── */

describe('scopes store + v10 migration', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'lumen-scope-store-'));
        setDataDir(tempDir);
        getDb();
    });

    afterEach(() => {
        resetDb();
        resetDataDir();
        rmSync(tempDir, { recursive: true, force: true });
    });

    it('upsertScope inserts a new row', () => {
        upsertScope({
            kind: 'codebase',
            key: 'abc1234567890abc',
            label: 'lumen',
            metadata: { remote: 'https://github.com/sardor-m/lumen' },
        });
        const row = getScope('codebase', 'abc1234567890abc');
        expect(row).not.toBeNull();
        expect(row?.label).toBe('lumen');
        expect(row?.metadata).toEqual({ remote: 'https://github.com/sardor-m/lumen' });
    });

    it('upsertScope is idempotent on the primary key', () => {
        upsertScope({ kind: 'framework', key: 'next', label: 'Next.js' });
        upsertScope({ kind: 'framework', key: 'next' });
        expect(countScopes()).toBe(1);
        expect(getScope('framework', 'next')?.label).toBe('Next.js');
    });

    it('listScopes filters by kind', () => {
        upsertScope({ kind: 'framework', key: 'next' });
        upsertScope({ kind: 'framework', key: 'react' });
        upsertScope({ kind: 'language', key: 'ts' });
        expect(listScopes({ kind: 'framework' }).length).toBe(2);
        expect(listScopes({ kind: 'language' }).length).toBe(1);
        expect(listScopes().length).toBe(3);
    });

    it('touchScope bumps last_seen_at without changing label', async () => {
        upsertScope({ kind: 'language', key: 'py', label: 'Python' });
        const before = getScope('language', 'py');
        await new Promise((r) => setTimeout(r, 10));
        touchScope('language', 'py');
        const after = getScope('language', 'py');
        expect(after?.label).toBe('Python');
        expect(after?.last_seen_at).not.toBe(before?.last_seen_at);
    });

    it('setScopeLabel updates the label', () => {
        upsertScope({ kind: 'team', key: 'acme' });
        setScopeLabel('team', 'acme', 'Acme Corp');
        expect(getScope('team', 'acme')?.label).toBe('Acme Corp');
    });

    it('insertSource defaults scope to personal:me when not provided', () => {
        insertSource({
            id: 'src-1',
            title: 't',
            url: null,
            content: 'hello',
            content_hash: 'h',
            source_type: 'url',
            added_at: new Date().toISOString(),
            compiled_at: null,
            word_count: 1,
            language: null,
            metadata: null,
        });
        const row = getDb()
            .prepare('SELECT scope_kind, scope_key FROM sources WHERE id = ?')
            .get('src-1') as { scope_kind: string; scope_key: string };
        expect(row.scope_kind).toBe('personal');
        expect(row.scope_key).toBe('me');
    });

    it('insertSource honors an explicitly provided scope', () => {
        insertSource({
            id: 'src-2',
            title: 't',
            url: null,
            content: 'hello',
            content_hash: 'h2',
            source_type: 'code',
            added_at: new Date().toISOString(),
            compiled_at: null,
            word_count: 1,
            language: null,
            metadata: null,
            scope_kind: 'codebase',
            scope_key: 'abc1234567890abc',
        });
        const row = getDb()
            .prepare('SELECT scope_kind, scope_key FROM sources WHERE id = ?')
            .get('src-2') as { scope_kind: string; scope_key: string };
        expect(row.scope_kind).toBe('codebase');
        expect(row.scope_key).toBe('abc1234567890abc');
    });

    it('upsertConcept defaults scope to personal:me when not provided', () => {
        const now = new Date().toISOString();
        upsertConcept({
            slug: 'attention',
            name: 'Attention',
            summary: 's',
            compiled_truth: 's',
            article: null,
            created_at: now,
            updated_at: now,
            mention_count: 1,
        });
        const c = getConcept('attention');
        expect(c?.scope_kind).toBe('personal');
        expect(c?.scope_key).toBe('me');
    });

    it('upsertConcept honors explicitly provided scope', () => {
        const now = new Date().toISOString();
        upsertConcept({
            slug: 'route-add',
            name: 'Route Add',
            summary: null,
            compiled_truth: null,
            article: null,
            created_at: now,
            updated_at: now,
            mention_count: 1,
            scope_kind: 'codebase',
            scope_key: 'abc1234567890abc',
        });
        const c = getConcept('route-add');
        expect(c?.scope_kind).toBe('codebase');
        expect(c?.scope_key).toBe('abc1234567890abc');
    });
});
