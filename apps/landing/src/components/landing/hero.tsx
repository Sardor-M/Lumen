import { EYEBROW, HERO_STATS, INSTALL_CMDS, LINKS } from '@lumen/brand';
import { InstallBox } from './copy-button';
import { HeroGraph } from './hero-graph';

export function Hero() {
    return (
        <section className="hero" id="top">
            <div className="wrap">
                <div className="hero-grid">
                    <div className="hero-left">
                        <div className="eyebrow">
                            <span className="dot" />
                            <span>{EYEBROW}</span>
                        </div>

                        <h1 className="hero-title">
                            Knowledge is
                            <br />
                            <span className="accent">source code.</span>
                            <br />
                            Compile yours.
                        </h1>
                        <p className="hero-sub">
                            A local knowledge compiler that grows every time you read — and every
                            time your agent answers. <b>Compiled truth + append-only timeline</b>{' '}
                            per concept. No cloud. No lock-in.
                        </p>

                        <InstallBox cmd={INSTALL_CMDS.install} />

                        <div className="hero-cta-row">
                            <a className="btn" href="#demo">
                                Demo <span className="arr"></span>
                            </a>
                            <a className="btn ghost" href={LINKS.github}>
                                view on github
                            </a>
                        </div>

                        <div className="hero-meta">
                            <span>
                                <b>{HERO_STATS.hybridSearchSignals}-signal</b> hybrid search
                            </span>
                            <span>
                                <b>{HERO_STATS.mcpTools}</b> MCP tools
                            </span>
                            <span>
                                <b>{HERO_STATS.sqliteFiles}</b> SQLite file
                            </span>
                            <span>
                                <b>{HERO_STATS.servers}</b> servers
                            </span>
                        </div>
                    </div>

                    <div className="hero-right">
                        <HeroGraph />
                    </div>
                </div>
            </div>
        </section>
    );
}
