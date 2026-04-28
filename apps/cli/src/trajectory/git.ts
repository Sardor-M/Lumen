/**
 * Shared git helpers for trajectory capture and replay.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findProjectRoot } from '../scope/codebase.js';

/** Returns the short HEAD SHA for the repo containing `cwd`, or null if not in a git repo. */
export function readGitRevision(cwd: string): string | null {
    const root = findProjectRoot(cwd);
    if (!existsSync(join(root, '.git'))) return null;
    try {
        const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
            cwd: root,
            stdio: ['ignore', 'pipe', 'ignore'],
            encoding: 'utf-8',
            timeout: 2000,
        }).trim();
        return sha || null;
    } catch {
        return null;
    }
}
