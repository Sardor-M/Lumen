import type { EmbeddingConfig } from '../types/index.js';

/**
 * Call the embedding API and return one Float32Array per input text,
 * in the same order as the input array.
 */
export async function embedBatch(
    texts: string[],
    config: EmbeddingConfig,
): Promise<Float32Array[]> {
    if (config.provider === 'openai') return embedOpenAI(texts, config);
    if (config.provider === 'ollama') return embedOllama(texts, config);
    throw new Error(
        'Embedding provider is "none". Set embedding.provider to "openai" or "ollama" in config.',
    );
}

/** Serialize a Float32Array to a Buffer for sqlite-vec storage. */
export function serializeVector(vec: Float32Array): Buffer {
    return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

async function embedOpenAI(texts: string[], config: EmbeddingConfig): Promise<Float32Array[]> {
    if (!config.api_key) {
        throw new Error(
            'No OpenAI API key for embeddings. Set OPENAI_API_KEY or embedding.api_key in config.',
        );
    }

    const base = config.base_url ?? 'https://api.openai.com';
    const res = await fetch(`${base}/v1/embeddings`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.api_key}`,
        },
        body: JSON.stringify({ model: config.model, input: texts }),
    });

    if (!res.ok) {
        throw new Error(`OpenAI embeddings error ${res.status}: ${await res.text()}`);
    }

    const json = (await res.json()) as { data: { embedding: number[]; index: number }[] };

    /** API returns objects in arbitrary order — sort by index to preserve input order. */
    json.data.sort((a, b) => a.index - b.index);
    return json.data.map((d) => new Float32Array(d.embedding));
}

/** Ollama processes one text at a time via /api/embeddings. */
async function embedOllama(texts: string[], config: EmbeddingConfig): Promise<Float32Array[]> {
    const base = config.base_url ?? 'http://localhost:11434';
    const results: Float32Array[] = [];

    for (const text of texts) {
        const res = await fetch(`${base}/api/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: config.model, prompt: text }),
        });

        if (!res.ok) {
            throw new Error(`Ollama embeddings error ${res.status}: ${await res.text()}`);
        }

        const json = (await res.json()) as { embedding: number[] };
        results.push(new Float32Array(json.embedding));
    }

    return results;
}
