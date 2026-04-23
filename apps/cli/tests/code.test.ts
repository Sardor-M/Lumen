import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { extractCode, isGithubRepoUrl } from '../src/ingest/code.js';
import { IngestError } from '../src/ingest/errors.js';

let workDir: string;

beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lumen-code-test-'));
});

afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
});

/** Initialise a git repo with an author configured so `git commit` succeeds on CI. */
function initGitRepo(path: string): void {
    spawnSync('git', ['init', '-q', '--initial-branch=main', path], { stdio: 'ignore' });
    spawnSync('git', ['-C', path, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
    spawnSync('git', ['-C', path, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
}

function commitAll(path: string, message: string): void {
    spawnSync('git', ['-C', path, 'add', '-A'], { stdio: 'ignore' });
    spawnSync('git', ['-C', path, 'commit', '-q', '-m', message], { stdio: 'ignore' });
}

describe('isGithubRepoUrl', () => {
    it('matches https repo URLs', () => {
        expect(isGithubRepoUrl('https://github.com/owner/repo')).toBe(true);
        expect(isGithubRepoUrl('https://github.com/owner/repo.git')).toBe(true);
        expect(isGithubRepoUrl('http://github.com/owner/repo')).toBe(true);
    });

    it('matches ssh repo URLs', () => {
        expect(isGithubRepoUrl('git@github.com:owner/repo.git')).toBe(true);
        expect(isGithubRepoUrl('git@github.com:owner/repo')).toBe(true);
    });

    it('rejects paths deeper than owner/repo (file views, blobs, etc.)', () => {
        expect(isGithubRepoUrl('https://github.com/owner/repo/blob/main/README.md')).toBe(false);
        expect(isGithubRepoUrl('https://github.com/owner/repo/issues/1')).toBe(false);
    });

    it('rejects non-github URLs', () => {
        expect(isGithubRepoUrl('https://gitlab.com/owner/repo')).toBe(false);
        expect(isGithubRepoUrl('https://example.com/owner/repo')).toBe(false);
    });

    it('rejects malformed input', () => {
        expect(isGithubRepoUrl('not a url')).toBe(false);
        expect(isGithubRepoUrl('')).toBe(false);
    });
});

describe('extractCode — local directories', () => {
    it('ingests a non-git directory and returns is_git_repo=false', () => {
        writeFileSync(join(workDir, 'README.md'), '# My Project\n\nA sample.');
        writeFileSync(join(workDir, 'index.ts'), 'export function hello() { return 1; }\n');

        const result = extractCode(workDir);
        expect(result.source_type).toBe('code');
        expect(result.url).toBeNull();
        expect(result.content).toContain('# My Project');
        expect(result.content).toContain('hello');

        const meta = result.metadata as Record<string, unknown>;
        expect(meta.is_git_repo).toBe(false);
        expect(meta.commit_sha).toBeNull();
        expect(meta.branch).toBeNull();
        expect(meta.file_count).toBe(2);
    });

    it('captures commit SHA and branch for git repos', () => {
        initGitRepo(workDir);
        writeFileSync(join(workDir, 'README.md'), '# Repo\n\nHello.');
        writeFileSync(join(workDir, 'main.py'), 'def main():\n    return 0\n');
        commitAll(workDir, 'init');

        const result = extractCode(workDir);
        const meta = result.metadata as Record<string, unknown>;
        expect(meta.is_git_repo).toBe(true);
        expect(meta.commit_sha).toMatch(/^[a-f0-9]{40}$/);
        expect(meta.branch).toBe('main');
    });

    it('throws NOT_FOUND when path does not exist', () => {
        const ghost = join(workDir, 'does-not-exist');
        try {
            extractCode(ghost);
            expect.fail('expected extractCode to throw');
        } catch (err) {
            expect(err).toBeInstanceOf(IngestError);
            expect((err as IngestError).code).toBe('NOT_FOUND');
        }
    });

    it('throws MALFORMED when the path is a single file', () => {
        const filePath = join(workDir, 'single.ts');
        writeFileSync(filePath, 'export const x = 1;\n');
        try {
            extractCode(filePath);
            expect.fail('expected extractCode to throw');
        } catch (err) {
            expect(err).toBeInstanceOf(IngestError);
            expect((err as IngestError).code).toBe('MALFORMED');
        }
    });

    it('throws NO_CONTENT when the directory has no code or docs', () => {
        /** Only a binary extension that gets filtered out. */
        writeFileSync(join(workDir, 'blob.bin'), 'binary');
        try {
            extractCode(workDir);
            expect.fail('expected extractCode to throw');
        } catch (err) {
            expect(err).toBeInstanceOf(IngestError);
            expect((err as IngestError).code).toBe('NO_CONTENT');
        }
    });
});

describe('extractCode — traversal rules', () => {
    it('skips node_modules, dist, and .git regardless of .gitignore', () => {
        writeFileSync(join(workDir, 'index.ts'), 'export const a = 1;\n');
        mkdirSync(join(workDir, 'node_modules'));
        writeFileSync(join(workDir, 'node_modules', 'dep.ts'), 'export const dep = 1;\n');
        mkdirSync(join(workDir, 'dist'));
        writeFileSync(join(workDir, 'dist', 'built.js'), 'module.exports = {};');

        const result = extractCode(workDir);
        expect(result.content).toContain('index.ts');
        expect(result.content).not.toContain('dep.ts');
        expect(result.content).not.toContain('built.js');
    });

    it('honours .gitignore patterns in a git repo', () => {
        initGitRepo(workDir);
        writeFileSync(join(workDir, '.gitignore'), 'ignored.ts\n*.log\n');
        writeFileSync(join(workDir, 'kept.ts'), 'export const kept = 1;\n');
        writeFileSync(join(workDir, 'ignored.ts'), 'export const ignored = 1;\n');
        writeFileSync(join(workDir, 'trace.log'), 'logs');
        commitAll(workDir, 'init');

        const result = extractCode(workDir);
        expect(result.content).toContain('kept.ts');
        expect(result.content).not.toContain('ignored.ts');
        /** .log isn't a recognised source extension anyway, so this is redundant but documents intent. */
        expect(result.content).not.toContain('trace.log');
    });

    it('skips binary file extensions', () => {
        writeFileSync(join(workDir, 'app.ts'), 'export const x = 1;\n');
        writeFileSync(join(workDir, 'logo.png'), 'not a real png');
        writeFileSync(join(workDir, 'bundle.wasm'), 'not wasm');

        const result = extractCode(workDir);
        expect(result.content).toContain('app.ts');
        expect(result.content).not.toContain('logo.png');
        expect(result.content).not.toContain('bundle.wasm');
    });

    it('truncates files larger than the per-file limit', () => {
        /** 60 KB file — over the 50 KB limit. */
        const big = 'const x = 1;\n'.repeat(5000);
        writeFileSync(join(workDir, 'huge.ts'), big);

        const result = extractCode(workDir);
        expect(result.content).toMatch(/truncated at/);
    });

    it('puts docs (README/CONTRIBUTING) before source files in the concatenated doc', () => {
        writeFileSync(join(workDir, 'zzz.ts'), 'export const z = 1;\n');
        writeFileSync(join(workDir, 'README.md'), '# Docs\n\nFirst please.');
        writeFileSync(join(workDir, 'CONTRIBUTING.md'), '# Contributing\n\nThanks.');

        const result = extractCode(workDir);
        const readmeIdx = result.content.indexOf('README.md');
        const contribIdx = result.content.indexOf('CONTRIBUTING.md');
        const codeIdx = result.content.indexOf('zzz.ts');
        expect(readmeIdx).toBeGreaterThan(-1);
        expect(contribIdx).toBeGreaterThan(-1);
        expect(codeIdx).toBeGreaterThan(-1);
        expect(Math.max(readmeIdx, contribIdx)).toBeLessThan(codeIdx);
    });
});

describe('extractCode — language + signatures', () => {
    it('picks the dominant language', () => {
        writeFileSync(join(workDir, 'a.py'), 'def one(): pass\n');
        writeFileSync(join(workDir, 'b.py'), 'def two(): pass\n');
        writeFileSync(join(workDir, 'c.py'), 'def three(): pass\n');
        writeFileSync(join(workDir, 'solo.ts'), 'export const x = 1;\n');

        const result = extractCode(workDir);
        expect(result.language).toBe('python');

        const meta = result.metadata as Record<string, unknown>;
        const languages = meta.languages as Record<string, number>;
        expect(languages.python).toBe(3);
        expect(languages.typescript).toBe(1);
    });

    it('extracts JS/TS function, class, type, and interface signatures', () => {
        writeFileSync(
            join(workDir, 'mod.ts'),
            [
                'export function greet(name: string) { return name; }',
                'export class Greeter {}',
                'export type Opts = { x: number };',
                'export interface Config { debug: boolean }',
                'export const run = async () => {};',
            ].join('\n'),
        );

        const result = extractCode(workDir);
        expect(result.content).toContain('**Signatures:**');
        expect(result.content).toMatch(/\bgreet\b/);
        expect(result.content).toMatch(/\bGreeter\b/);
        expect(result.content).toMatch(/\bOpts\b/);
        expect(result.content).toMatch(/\bConfig\b/);
        expect(result.content).toMatch(/\brun\b/);
    });

    it('extracts Python def and class signatures', () => {
        writeFileSync(
            join(workDir, 'mod.py'),
            [
                'def regular(x):',
                '    return x',
                '',
                'async def fetcher(url):',
                '    return url',
                '',
                'class MyClass:',
                '    pass',
            ].join('\n'),
        );

        const result = extractCode(workDir);
        expect(result.content).toContain('**Signatures:**');
        expect(result.content).toMatch(/\bregular\b/);
        expect(result.content).toMatch(/\bfetcher\b/);
        expect(result.content).toMatch(/\bMyClass\b/);
    });

    it('extracts Go func and type signatures', () => {
        writeFileSync(
            join(workDir, 'main.go'),
            [
                'package main',
                '',
                'func Add(a, b int) int { return a + b }',
                'type User struct { Name string }',
                'type Greeter interface { Greet() string }',
            ].join('\n'),
        );

        const result = extractCode(workDir);
        expect(result.content).toContain('**Signatures:**');
        expect(result.content).toMatch(/\bAdd\b/);
        expect(result.content).toMatch(/\bUser\b/);
        expect(result.content).toMatch(/\bGreeter\b/);
    });

    it('extracts Rust fn, struct, trait, and enum signatures', () => {
        writeFileSync(
            join(workDir, 'lib.rs'),
            [
                'pub fn add(a: i32, b: i32) -> i32 { a + b }',
                'pub struct Point { x: i32, y: i32 }',
                'pub trait Drawable { fn draw(&self); }',
                'pub enum Color { Red, Blue }',
            ].join('\n'),
        );

        const result = extractCode(workDir);
        expect(result.content).toContain('**Signatures:**');
        expect(result.content).toMatch(/\badd\b/);
        expect(result.content).toMatch(/\bPoint\b/);
        expect(result.content).toMatch(/\bDrawable\b/);
        expect(result.content).toMatch(/\bColor\b/);
    });
});
