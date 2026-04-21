export type TerminalLine = { t: number; text: string };
export type TerminalScript = {
    title: string;
    lines: TerminalLine[];
};

export type TerminalKey = 'add' | 'compile' | 'ask' | 'graph' | 'install';

export const TERMINAL_SCRIPTS: Record<TerminalKey, TerminalScript> = {
    add: {
        title: 'ADD',
        lines: [
            {
                t: 100,
                text: '<span class="p">$</span> lumen add https://stripe.com/blog/minions\n',
            },
            { t: 400, text: '<span class="m">→ detected: web article</span>\n' },
            {
                t: 200,
                text: '<span class="m">→ extracting with @extractus/article-extractor</span>\n',
            },
            {
                t: 500,
                text: '<span class="m">→ sha-256: </span><span class="c">f3a2…8b91</span><span class="m"> (new)</span>\n',
            },
            {
                t: 200,
                text: '<span class="m">→ chunking</span>  markdown-aware, atomic code blocks\n',
            },
            {
                t: 400,
                text: '<span class="g">✓ 24 chunks stored</span>  <span class="m">(tokens: 4,812)</span>\n',
            },
            {
                t: 200,
                text: '<span class="m">→ indexing</span>  FTS5 bm25 · TF-IDF vocab (+41 terms)\n',
            },
            {
                t: 300,
                text: '<span class="g">✓ indexed</span>  <span class="m">available via</span> <span class="c">lumen search</span>\n\n',
            },
            { t: 200, text: '<span class="y">⎯⎯ 0 LLM calls · 184ms ⎯⎯</span>\n' },
        ],
    },
    compile: {
        title: 'COMPILE',
        lines: [
            { t: 100, text: '<span class="p">$</span> lumen compile\n' },
            { t: 300, text: '<span class="m">→ 6 unprocessed sources · 142 chunks</span>\n' },
            {
                t: 200,
                text: '<span class="m">→ model: </span><span class="c">claude-sonnet-4</span><span class="m"> (cache_control: ephemeral)</span>\n',
            },
            {
                t: 500,
                text: '<span class="m">  extracting concepts…</span> <span class="g">[1/6]</span> minions.md          <span class="g">+4 concepts · +7 edges</span>\n',
            },
            {
                t: 400,
                text: '<span class="m">  extracting concepts…</span> <span class="g">[2/6]</span> attention.pdf        <span class="g">+6 concepts · +11 edges</span>\n',
            },
            {
                t: 400,
                text: '<span class="m">  extracting concepts…</span> <span class="g">[3/6]</span> karpathy-nanogpt.md  <span class="g">+3 concepts · +8 edges</span>\n',
            },
            {
                t: 400,
                text: '<span class="m">  extracting concepts…</span> <span class="g">[6/6]</span> rrf-fusion.md        <span class="g">+2 concepts · +4 edges</span>\n',
            },
            { t: 300, text: '<span class="m">→ re-scoring enrichment tiers</span>\n' },
            {
                t: 300,
                text: '<span class="g">✓ 3 concepts escalated → Tier 2</span>  <span class="m">queued for enrich</span>\n',
            },
            {
                t: 200,
                text: '<span class="g">✓ 1 concept escalated  → Tier 1</span>  <span class="m">(self-attention)</span>\n\n',
            },
            { t: 200, text: '<span class="y">⎯⎯ 6 LLM calls · cache hit 73% · 12.4s ⎯⎯</span>\n' },
        ],
    },
    ask: {
        title: 'ASK · STREAMING',
        lines: [
            {
                t: 100,
                text: '<span class="p">$</span> lumen ask "how do stripe\'s minions compare to agent swarms?"\n',
            },
            { t: 300, text: '<span class="m">→ intent: hybrid_search</span>\n' },
            { t: 200, text: '<span class="m">→ BM25 ▸ TF-IDF ▸ vector  ⟶  RRF (k=60)</span>\n' },
            {
                t: 400,
                text: '<span class="m">→ 14 chunks retrieved · ranked by relevance_density</span>\n',
            },
            { t: 200, text: '<span class="m">→ synthesizing (stream)…</span>\n\n' },
            { t: 500, text: 'Stripe\'s "Minions" are task-specialized ' },
            { t: 150, text: 'sub-agents spawned by a ' },
            { t: 150, text: 'coordinator — think hierarchical ' },
            { t: 150, text: 'delegation. ' },
            { t: 200, text: 'Agent swarms (e.g. ' },
            { t: 120, text: 'MetaGPT, AutoGen) typically use ' },
            { t: 120, text: 'peer-to-peer message passing ' },
            { t: 150, text: 'without a strict hierarchy.\n\n' },
            {
                t: 200,
                text: '<span class="m">Sources: stripe/minions.md · metagpt/paper.pdf · autogen/docs</span>\n\n',
            },
            { t: 200, text: '<span class="y">⎯⎯ 1 LLM call · 1,912 tok · 3.1s ⎯⎯</span>\n' },
        ],
    },
    graph: {
        title: 'GRAPH',
        lines: [
            { t: 100, text: '<span class="p">$</span> lumen graph pagerank --top 8\n\n' },
            { t: 300, text: '<span class="m">rank  score   concept</span>\n' },
            { t: 100, text: '<span class="m">────  ─────   ──────────────────────</span>\n' },
            { t: 150, text: '  <span class="c">01</span>  0.1842  transformer\n' },
            { t: 100, text: '  <span class="c">02</span>  0.1391  self-attention\n' },
            { t: 100, text: '  <span class="c">03</span>  0.0974  rag\n' },
            { t: 100, text: '  <span class="c">04</span>  0.0831  agent-loop\n' },
            { t: 100, text: '  <span class="c">05</span>  0.0702  embedding\n' },
            { t: 100, text: '  <span class="c">06</span>  0.0614  rrf-fusion\n' },
            { t: 100, text: '  <span class="c">07</span>  0.0518  bm25\n' },
            { t: 100, text: '  <span class="c">08</span>  0.0471  scaling-laws\n\n' },
            {
                t: 200,
                text: '<span class="p">$</span> lumen graph path "transformer" "rrf-fusion"\n\n',
            },
            {
                t: 300,
                text: '<span class="g">transformer</span>     → <span class="m">produces</span> → <span class="g">embedding</span>\n',
            },
            {
                t: 100,
                text: '<span class="g">embedding</span>       → <span class="m">indexed-by</span> → <span class="g">hnsw</span>\n',
            },
            {
                t: 100,
                text: '<span class="g">hnsw</span>            → <span class="m">fused-via</span> → <span class="g">rrf-fusion</span>\n\n',
            },
            { t: 200, text: '<span class="m">3 hops · confidence 0.71</span>\n' },
        ],
    },
    install: {
        title: 'INSTALL · CLAUDE CODE',
        lines: [
            { t: 100, text: '<span class="p">$</span> lumen install claude\n' },
            {
                t: 400,
                text: '<span class="m">→ detected:</span> <span class="c">~/.claude</span><span class="m"> (Claude Code)</span>\n',
            },
            {
                t: 200,
                text: '<span class="g">✓</span> wrote <span class="c">CLAUDE.md</span>                                <span class="m">(brain-first protocol)</span>\n',
            },
            {
                t: 200,
                text: '<span class="g">✓</span> wrote <span class="c">.mcp.json</span>                                <span class="m">(LUMEN_DIR bound)</span>\n',
            },
            {
                t: 200,
                text: '<span class="g">✓</span> wrote <span class="c">.claude/skills/lumen/skill.md</span>            <span class="m">(skill)</span>\n',
            },
            {
                t: 200,
                text: '<span class="g">✓</span> wrote <span class="c">.claude/hooks/lumen-pretool.sh</span>         <span class="m">(PreToolUse)</span>\n',
            },
            {
                t: 200,
                text: '<span class="g">✓</span> wrote <span class="c">.claude/hooks/lumen-signal.sh</span>          <span class="m">(Stop)</span>\n',
            },
            {
                t: 300,
                text: '<span class="m">→ verifying</span>   brain_ops ✓  search ✓  capture ✓  concept ✓ <span class="m">(19 tools)</span>\n\n',
            },
            {
                t: 200,
                text: '<span class="y">next:</span> open a new chat and ask anything. your brain is wired.\n',
            },
        ],
    },
};
