/**
 * Public scope-resolution surface.
 *
 * Three-layer fallback for the codebase scope (see `codebase.ts`); aggregated
 * with detected framework + language scopes into a single `ResolvedScopes`
 * object. Used by Tier 2 capture / search paths and (later) by the
 * `scope_resolve` MCP tool and the `lumen scope` CLI.
 */

import type { Scope } from '../types/index.js';
import { resolveCodebaseScope } from './codebase.js';
import { detectFrameworks } from './framework.js';
import { detectLanguages } from './language.js';

export type ResolvedScopes = {
    /** Primary scope - usually the codebase. Used as the default for capture. */
    primary: Scope;
    /** Frameworks detected from declared dependencies. */
    frameworks: Scope[];
    /** Languages exceeding the 5% / 50-file threshold. */
    languages: Scope[];
    /** Flattened list including primary - useful for sync routing tags. */
    all: Scope[];
    /** The codebase root that was resolved. Useful for diagnostics. */
    root: string;
};

/** Resolve every scope visible from `cwd`. */
export function resolveScopes(cwd: string): ResolvedScopes {
    const codebase = resolveCodebaseScope(cwd);

    const primary: Scope = {
        kind: 'codebase',
        key: codebase.key,
        label: codebase.label,
    };

    const frameworks: Scope[] = detectFrameworks(codebase.root).map((f) => ({
        kind: 'framework',
        key: f.key,
        label: f.label,
    }));

    const languages: Scope[] = detectLanguages(codebase.root).map((l) => ({
        kind: 'language',
        key: l.key,
        label: l.label,
    }));

    return {
        primary,
        frameworks,
        languages,
        all: [primary, ...frameworks, ...languages],
        root: codebase.root,
    };
}

/** Convenience: return only the codebase scope (most common single-scope query). */
export function resolveCodebase(cwd: string): Scope {
    const codebase = resolveCodebaseScope(cwd);
    return { kind: 'codebase', key: codebase.key, label: codebase.label };
}

export { resolveCodebaseScope } from './codebase.js';
export { detectFrameworks } from './framework.js';
export { detectLanguages } from './language.js';
export { normalizeGitRemote } from './normalize.js';
export type { CodebaseScope } from './codebase.js';
export type { FrameworkScope } from './framework.js';
export type { LanguageScope } from './language.js';
