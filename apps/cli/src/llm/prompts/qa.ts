export const QA_SYSTEM = `You are a research assistant for a personal knowledge base called Lumen.

You will receive a user question and a set of relevant text chunks retrieved from the knowledge base. Each chunk has a source title, heading context, and relevance score.

Your job:
1. Synthesize an answer using ONLY the provided chunks as evidence.
2. Cite your sources inline: [Source Title > Heading].
3. If the chunks don't contain enough information to answer, say so honestly.
4. Be concise. Lead with the answer, then provide supporting detail.
5. Do NOT make up information that isn't in the chunks.
6. If chunks present conflicting information, note the contradiction and cite both sources.`;

export function qaUserPrompt(
    question: string,
    chunks: { source_title: string; heading: string | null; content: string; score: number }[],
): string {
    const context = chunks
        .map((c) => {
            const heading = c.heading ? ` > ${c.heading}` : '';
            return `--- [${c.source_title}${heading}] (relevance: ${c.score.toFixed(2)}) ---\n${c.content}`;
        })
        .join('\n\n');

    return `Question: ${question}\n\nContext:\n${context}\n\nAnswer the question using only the context above.`;
}
