/**
 * Framework detection from declared dependency files.
 *
 * Reads package.json, pyproject.toml, Cargo.toml, go.mod, Gemfile, etc. and
 * matches declared deps against a curated allow-list. A project can match
 * multiple frameworks (e.g. next + react + tailwindcss); each becomes its
 * own `framework:<name>` scope.
 *
 * The allow-list is intentionally curated. Unknown deps don't generate
 * scopes, which keeps `lumen scope list` clean. Extend the list when a
 * framework becomes worth a dedicated scope.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type FrameworkScope = {
    key: string;
    label: string;
};

/** Curated allow-list. Extend as needed; keep entries lowercase. */
const FRAMEWORK_LABELS: Record<string, string> = {
    /** JS / TS frameworks. */
    next: 'Next.js',
    react: 'React',
    vue: 'Vue',
    svelte: 'Svelte',
    astro: 'Astro',
    remix: 'Remix',
    nuxt: 'Nuxt',
    solid: 'Solid',
    /** JS / TS servers. */
    express: 'Express',
    fastify: 'Fastify',
    hono: 'Hono',
    koa: 'Koa',
    nestjs: 'NestJS',
    trpc: 'tRPC',
    /** JS / TS tooling. */
    vite: 'Vite',
    webpack: 'webpack',
    esbuild: 'esbuild',
    rollup: 'Rollup',
    turbo: 'Turborepo',
    /** JS / TS UI. */
    tailwindcss: 'Tailwind CSS',
    mantine: 'Mantine',
    'chakra-ui': 'Chakra UI',
    'radix-ui': 'Radix UI',
    shadcn: 'shadcn/ui',
    /** JS / TS ORMs. */
    drizzle: 'Drizzle ORM',
    prisma: 'Prisma',
    kysely: 'Kysely',
    /** JS / TS testing. */
    vitest: 'Vitest',
    jest: 'Jest',
    playwright: 'Playwright',
    cypress: 'Cypress',
    /** Python. */
    fastapi: 'FastAPI',
    django: 'Django',
    flask: 'Flask',
    pydantic: 'Pydantic',
    sqlalchemy: 'SQLAlchemy',
    alembic: 'Alembic',
    pytest: 'pytest',
    /** Rust. */
    axum: 'Axum',
    actix: 'Actix',
    tokio: 'Tokio',
    serde: 'serde',
    sqlx: 'SQLx',
    diesel: 'Diesel',
    leptos: 'Leptos',
    dioxus: 'Dioxus',
    /** Go. */
    gin: 'Gin',
    echo: 'Echo',
    chi: 'Chi',
    cobra: 'Cobra',
    sqlc: 'sqlc',
    /** Ruby. */
    rails: 'Ruby on Rails',
    sinatra: 'Sinatra',
    /** JVM. */
    'spring-boot': 'Spring Boot',
    ktor: 'Ktor',
};

/**
 * Detect frameworks declared in the project root's dependency files.
 * Returns deduplicated list, ordered by allow-list iteration.
 */
export function detectFrameworks(root: string): FrameworkScope[] {
    const declared = new Set<string>();

    addPackageJsonDeps(root, declared);
    addPyprojectDeps(root, declared);
    addRequirementsTxtDeps(root, declared);
    addCargoDeps(root, declared);
    addGoModDeps(root, declared);
    addGemfileDeps(root, declared);

    const found: FrameworkScope[] = [];
    for (const [key, label] of Object.entries(FRAMEWORK_LABELS)) {
        if (declared.has(key)) {
            found.push({ key, label });
        }
    }
    return found;
}

function addPackageJsonDeps(root: string, out: Set<string>): void {
    const path = join(root, 'package.json');
    if (!existsSync(path)) return;
    try {
        const pkg = JSON.parse(readFileSync(path, 'utf-8')) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };
        for (const dep of [
            ...Object.keys(pkg.dependencies ?? {}),
            ...Object.keys(pkg.devDependencies ?? {}),
        ]) {
            const normalized = normalizeNpmName(dep);
            if (normalized) out.add(normalized);
        }
    } catch {
        /** Skip malformed package.json. */
    }
}

/** Maps known npm scope names (without @) to FRAMEWORK_LABELS keys. */
const NPM_SCOPE_ALIAS: Record<string, string> = {
    nestjs: 'nestjs',
    'chakra-ui': 'chakra-ui',
    'radix-ui': 'radix-ui',
    trpc: 'trpc',
    playwright: 'playwright',
};

function normalizeNpmName(name: string): string | null {
    const lower = name.toLowerCase();
    if (lower.startsWith('@')) {
        const slash = lower.indexOf('/');
        if (slash < 0) return null;
        const scope = lower.slice(1, slash);
        /** Prefer the alias map for known scopes; fall back to the unscoped part. */
        return NPM_SCOPE_ALIAS[scope] ?? lower.slice(slash + 1);
    }
    return lower;
}

function addPyprojectDeps(root: string, out: Set<string>): void {
    const path = join(root, 'pyproject.toml');
    if (!existsSync(path)) return;
    try {
        const text = readFileSync(path, 'utf-8');
        /** Quick-and-dirty: any token matching a known framework name. */
        for (const key of Object.keys(FRAMEWORK_LABELS)) {
            const re = new RegExp(`\\b${key}\\b`, 'i');
            if (re.test(text)) out.add(key);
        }
    } catch {
        /** Skip. */
    }
}

function addRequirementsTxtDeps(root: string, out: Set<string>): void {
    for (const file of ['requirements.txt', 'requirements-dev.txt']) {
        const path = join(root, file);
        if (!existsSync(path)) continue;
        try {
            const text = readFileSync(path, 'utf-8');
            for (const line of text.split('\n')) {
                const name = line
                    .split(/[<>=!~ ]/)[0]
                    .trim()
                    .toLowerCase();
                if (name && name in FRAMEWORK_LABELS) out.add(name);
            }
        } catch {
            /** Skip. */
        }
    }
}

function addCargoDeps(root: string, out: Set<string>): void {
    const path = join(root, 'Cargo.toml');
    if (!existsSync(path)) return;
    try {
        const text = readFileSync(path, 'utf-8');
        for (const key of Object.keys(FRAMEWORK_LABELS)) {
            const re = new RegExp(`^${key}\\s*=`, 'mi');
            if (re.test(text)) out.add(key);
        }
    } catch {
        /** Skip. */
    }
}

function addGoModDeps(root: string, out: Set<string>): void {
    const path = join(root, 'go.mod');
    if (!existsSync(path)) return;
    try {
        const text = readFileSync(path, 'utf-8');
        for (const key of Object.keys(FRAMEWORK_LABELS)) {
            const re = new RegExp(`/${key}(?:[/\\s]|$)`, 'i');
            if (re.test(text)) out.add(key);
        }
    } catch {
        /** Skip. */
    }
}

function addGemfileDeps(root: string, out: Set<string>): void {
    const path = join(root, 'Gemfile');
    if (!existsSync(path)) return;
    try {
        const text = readFileSync(path, 'utf-8');
        for (const key of Object.keys(FRAMEWORK_LABELS)) {
            const re = new RegExp(`gem\\s+['"]${key}['"]`, 'i');
            if (re.test(text)) out.add(key);
        }
    } catch {
        /** Skip. */
    }
}
