import type { KnipConfig } from 'knip';

const config: KnipConfig = {
    workspaces: {
        'apps/cli': {
            entry: ['src/cli.ts', 'src/mcp/server.ts', 'src/index.ts'],
            project: ['src/**/*.ts'],
            ignore: ['src/delta/**'],
            ignoreDependencies: ['tsx'],
        },
        'apps/web': {
            entry: ['src/app/**/page.tsx', 'src/app/**/layout.tsx', 'src/app/**/route.ts'],
            project: ['src/**/*.{ts,tsx}'],
        },
    },
    ignoreWorkspaces: ['apps/extension'],
};

export default config;
