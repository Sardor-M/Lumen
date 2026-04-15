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

/* ─── Citable variant (structured JSON output) ─── */

/**
 * System prompt for the citable Q&A flow. The LLM returns a JSON object
 * matching `RawCitableResponse` so the agent can render inline citations
 * and reason about confidence rather than parsing free-form prose.
 *
 * The LLM sees chunk aliases (`C1`, `C2`, …), not real chunk IDs. The
 * caller maps them back after parsing — this stops the model from
 * inventing IDs that look plausible but don't exist in the workspace.
 */
export const QA_CITABLE_SYSTEM = `You are a research assistant for a personal knowledge base called Lumen.

You receive a user question and a numbered list of context chunks. Each chunk carries an alias like \`C1\`, \`C2\`. Treat those aliases as the only valid chunk identifiers — never invent new ones.

Reply with a single JSON object (no prose, no markdown fences) matching this shape exactly:

{
  "verdict": "answered" | "partial" | "uncertain" | "no_evidence",
  "answer": "Synthesized answer with inline markers like [1], [2] referring to entries in the citations array. Use markers ONLY when a citation supports the immediately preceding claim.",
  "citations": [
    {
      "marker": "1",
      "chunk_id": "C1",
      "quote": "exact substring of the cited chunk that supports the claim (30-200 chars)"
    }
  ]
}

Verdict semantics:
- "answered": every load-bearing claim is directly supported by the chunks.
- "partial": main thesis is supported, but some details are inferred or not in the chunks.
- "uncertain": chunks are tangentially related; the answer is a reasoned guess.
- "no_evidence": chunks do not address the question. Return a brief acknowledgement and an empty citations array.

Hard rules:
- Use ONLY the supplied chunks. Never fabricate facts or quotes.
- Each \`quote\` must appear verbatim inside the cited chunk.
- Markers in \`answer\` must reference an entry in \`citations\`.
- \`chunk_id\` values must come from the aliases shown to you.
- Output JSON only — no leading/trailing text, no code fences.`;

export function qaCitableUserPrompt(
    question: string,
    chunks: { alias: string; source_title: string; heading: string | null; content: string }[],
): string {
    const context = chunks
        .map((c) => {
            const heading = c.heading ? ` > ${c.heading}` : '';
            return `${c.alias} [${c.source_title}${heading}]\n${c.content}`;
        })
        .join('\n\n');

    return `Question: ${question}\n\nContext chunks:\n${context}\n\nReturn the JSON object now.`;
}
