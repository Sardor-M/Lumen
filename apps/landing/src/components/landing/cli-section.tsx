type CliRow = {
    cmd: string;
    arg?: string;
    whatNode: React.ReactNode;
    llm: 'yes' | 'api call' | '—';
};

const ROWS: readonly CliRow[] = [
    {
        cmd: 'init',
        whatNode: (
            <>
                Create <code>~/.lumen</code> workspace. One-time bootstrap.
            </>
        ),
        llm: '—',
    },
    {
        cmd: 'add',
        arg: '<input>',
        whatNode: 'Ingest URL, PDF, YouTube, arXiv id, file, or folder. SHA-256 dedup.',
        llm: '—',
    },
    {
        cmd: 'compile',
        arg: '[--all]',
        whatNode: 'Extract concepts + edges + timeline from unprocessed sources. Delta-aware.',
        llm: 'yes',
    },
    {
        cmd: 'enrich',
        arg: '[--status | --all]',
        whatNode: 'Tier-score concepts. LLM-enrich those crossing thresholds.',
        llm: 'yes',
    },
    {
        cmd: 'embed',
        whatNode: 'Generate vector embeddings for chunks. OpenAI or Ollama.',
        llm: 'api call',
    },
    {
        cmd: 'search',
        arg: '<query>',
        whatNode: 'Hybrid local search. BM25 + TF-IDF + vector + graph walk, fused via RRF.',
        llm: '—',
    },
    {
        cmd: 'ask',
        arg: '<question>',
        whatNode: 'Search + LLM-synthesized answer, streamed to stdout.',
        llm: 'yes',
    },
    {
        cmd: 'graph',
        arg: '<sub>',
        whatNode: 'pagerank · path · neighbors · community · export · report',
        llm: '—',
    },
    {
        cmd: 'profile',
        whatNode: 'Corpus summary — sources, density, frequent queries. Cached.',
        llm: '—',
    },
    {
        cmd: 'status',
        arg: '[--json]',
        whatNode: 'DB statistics. Plain text or JSON for scripting.',
        llm: '—',
    },
    {
        cmd: 'memory',
        arg: 'export|import',
        whatNode: 'Portable JSONL or SQL backup. Move your brain anywhere.',
        llm: '—',
    },
    {
        cmd: 'serve',
        whatNode: 'Local web UI against your KB. Next.js 15 · shadcn/ui.',
        llm: '—',
    },
    {
        cmd: 'watch',
        arg: '<dir>',
        whatNode: 'Watch a folder and auto-ingest changes. Good for Obsidian vaults.',
        llm: '—',
    },
    {
        cmd: 'daemon',
        arg: 'install|uninstall',
        whatNode: 'Run as background service. launchd (mac) or systemd (linux).',
        llm: '—',
    },
    {
        cmd: 'install',
        arg: 'claude|codex',
        whatNode: 'Wire into Claude Code or Codex. Skill + PreToolUse + Stop hook.',
        llm: '—',
    },
];

const SPLIT = Math.ceil(ROWS.length / 2);
const COLUMNS: readonly (readonly CliRow[])[] = [ROWS.slice(0, SPLIT), ROWS.slice(SPLIT)];

export function CliSection() {
    return (
        <section id="cli">
            <div className="sec-head">
                <div>
                    <div className="num">§ 07 / CLI REFERENCE</div>
                    <div className="tag">lumen &lt;command&gt;</div>
                </div>
                <h2>
                    A single binary.{' '}
                    <span className="mute">Everything the MCP does, from your shell.</span>
                </h2>
            </div>

            <div className="cli">
                <div className="cli-grid">
                    {COLUMNS.map((col, i) => (
                        <div className="cli-card" key={i}>
                            <table>
                                <thead>
                                    <tr>
                                        <th>command</th>
                                        <th>what it does</th>
                                        <th>llm</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {col.map((r) => (
                                        <tr key={r.cmd + (r.arg ?? '')}>
                                            <td className="cmd">
                                                {r.cmd}
                                                {r.arg ? (
                                                    <span className="arg"> {r.arg}</span>
                                                ) : null}
                                            </td>
                                            <td className="what">{r.whatNode}</td>
                                            <td className={r.llm === 'yes' ? 'llm y' : 'llm'}>
                                                {r.llm}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}
