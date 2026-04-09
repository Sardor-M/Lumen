export const COMPILE_SYSTEM = `You are a knowledge compiler. Given chunks of text from an article or paper, extract:

1. **Concepts** — key ideas, techniques, entities, or terms that are worth tracking across sources
2. **Edges** — relationships between concepts

For each concept, provide:
- slug: URL-safe lowercase identifier (e.g., "transformer-architecture")
- name: human-readable name (e.g., "Transformer Architecture")
- summary: 1-2 sentence description

For each edge, provide:
- from: slug of the source concept
- to: slug of the target concept
- relation: one of: implements, extends, contradicts, supports, related, part-of, prerequisite, alternative, example-of
- weight: 0.0-1.0 (strength of the relationship)

Rules:
- Extract 3-15 concepts per source (focus on the most important ideas)
- Only create edges between concepts you extracted
- Prefer specific concepts over generic ones ("self-attention" over "neural networks")
- If two concepts from different sources describe the same idea, use the same slug
- Be conservative with edges — only add relationships you can justify from the text

Respond with valid JSON only, no markdown fences, no explanation.`;

export function compileUserPrompt(title: string, chunks: { content: string; heading: string | null }[]): string {
    const chunkText = chunks
        .map((c, i) => {
            const heading = c.heading ? ` [${c.heading}]` : '';
            return `--- Chunk ${i + 1}${heading} ---\n${c.content}`;
        })
        .join('\n\n');

    return `Source: "${title}"\n\n${chunkText}\n\nExtract concepts and edges as JSON:\n{"concepts": [...], "edges": [...]}`;
}

export type CompileResponse = {
    concepts: {
        slug: string;
        name: string;
        summary: string;
    }[];
    edges: {
        from: string;
        to: string;
        relation: string;
        weight: number;
    }[];
};
