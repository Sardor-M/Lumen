import { readFileSync, statSync, readdirSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { join, extname, relative, basename, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import type { ExtractionResult } from '../types/index.js';
import { IngestError } from './errors.js';

/** Maximum individual file size included verbatim (bytes). Larger files are truncated. */
const MAX_FILE_BYTES = 50_000;
/** Hard skip above this size — chunker can't keep up with a multi-MB source file. */
const SKIP_FILE_BYTES = 500_000;
/** Maximum total files included from one repo. Prevents ingesting a 10k-file monorepo. */
const MAX_FILES = 800;

/** Directories we never walk into, regardless of .gitignore. */
const HARD_SKIP_DIRS = new Set([
    '.git',
    'node_modules',
    'dist',
    'build',
    'out',
    '.next',
    '.turbo',
    '.cache',
    'target',
    'vendor',
    '__pycache__',
    '.venv',
    'venv',
    '.idea',
    '.vscode',
    'coverage',
    '.pytest_cache',
    '.mypy_cache',
]);

/** Extensions we treat as binary and skip outright. */
const BINARY_EXTENSIONS = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.bmp',
    '.ico',
    '.pdf',
    '.zip',
    '.gz',
    '.tar',
    '.rar',
    '.7z',
    '.bin',
    '.exe',
    '.dll',
    '.so',
    '.dylib',
    '.o',
    '.a',
    '.jar',
    '.class',
    '.wasm',
    '.mp3',
    '.mp4',
    '.mov',
    '.avi',
    '.webm',
    '.ogg',
    '.wav',
    '.flac',
    '.ttf',
    '.otf',
    '.woff',
    '.woff2',
    '.eot',
    '.db',
    '.sqlite',
    '.sqlite3',
    '.lock',
]);

/** Mapping from file extension to a language label used in metadata and fenced code blocks. */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
    '.py': 'python',
    '.pyi': 'python',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.kt': 'kotlin',
    '.scala': 'scala',
    '.c': 'c',
    '.h': 'c',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.cxx': 'cpp',
    '.hpp': 'cpp',
    '.hh': 'cpp',
    '.rb': 'ruby',
    '.php': 'php',
    '.sh': 'shell',
    '.bash': 'shell',
    '.zsh': 'shell',
    '.fish': 'shell',
    '.swift': 'swift',
    '.lua': 'lua',
    '.r': 'r',
    '.cs': 'csharp',
    '.fs': 'fsharp',
    '.ex': 'elixir',
    '.exs': 'elixir',
    '.erl': 'erlang',
    '.clj': 'clojure',
    '.dart': 'dart',
    '.zig': 'zig',
    '.nim': 'nim',
    '.ml': 'ocaml',
    '.hs': 'haskell',
    '.sql': 'sql',
    '.graphql': 'graphql',
    '.proto': 'protobuf',
    '.tf': 'hcl',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.toml': 'toml',
    '.json': 'json',
    '.html': 'html',
    '.css': 'css',
    '.scss': 'scss',
    '.md': 'markdown',
    '.markdown': 'markdown',
    '.rst': 'rst',
    '.txt': 'text',
};

/** Markdown-ish doc filenames that deserve extra prominence in the concatenated doc. */
const DOC_FILENAMES = new Set([
    'readme.md',
    'readme.markdown',
    'readme',
    'contributing.md',
    'contributing',
    'changelog.md',
    'changelog',
    'license',
    'license.md',
    'license.txt',
    'architecture.md',
    'design.md',
]);

/**
 * Ingest a code repository from either a GitHub URL or a local path.
 *
 * GitHub URLs are cloned shallowly into `os.tmpdir()` and removed afterwards.
 * Local paths are read in place; if a `.git` directory is present we capture
 * the commit SHA and branch from `git rev-parse`.
 */
export function extractCode(input: string): ExtractionResult {
    if (isGithubRepoUrl(input)) return extractFromGithubUrl(input);
    return extractFromLocalRepo(input);
}

