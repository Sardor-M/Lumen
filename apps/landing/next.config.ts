import type { NextConfig } from 'next';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
    outputFileTracingRoot: resolve(__dirname, '../..'),
    transpilePackages: ['@lumen/brand', '@lumen/ui'],
};

export default nextConfig;
