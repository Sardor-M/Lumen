import type { NextConfig } from 'next';
import { resolve } from 'node:path';

const nextConfig: NextConfig = {
    serverExternalPackages: ['better-sqlite3', 'better-auth'],
    outputFileTracingRoot: resolve(__dirname, '../..'),
    transpilePackages: ['@lumen/cli'],
    /**
     * Node 23 breaks webpack's WASM-based xxhash64.
     * Force sha256 and disable the build worker as a workaround.
     * Production build still crashes on Node 23 — use Node 22 LTS for `next build`.
     * Dev mode (`next dev`) works on all Node versions.
     */
    webpack: (config) => {
        if (config.output) {
            config.output.hashFunction = 'sha256';
        }
        /** Let webpack resolve `.js` imports (ESM style in @lumen/cli) against `.ts` source. */
        config.resolve = config.resolve ?? {};
        config.resolve.extensionAlias = {
            ...(config.resolve.extensionAlias ?? {}),
            '.js': ['.ts', '.tsx', '.js', '.jsx'],
        };
        return config;
    },
    experimental: {
        webpackBuildWorker: false,
    },
};

export default nextConfig;