function extractFromGithubUrl(url: string): ExtractionResult {
    const { owner, repo } = parseGithubUrl(url);
    const tmpRoot = mkdtempSync(join(tmpdir(), 'lumen-code-'));
    const dest = join(tmpRoot, repo);

    try {
        const clone = spawnSync('git', ['clone', '--depth', '1', '--quiet', url, dest], {
            stdio: ['ignore', 'ignore', 'pipe'],
            timeout: 180_000,
        });
        if (clone.status !== 0) {
            const stderr = clone.stderr?.toString().trim() ?? 'unknown error';
            throw new IngestError('NETWORK', `Failed to clone ${url}: ${stderr}`, {
                hint: 'Check the URL is reachable and that `git` is installed on PATH.',
            });
        }

        const result = extractFromLocalRepo(dest);
        const metadata = { ...(result.metadata as Record<string, unknown>) };
        metadata.repo_url = url;
        metadata.owner = owner;
        metadata.repo = repo;

        return {
            ...result,
            title: `${owner}/${repo}`,
            url,
            metadata,
        };
    } finally {
        try {
            rmSync(tmpRoot, { recursive: true, force: true });
        } catch {
            /** Best-effort cleanup — a leftover tmp dir is harmless. */
        }
    }
}

function extractFromLocalRepo(path: string): ExtractionResult {
    if (!existsSync(path)) {
        throw new IngestError('NOT_FOUND', `Path does not exist: ${path}`);
    }
    if (!statSync(path).isDirectory()) {
        throw new IngestError('MALFORMED', `Code source must be a directory: ${path}`, {
            hint: 'For a single source file, use `lumen add <path>` without forcing code mode.',
        });
    }

    const isGitRepo = existsSync(join(path, '.git'));
    const gitInfo = isGitRepo ? readGitInfo(path) : null;
    const gitignore = isGitRepo ? loadGitignore(path) : [];

    const files = collectCodeFiles(path, gitignore);
    if (files.length === 0) {
        throw new IngestError('NO_CONTENT', `No code or docs found in: ${path}`, {
            hint: 'The directory may be empty after ignoring node_modules, dist, and similar folders.',
        });
    }

    /** Docs first, then everything else. Gives the LLM context before diving into source. */
    const docs: string[] = [];
    const code: string[] = [];
    const languages = new Map<string, number>();

    for (const file of files) {
        const rel = relative(path, file) || basename(file);
        const base = basename(file).toLowerCase();
        const ext = extname(file).toLowerCase();
        const language = LANGUAGE_BY_EXTENSION[ext] ?? null;

        if (language) {
            languages.set(language, (languages.get(language) ?? 0) + 1);
        }

        let content: string;
        try {
            content = readFileSync(file, 'utf-8');
        } catch {
            continue;
        }
        if (!content.trim()) continue;

        const section = renderFileSection(rel, content, language);
        if (DOC_FILENAMES.has(base) || ext === '.md' || ext === '.markdown') {
            docs.push(section);
        } else {
            code.push(section);
        }
    }

    const repoName = basename(path);
    const header = `# ${repoName}\n\n`;
    const body = [...docs, ...code].join('\n\n---\n\n');

    return {
        title: repoName,
        content: header + body,
        url: null,
        source_type: 'code',
        language: pickDominantLanguage(languages),
        metadata: {
            path,
            file_count: files.length,
            languages: Object.fromEntries(languages),
            commit_sha: gitInfo?.sha ?? null,
            branch: gitInfo?.branch ?? null,
            is_git_repo: isGitRepo,
        },
    };
}

/** Render one file as a markdown section with a heading and fenced code block. */
function renderFileSection(relativePath: string, content: string, language: string | null): string {
    const ext = extname(relativePath).toLowerCase();
    const isMarkdown = ext === '.md' || ext === '.markdown';

    if (isMarkdown) {
        return `## ${relativePath}\n\n${trimFile(content)}`;
    }

    const fence = language ?? '';
    const signatures = extractSignatures(content, language);
    const signatureBlock =
        signatures.length > 0 ? `**Signatures:** ${signatures.join(', ')}\n\n` : '';

    return `## ${relativePath}\n\n${signatureBlock}\`\`\`${fence}\n${trimFile(content)}\n\`\`\``;
}

