type Stage = {
    num: string;
    name: string;
    llm?: 'LLM' | 'SQLITE';
    desc: string;
    items: string[];
};

const STAGES: readonly Stage[] = [
    {
        num: 'STAGE 01',
        name: 'INGEST',
        desc: 'Detect source, extract content, content-address by SHA-256. Dedup if already seen.',
        items: ['URL / HTML', 'PDF', 'YouTube captions', 'arXiv (atom + pdf)', 'File / Folder'],
    },
    {
        num: 'STAGE 02',
        name: 'CHUNK',
        desc: 'Structural splits: headings, paragraphs, atomic code blocks. Merge <50 tok, split >1000 tok.',
        items: ['Markdown-aware', 'Sentence boundary splits', 'Atomic code blocks'],
    },
    {
        num: 'STAGE 03',
        name: 'STORE',
        llm: 'SQLITE',
        desc: 'WAL mode, FTS5 full-text index, TF-IDF vocab, optional vector embeddings via sqlite-vec.',
        items: ['sources', 'chunks + chunks_fts', 'vec_chunks (ANN)', 'embedding_meta'],
    },
    {
        num: 'STAGE 04',
        name: 'COMPILE',
        llm: 'LLM',
        desc: 'Extract concepts with compiled_truth + append-only timeline. Edges, links, backlinks.',
        items: [
            'concepts (mutable truth)',
            'timeline (immutable)',
            'edges (weighted)',
            'tier-score → enrich',
        ],
    },
    {
        num: 'STAGE 05',
        name: 'QUERY',
        desc: '3-signal hybrid via Reciprocal Rank Fusion. Intent-routed. Streaming synthesis.',
        items: ['BM25 (FTS5)', 'TF-IDF (cosine)', 'Vector (ANN)', 'RRF k=60 · relevance_density'],
    },
];

export function HowItWorks() {
    return (
        <section id="how">
            <div className="sec-head">
                <div>
                    <div className="num">§ 03 / HOW IT WORKS</div>
                    <div className="tag">two pipelines, one graph</div>
                </div>
                <h2>
                    Ingest locally. Compile with the LLM.{' '}
                    <span className="mute">Search without either.</span>
                </h2>
            </div>

            <div className="pipe-wrap">
                <div className="pipe">
                    {STAGES.map((s) => (
                        <div className="stage" key={s.num}>
                            <div className="st-num">{s.num}</div>
                            <div className="st-name">
                                {s.name}
                                {s.llm ? <span className="llm">{s.llm}</span> : null}
                            </div>
                            <div className="st-desc">{s.desc}</div>
                            <div className="st-items">
                                {s.items.map((it) => (
                                    <div className="it" key={it}>
                                        {it}
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>

                <div className="pipe-note">
                    <span>
                        <b style={{ color: 'var(--ink)' }}>Offline by default.</b>&nbsp; Stages
                        01→03 and 05 need <span className="ch">0</span> API calls.
                    </span>
                    <span>
                        <b style={{ color: 'var(--ink)' }}>LLM optional.</b>&nbsp; Only stage 04
                        (compile) and <span className="ch">ask</span> require a backend.
                    </span>
                    <span>
                        <b style={{ color: 'var(--ink)' }}>Backends:</b>&nbsp;{' '}
                        <span className="ch">anthropic</span> <span className="ch">openrouter</span>{' '}
                        <span className="ch">ollama</span>
                    </span>
                </div>
            </div>
        </section>
    );
}
