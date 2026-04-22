import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

export function createNextConfig(importMetaUrl) {
    const baseDirectory = dirname(fileURLToPath(importMetaUrl));
    const compat = new FlatCompat({ baseDirectory });
    return [...compat.extends('next/core-web-vitals', 'next/typescript')];
}