function trimFile(content: string): string {
    if (content.length <= MAX_FILE_BYTES) return content;
    const truncated = content.slice(0, MAX_FILE_BYTES);
    const lastNewline = truncated.lastIndexOf('\n');
    const safe = lastNewline > MAX_FILE_BYTES * 0.8 ? truncated.slice(0, lastNewline) : truncated;
    return `${safe}\n\n/* … truncated at ${MAX_FILE_BYTES.toLocaleString()} bytes … */`;
}

/**
 * Pull top-level function/class/type signatures from the file using per-language regex.
 * This is a lightweight substitute for tree-sitter — good enough for BM25 discovery,
 * not a substitute for a real parser. Returns deduplicated identifier strings.
 */
function extractSignatures(content: string, language: string | null): string[] {
    if (!language) return [];
    const out = new Set<string>();

    const capture = (re: RegExp): void => {
        let match;
        while ((match = re.exec(content)) !== null) {
            if (match[1]) out.add(match[1]);
            if (out.size >= 40) return;
        }
    };

    switch (language) {
        case 'python':
            capture(/^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/gm);
            capture(/^\s*class\s+([A-Za-z_][\w]*)/gm);
            break;
        case 'javascript':
        case 'typescript':
            capture(/\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g);
            capture(/\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g);
            capture(/\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/g);
            capture(/\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g);
            capture(/\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g);
            break;
        case 'go':
            capture(/\bfunc\s+(?:\([^)]*\)\s+)?([A-Za-z_][\w]*)\s*\(/g);
            capture(/\btype\s+([A-Za-z_][\w]*)\s+(?:struct|interface)/g);
            break;
        case 'rust':
            capture(/\b(?:pub\s+)?fn\s+([A-Za-z_][\w]*)/g);
            capture(/\b(?:pub\s+)?struct\s+([A-Za-z_][\w]*)/g);
            capture(/\b(?:pub\s+)?trait\s+([A-Za-z_][\w]*)/g);
            capture(/\b(?:pub\s+)?enum\s+([A-Za-z_][\w]*)/g);
            break;
        case 'java':
        case 'kotlin':
        case 'csharp':
            capture(
                /\b(?:public|private|protected|internal)\s+(?:static\s+)?(?:[A-Za-z_<>\[\],\s]+\s+)?([A-Za-z_][\w]*)\s*\(/g,
            );
            capture(/\b(?:public|private|protected|internal)?\s*class\s+([A-Za-z_][\w]*)/g);
            capture(/\b(?:public|private|protected|internal)?\s*interface\s+([A-Za-z_][\w]*)/g);
            break;
        case 'ruby':
            capture(/^\s*def\s+(?:self\.)?([A-Za-z_][\w!?=]*)/gm);
            capture(/^\s*class\s+([A-Z][\w]*)/gm);
            capture(/^\s*module\s+([A-Z][\w]*)/gm);
            break;
        case 'c':
        case 'cpp':
            capture(/^\s*(?:[A-Za-z_][\w*\s]+?)\s+([A-Za-z_][\w]*)\s*\([^)]*\)\s*\{/gm);
            capture(/\b(?:class|struct)\s+([A-Za-z_][\w]*)/g);
            break;
    }

    return Array.from(out);
}

function pickDominantLanguage(languages: Map<string, number>): string | null {
    let best: [string, number] | null = null;
    for (const entry of languages) {
        if (!best || entry[1] > best[1]) best = entry;
    }
    return best ? best[0] : null;
}

function collectCodeFiles(root: string, gitignore: GitignorePattern[]): string[] {
    const results: string[] = [];
    const stack: string[] = [root];

    while (stack.length > 0) {
        const current = stack.pop()!;
        let entries;
        try {
            entries = readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (HARD_SKIP_DIRS.has(entry.name)) continue;
            if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;

            const full = join(current, entry.name);
            const rel = relative(root, full);
            if (rel && matchesGitignore(gitignore, rel, entry.isDirectory())) continue;

            if (entry.isDirectory()) {
                stack.push(full);
                continue;
            }

            const ext = extname(entry.name).toLowerCase();
            if (BINARY_EXTENSIONS.has(ext)) continue;
            if (!LANGUAGE_BY_EXTENSION[ext] && !DOC_FILENAMES.has(entry.name.toLowerCase())) {
                continue;
            }

            let size: number;
            try {
                size = statSync(full).size;
            } catch {
                continue;
            }
            if (size > SKIP_FILE_BYTES) continue;

            results.push(full);
            if (results.length >= MAX_FILES) return results.sort();
        }
    }

    return results.sort();
}

type GitignorePattern = {
    raw: string;
    regex: RegExp;
    negate: boolean;
    directoryOnly: boolean;
};

function loadGitignore(root: string): GitignorePattern[] {
    const patterns: GitignorePattern[] = [];
    try {
        const raw = readFileSync(join(root, '.gitignore'), 'utf-8');
        for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const pattern = compileGitignorePattern(trimmed);
            if (pattern) patterns.push(pattern);
        }
    } catch {
        /** No .gitignore — nothing to load. */
    }
    return patterns;
}

