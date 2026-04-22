import { INSTALL_CMDS } from '@lumen/brand';
import { InstallBox } from './copy-button';

type Component = {
    n: string;
    title: string;
    file: string;
    desc: React.ReactNode;
};

const COMPONENTS: readonly Component[] = [
    {
        n: '01',
        title: 'Brain-first protocol',
        file: 'CLAUDE.md',
        desc: (
            <>
                Loaded every message. Tells Claude: check the brain before answering, cite sources
                as <code>[Source: title]</code>, only hit the web after the brain returns nothing.
            </>
        ),
    },
    {
        n: '02',
        title: 'MCP server config',
        file: '.mcp.json',
        desc: (
            <>
                Binds <code>lumen --mcp</code> with <code>LUMEN_DIR</code> baked in — the server
                always connects to the right workspace.
            </>
        ),
    },
    {
        n: '03',
        title: 'Skill',
        file: '.claude/skills/lumen/skill.md',
        desc: 'Tool routing table, capture protocol, and session-summary instructions. Supplements the main protocol.',
    },
    {
        n: '04',
        title: 'PreToolUse hook',
        file: 'lumen-pretool.sh',
        desc: (
            <>
                Fires before every <code>Glob</code> / <code>Grep</code>. Reminds Claude that MCP
                search tools exist — brain before filesystem.
            </>
        ),
    },
    {
        n: '05',
        title: 'Stop hook',
        file: 'lumen-signal.sh',
        desc: (
            <>
                Fires after every response. Nudges the agent to call <code>capture</code> if new
                knowledge appeared.
            </>
        ),
    },
];

const CYCLE = [
    {
        n: '01',
        title: 'User message arrives',
        desc: (
            <>
                Skill intercepts → <code>brain_ops(query)</code> auto-routes by intent.
            </>
        ),
    },
    {
        n: '02',
        title: 'Brain returns structured context',
        desc: 'Concept page · graph path · neighborhood · or top-ranked chunks.',
    },
    {
        n: '03',
        title: 'Agent answers with KB grounding',
        desc: 'Compiled truth is cited inline. No context-paste from you.',
    },
    {
        n: '04',
        title: 'Stop hook fires',
        desc: (
            <>
                If new knowledge → <code>capture(type, title, content, related_slugs)</code>.
            </>
        ),
    },
    {
        n: '05',
        title: 'Concept upserted + timeline entry + backlinks',
        desc: 'Brain is richer for next session. Tiers re-scored.',
    },
];

export function AgentWiring() {
    return (
        <section id="agent">
            <div className="sec-head">
                <div>
                    <div className="num">§ 05 / AGENT WIRING</div>
                    <div className="tag">always-on brain protocol</div>
                </div>
                <h2>
                    One command wires Lumen into Claude Code.{' '}
                    <span className="mute">Every cycle enriches the graph.</span>
                </h2>
            </div>

            <div className="agent">
                <div>
                    <h3>{`// lumen install claude`}</h3>
                    <p>
                        Drops five components into your Claude Code config. No subscription, no
                        daemon, no account. They run inline with your agent and speak to the SQLite
                        file directly via MCP.
                    </p>

                    <InstallBox cmd={INSTALL_CMDS.installClaude} maxWidth={480} />

                    <div className="components">
                        {COMPONENTS.map((c) => (
                            <div className="comp" key={c.n}>
                                <div className="n">{c.n}</div>
                                <div>
                                    <div className="t">
                                        {c.title} <code>{c.file}</code>
                                    </div>
                                    <div className="d">{c.desc}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="cycle">
                    <div className="title">{`// THE AGENT LOOP — compounds daily`}</div>
                    <ol>
                        {CYCLE.map((step) => (
                            <li key={step.n}>
                                <span className="step-n">{step.n}</span>
                                <div>
                                    <div className="step-t">{step.title}</div>
                                    <div className="step-d">{step.desc}</div>
                                </div>
                            </li>
                        ))}
                    </ol>
                </div>
            </div>
        </section>
    );
}
