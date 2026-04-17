import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { getConfigPath } from './paths.js';
import type { LumenConfig } from '../types/index.js';

const DEFAULT_CONFIG: LumenConfig = {
    data_dir: '~/.lumen',
    llm: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        api_key: null,
        base_url: null,
    },
    chunker: {
        min_chunk_tokens: 50,
        max_chunk_tokens: 1000,
    },
    search: {
        max_results: 20,
        token_budget: 4000,
        bm25_weight: 0.35,
        tfidf_weight: 0.3,
        vector_weight: 0.35,
    },
    embedding: {
        provider: 'none',
        model: 'text-embedding-3-small',
        dimensions: 1536,
        api_key: null,
        base_url: null,
        batch_size: 100,
    },
};

export function loadConfig(): LumenConfig {
    const configPath = getConfigPath();

    let fileConfig: Partial<LumenConfig> = {};
    if (existsSync(configPath)) {
        try {
            fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
        } catch {
            /** Corrupted config — use defaults. */
        }
    }

    const config: LumenConfig = {
        ...DEFAULT_CONFIG,
        ...fileConfig,
        llm: { ...DEFAULT_CONFIG.llm, ...fileConfig.llm },
        chunker: { ...DEFAULT_CONFIG.chunker, ...fileConfig.chunker },
        search: { ...DEFAULT_CONFIG.search, ...fileConfig.search },
        embedding: { ...DEFAULT_CONFIG.embedding, ...fileConfig.embedding },
    };

    if (!config.llm.api_key) {
        config.llm.api_key =
            process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY || null;
    }

    if (!config.embedding.api_key) {
        config.embedding.api_key = process.env.OPENAI_API_KEY || null;
    }

    return config;
}

export function saveConfig(config: LumenConfig): void {
    const configPath = getConfigPath();
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

export function initConfig(): void {
    const configPath = getConfigPath();
    if (!existsSync(configPath)) {
        saveConfig(DEFAULT_CONFIG);
    }
}