/**
 * Translate a single .gitignore line into a regex. Supports the common subset:
 * leading `!` negation, trailing `/` directory-only, leading `/` anchored-to-root,
 * `*` / `**` wildcards. Deliberately a small parser, not a full spec implementation.
 */
function compileGitignorePattern(raw: string): GitignorePattern | null {
    let pattern = raw;
    const negate = pattern.startsWith('!');
    if (negate) pattern = pattern.slice(1);

    const directoryOnly = pattern.endsWith('/');
    if (directoryOnly) pattern = pattern.slice(0, -1);

    const anchored = pattern.startsWith('/');
    if (anchored) pattern = pattern.slice(1);

    if (!pattern) return null;

    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const re = escaped
        .replace(/\*\*/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000/g, '.*')
        .replace(/\?/g, '[^/]');

    const regexSource = anchored || pattern.includes('/') ? `^${re}$` : `(^|/)${re}$`;

    return {
        raw,
        regex: new RegExp(regexSource),
        negate,
        directoryOnly,
    };
}

function matchesGitignore(
    patterns: GitignorePattern[],
    relativePath: string,
    isDirectory: boolean,
): boolean {
    const normalized = relativePath.split(sep).join('/');
    let ignored = false;
    for (const pattern of patterns) {
        if (pattern.directoryOnly && !isDirectory) continue;
        if (pattern.regex.test(normalized)) {
            ignored = !pattern.negate;
        }
    }
    return ignored;
}

function readGitInfo(repoPath: string): { sha: string | null; branch: string | null } {
    const run = (args: string[]): string | null => {
        const result = spawnSync('git', ['-C', repoPath, ...args], {
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 5000,
        });
        if (result.status !== 0) return null;
        return result.stdout.toString().trim() || null;
    };
    return {
        sha: run(['rev-parse', 'HEAD']),
        branch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
    };
}

/** `https://github.com/owner/repo[.git]` or `git@github.com:owner/repo.git`. */
export function isGithubRepoUrl(input: string): boolean {
    if (/^git@github\.com:[^/]+\/[^/]+?(\.git)?$/i.test(input)) return true;
    if (!/^https?:\/\/github\.com\//i.test(input)) return false;
    try {
        const url = new URL(input);
        const parts = url.pathname.split('/').filter(Boolean);
        /** Exactly `/owner/repo` or `/owner/repo.git` — anything deeper is a file path, not a repo root. */
        return parts.length === 2;
    } catch {
        return false;
    }
}

function parseGithubUrl(input: string): { owner: string; repo: string } {
    const sshMatch = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(input);
    if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

    const url = new URL(input);
    const parts = url.pathname.split('/').filter(Boolean);
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, '');
    return { owner, repo };
}
