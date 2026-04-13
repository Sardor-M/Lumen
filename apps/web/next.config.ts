import type { NextConfig } from 'next';
import { resolve } from 'node:path';

const nextConfig: NextConfig = {
    /** better-sqlite3 is a native module — don't bundle it. */
    serverExternalPackages: ['better-sqlite3', 'better-auth'],
    /** Pin the workspace root so Next.js stops scanning upward for lockfiles. */
    outputFileTracingRoot: resolve(__dirname, '../..'),
    /**
     * Override webpack's default xxhash (WASM-based) because it crashes under
     * Node 23 with `Cannot read properties of undefined (reading 'length')`.
     * sha256 is ~5% slower but stable.
     */
    webpack: (config) => {
        if (config.output) {
            config.output.hashFunction = 'sha256';
        }
        return config;
    },
};

export default nextConfig;
