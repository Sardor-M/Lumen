/**
 * Language detection by file-extension cluster.
 *
 * Walks the project root (respecting hard-skip dirs from the ingest plan)
 * and counts files per extension cluster. Emits a `language:<tag>` scope for
 * any cluster that exceeds the smaller of (5% of total files, 50 files
 * absolute).
 *
 * Walk depth is bounded to avoid pathological cases on huge monorepos.
 * Hidden dirs and conventional build/cache dirs are skipped.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type LanguageScope = {
    key: string;
    label: string;
    file_count: number;
    share: number;
};

const EXTENSION_TO_TAG: Record<string, string> = {
    '.ts': 'ts',
    '.tsx': 'ts',
    '.mts': 'ts',
    '.cts': 'ts',
    '.js': 'js',
    '.jsx': 'js',
    '.mjs': 'js',
    '.cjs': 'js',
    '.py': 'py',
    '.pyi': 'py',
    '.rs': 'rust',
    '.go': 'go',
    '.java': 'java',
    '.kt': 'kotlin',
    '.kts': 'kotlin',
    '.swift': 'swift',
    '.rb': 'ruby',
    '.php': 'php',
    '.c': 'c',
    '.h': 'c',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.cxx': 'cpp',
    '.hpp': 'cpp',
    '.hh': 'cpp',
    '.cs': 'csharp',
    '.ex': 'elixir',
    '.exs': 'elixir',
    '.sql': 'sql',
    '.sh': 'sh',
    '.bash': 'sh',
    '.zsh': 'sh',
    '.md': 'md',
    '.mdx': 'md',
    '.html': 'html',
    '.htm': 'html',
    '.css': 'css',
    '.scss': 'css',
    '.sass': 'css',
    '.less': 'css',
};

const TAG_LABELS: Record<string, string> = {
    ts: 'TypeScript',
    js: 'JavaScript',
    py: 'Python',
    rust: 'Rust',
    go: 'Go',
    java: 'Java',
    kotlin: 'Kotlin',
    swift: 'Swift',
    ruby: 'Ruby',
    php: 'PHP',
    c: 'C',
    cpp: 'C++',
    csharp: 'C#',
    elixir: 'Elixir',
    sql: 'SQL',
    sh: 'Shell',
    md: 'Markdown',
    html: 'HTML',
    css: 'CSS',
};

const SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    '.next',
    '.turbo',
    '.cache',
    'dist',
    'build',
    'out',
    'target',
    '__pycache__',
    '.venv',
    'venv',
    '.pytest_cache',
    '.mypy_cache',
    '.idea',
    '.vscode',
    'coverage',
    '.nyc_output',
]);

const MAX_DEPTH = 8;
const MAX_FILES = 20000;

/** Detect dominant language scopes for a project root. */
export function detectLanguages(root: string): LanguageScope[] {
    const counts = new Map<string, number>();
    let totalFiles = 0;

    walk(root, 0, (path) => {
        const ext = extOf(path);
        const tag = ext ? EXTENSION_TO_TAG[ext] : undefined;
        if (!tag) return;
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
        totalFiles++;
    });

    if (totalFiles === 0) return [];

    const minimumByShare = Math.ceil(totalFiles * 0.05);
    const threshold = Math.min(50, minimumByShare);

    const scopes: LanguageScope[] = [];
    for (const [tag, count] of counts.entries()) {
        if (count >= threshold) {
            scopes.push({
                key: tag,
                label: TAG_LABELS[tag] ?? tag,
                file_count: count,
                share: count / totalFiles,
            });
        }
    }
    scopes.sort((a, b) => b.file_count - a.file_count);
    return scopes;
}

function walk(dir: string, depth: number, visit: (path: string) => void): void {
    if (depth > MAX_DEPTH) return;
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return;
    }
    let visited = 0;
    for (const name of entries) {
        if (visited >= MAX_FILES) return;
        if (name.startsWith('.') && SKIP_DIRS.has(name)) continue;
        if (SKIP_DIRS.has(name)) continue;
        const path = join(dir, name);
        let s;
        try {
            s = statSync(path);
        } catch {
            continue;
        }
        if (s.isDirectory()) {
            walk(path, depth + 1, visit);
        } else if (s.isFile()) {
            visit(path);
            visited++;
        }
    }
}

function extOf(path: string): string | null {
    const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    const base = slash >= 0 ? path.slice(slash + 1) : path;
    const dot = base.lastIndexOf('.');
    if (dot <= 0) return null;
    return base.slice(dot).toLowerCase();
}
