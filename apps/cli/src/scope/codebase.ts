/**
 * Codebase identity resolution.
 *
 * Three-layer fallback:
 *   1. Git remote URL → SHA1[:16]
 *   2. Root-marker fingerprint (package.json, Cargo.toml, ...) → SHA1[:16]
 *   3. Absolute path SHA1[:16] with `local-` prefix (machine-local; never synced)
 *
 * See `docs/docs-temp/SCOPE-RESOLUTION.md` §2 for the full spec.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeGitRemote } from './normalize.js';

export type CodebaseScope = {
    key: string;
    label: string;
    /** How the key was derived. Useful for diagnostics and aliasing. */
    source: 'git-remote' | 'fingerprint' | 'path';
    /** Underlying value (normalized URL, fingerprint input, or absolute path). */
    origin: string;
    /** Resolved project root. */
    root: string;
};

const ROOT_MARKERS = [
    '.git',
    'package.json',
    'pyproject.toml',
    'Cargo.toml',
    'go.mod',
    'Gemfile',
    'build.gradle',
    'build.gradle.kts',
    'composer.json',
    'mix.exs',
    '.lumen-root',
] as const;

const FINGERPRINT_FILES = [
    'package.json',
    'pnpm-workspace.yaml',
    'turbo.json',
    'pyproject.toml',
    'Cargo.toml',
    'go.mod',
    'Gemfile',
    'build.gradle',
    'build.gradle.kts',
    'composer.json',
    'mix.exs',
] as const;

/** Walk up from `cwd` until a root marker is found, or fall back to `cwd`. */
export function findProjectRoot(cwd: string): string {
    let dir = resolve(cwd);
    const root = dirname(dir) === dir ? dir : null;

    while (true) {
        for (const marker of ROOT_MARKERS) {
            const candidate = join(dir, marker);
            if (existsSync(candidate)) return dir;
        }
        const parent = dirname(dir);
        if (parent === dir) {
            /** Reached filesystem root. */
            return root ?? resolve(cwd);
        }
        dir = parent;
    }
}

/** Resolve the codebase scope for a given working directory. */
export function resolveCodebaseScope(cwd: string): CodebaseScope {
    const root = findProjectRoot(cwd);
    const label = basename(root) || root;

    const remote = readGitRemote(root);
    if (remote) {
        const normalized = normalizeGitRemote(remote);
        if (normalized) {
            return {
                key: sha1Hex(normalized).slice(0, 16),
                label,
                source: 'git-remote',
                origin: normalized,
                root,
            };
        }
    }

    const fingerprint = computeFingerprint(root);
    if (fingerprint) {
        return {
            key: sha1Hex(fingerprint).slice(0, 16),
            label,
            source: 'fingerprint',
            origin: fingerprint,
            root,
        };
    }

    /** Last-resort path SHA1, prefixed `local-` to mark as machine-local. */
    const pathHash = sha1Hex(root).slice(0, 16);
    return {
        key: `local-${pathHash}`,
        label,
        source: 'path',
        origin: root,
        root,
    };
}

/** Returns the value of `git remote get-url origin`, or any first remote, or null. */
function readGitRemote(root: string): string | null {
    if (!existsSync(join(root, '.git'))) return null;
    try {
        const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
            cwd: root,
            stdio: ['ignore', 'pipe', 'ignore'],
            encoding: 'utf-8',
            timeout: 2000,
        }).trim();
        if (url) return url;
    } catch {
        /** No `origin`. Try the first listed remote. */
    }
    try {
        const out = execFileSync('git', ['remote'], {
            cwd: root,
            stdio: ['ignore', 'pipe', 'ignore'],
            encoding: 'utf-8',
            timeout: 2000,
        }).trim();
        const first = out.split(/\s+/).filter(Boolean)[0];
        if (!first) return null;
        const url = execFileSync('git', ['remote', 'get-url', first], {
            cwd: root,
            stdio: ['ignore', 'pipe', 'ignore'],
            encoding: 'utf-8',
            timeout: 2000,
        }).trim();
        return url || null;
    } catch {
        return null;
    }
}

/** Build a stable string from root marker file hashes. Returns null if no markers exist. */
function computeFingerprint(root: string): string | null {
    const parts: string[] = [`root:${basename(root)}`];

    for (const file of FINGERPRINT_FILES) {
        const p = join(root, file);
        if (!existsSync(p)) continue;
        try {
            if (!statSync(p).isFile()) continue;
            const contents = readFileSync(p);
            parts.push(`${file}:${sha1Hex(contents).slice(0, 16)}`);
        } catch {
            /** Skip unreadable files. */
        }
    }

    return parts.length > 1 ? parts.join('|') : null;
}

function sha1Hex(input: string | Buffer): string {
    return createHash('sha1').update(input).digest('hex');
}
