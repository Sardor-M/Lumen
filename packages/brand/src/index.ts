export const SITE_NAME = 'Lumen';
export const VERSION = 'v0.1.3';

export const TAGLINE = 'Intelligent Knowledge Compiler';
export const EYEBROW = 'intelligent knowledge compiler · local-first · offline by default';

export const DESCRIPTION = {
    short: 'Local-first knowledge graph from your reading.',
    long: 'Local-first knowledge compiler. Ingest articles, PDFs, papers, and videos into a structured knowledge graph. One SQLite file on your machine. Your agent checks your brain before it answers.',
} as const;

export const HERO_STATS = {
    mcpTools: 19,
    hybridSearchSignals: 3,
    sqliteFiles: 1,
    servers: 0,
} as const;

export const INSTALL_CMDS = {
    install: 'npm install -g lumen',
    installAndInit: 'npm install -g lumen && lumen init',
    installClaude: 'lumen install claude',
} as const;

export const LINKS = {
    github: 'https://github.com/Sardor-M/lumen',
    docs: '#',
    changelog: '#',
    discord: '#',
} as const;

export const COPYRIGHT = `© 2026 ${SITE_NAME} · MIT · one sqlite file, forever`;
