import Anthropic from '@anthropic-ai/sdk';
import type { LumenConfig } from '../types/index.js';

type ChatMessage = {
    role: 'user' | 'assistant';
    content: string;
};

type ChatOptions = {
    system?: string;
    maxTokens?: number;
    temperature?: number;
};

/**
 * LLM API wrapper with provider routing.
 * Supports Anthropic (direct), OpenRouter, and Ollama.
 */
export async function chat(
    config: LumenConfig,
    messages: ChatMessage[],
    opts?: ChatOptions,
): Promise<string> {
    const { provider, model, api_key, base_url } = config.llm;

    if (!api_key && provider !== 'ollama') {
        throw new Error(
            `No API key configured. Set ANTHROPIC_API_KEY or run: lumen config --api-key <key>`,
        );
    }

    switch (provider) {
        case 'anthropic':
            return chatAnthropic(api_key!, model, messages, opts);
        case 'openrouter':
            return chatOpenRouter(api_key!, model, base_url, messages, opts);
        case 'ollama':
            return chatOllama(model, base_url, messages, opts);
    }
}

/**
 * Chat and parse the response as JSON.
 * Strips markdown code fences if present.
 */
export async function chatJson<T>(
    config: LumenConfig,
    messages: ChatMessage[],
    opts?: ChatOptions,
): Promise<T> {
    const raw = await chat(config, messages, opts);

    /** Strip markdown code fences that LLMs often wrap JSON in. */
    const cleaned = raw
        .replace(/^```(?:json)?\n?/m, '')
        .replace(/\n?```$/m, '')
        .trim();

    try {
        return JSON.parse(cleaned);
    } catch {
        throw new Error(`LLM response is not valid JSON:\n${raw.slice(0, 500)}`);
    }
}

async function chatAnthropic(
    apiKey: string,
    model: string,
    messages: ChatMessage[],
    opts?: ChatOptions,
): Promise<string> {
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
        model,
        max_tokens: opts?.maxTokens ?? 4096,
        ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
        /** Cache system prompts — cuts cost ~60-80% on repeated calls within a session. */
        ...(opts?.system
            ? {
                  system: [
                      {
                          type: 'text' as const,
                          text: opts.system,
                          cache_control: { type: 'ephemeral' as const },
                      },
                  ],
              }
            : {}),
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    const block = response.content[0];
    if (block.type !== 'text') throw new Error('Unexpected response type from Anthropic');
    return block.text;
}

/**
 * Streaming variant for Anthropic — calls `onToken` on each new text delta.
 * Falls back to regular `chat()` for non-Anthropic providers.
 */
export async function chatAnthropicStream(
    config: LumenConfig,
    messages: ChatMessage[],
    opts: ChatOptions & { onToken: (token: string) => void },
): Promise<string> {
    if (config.llm.provider !== 'anthropic') {
        /** Non-Anthropic providers: fetch full response then emit as single token. */
        const full = await chat(config, messages, opts);
        opts.onToken(full);
        return full;
    }

    const client = new Anthropic({ apiKey: config.llm.api_key! });
    let full = '';

    const stream = client.messages.stream({
        model: config.llm.model,
        max_tokens: opts.maxTokens ?? 2048,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.system
            ? {
                  system: [
                      {
                          type: 'text' as const,
                          text: opts.system,
                          cache_control: { type: 'ephemeral' as const },
                      },
                  ],
              }
            : {}),
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            opts.onToken(event.delta.text);
            full += event.delta.text;
        }
    }

    return full;
}

async function chatOpenRouter(
    apiKey: string,
    model: string,
    baseUrl: string | null,
    messages: ChatMessage[],
    opts?: ChatOptions,
): Promise<string> {
    const url = (baseUrl || 'https://openrouter.ai/api/v1') + '/chat/completions';

    const body = {
        model,
        max_tokens: opts?.maxTokens ?? 4096,
        ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
        messages: [
            ...(opts?.system ? [{ role: 'system', content: opts.system }] : []),
            ...messages.map((m) => ({ role: m.role, content: m.content })),
        ],
    };

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/lumen-kb',
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`OpenRouter error ${res.status}: ${await res.text()}`);

    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    return json.choices[0].message.content;
}

async function chatOllama(
    model: string,
    baseUrl: string | null,
    messages: ChatMessage[],
    opts?: ChatOptions,
): Promise<string> {
    const url = (baseUrl || 'http://localhost:11434') + '/api/chat';

    const body = {
        model,
        stream: false,
        messages: [
            ...(opts?.system ? [{ role: 'system', content: opts.system }] : []),
            ...messages.map((m) => ({ role: m.role, content: m.content })),
        ],
    };

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`);

    const json = (await res.json()) as { message: { content: string } };
    return json.message.content;
}
