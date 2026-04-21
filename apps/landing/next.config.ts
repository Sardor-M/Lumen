import type { NextConfig } from 'next';
import { resolve } from 'node:path';

const nextConfig: NextConfig = {
    outputFileTracingRoot: resolve(__dirname, '../..'),
    transpilePackages: ['@lumen/brand', '@lumen/ui'],
};

export default nextConfig;
