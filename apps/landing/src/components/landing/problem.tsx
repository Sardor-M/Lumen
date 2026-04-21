const BOOKMARKS = [
    ['2025-11-04', 'stripe.com/blog/minions', 'unread'],
    ['2025-11-02', 'arxiv.org/abs/2301.12345', 'unread'],
    ['2025-10-29', 'simonwillison.net/2025/Oct/…', 'unread'],
    ['2025-10-28', 'lilianweng.github.io/…/agent', 'unread'],
    ['2025-10-27', 'jepsen.io/analyses/…', 'skimmed'],
    ['2025-10-25', 'blog.nelhage.com/post/…', 'unread'],
    ['2025-10-24', 'eli.thegreenplace.net/…', 'unread'],
    ['2025-10-22', 'matklad.github.io/…/arenas', 'unread'],
] as const;

export function Problem() {
    return (
        <section id="problem">
            <div className="sec-head">
                <div>
                    <div className="num">§ 01 / PROBLEM</div>
                    <div className="tag">the context gap</div>
                </div>
                <h2>
                    Your agent has read the internet.{' '}
                    <span className="mute">
                        It still hasn&apos;t read <em>you</em>.
                    </span>
                </h2>
            </div>

            <div className="problem">
                <div>
                    <h3>{`// For you`}</h3>
                    <p>
                        Bookmarks are a graveyard. Notes don&apos;t scale. The insight from that
                        paper you read in March is gone by May. You re-read the same posts because
                        you can&apos;t remember if you already read them.
                    </p>

                    <div className="stat">
                        <div className="cell">
                            <div className="big">7%</div>
                            <div className="lab">articles revisited in 90d</div>
                        </div>
                        <div className="cell">
                            <div className="big">~0</div>
                            <div className="lab">bookmarks actually re-read</div>
                        </div>
                        <div className="cell">
                            <div className="big">50+</div>
                            <div className="lab">articles/month/dev avg</div>
                        </div>
                    </div>

                    <div className="bookmark-graveyard" aria-hidden="true">
                        {BOOKMARKS.map(([date, url, status]) => (
                            <div className="bm-item" key={url}>
                                <span className="date">{date}</span>
                                <span className="url">{url}</span>
                                <span className="status">{status}</span>
                            </div>
                        ))}
                    </div>
                </div>

                <div>
                    <h3>{`// For your agent`}</h3>
                    <p>
                        Every conversation starts from zero. You paste the same context. Re-explain
                        the same ideas. Answer the same questions about your own domain. The model
                        knows the internet — but not <em>you</em>.
                    </p>

                    <div className="ba">
                        <div className="l">
                            <h4>— WITHOUT LUMEN</h4>
                            <div className="msg">
                                <span className="who">you:</span>explain how our RRF fusion works
                            </div>
                            <div className="msg">
                                <span className="who">ai:</span>Reciprocal Rank Fusion is a
                                technique that…
                            </div>
                            <div className="msg">
                                <span className="who">you:</span>no, ours. with k=60, the three
                                signals…
                            </div>
                            <div className="msg">
                                <span className="who">ai:</span>I don&apos;t have context on your
                                system.
                            </div>
                            <div className="msg">
                                <span className="who">you:</span>ok. it&apos;s BM25 + TF-IDF +
                                vector, weighted…
                            </div>
                            <div className="msg" style={{ color: 'var(--mute)' }}>
                                <span className="who">{`// 14 more messages of re-context`}</span>
                            </div>
                        </div>
                        <div className="r">
                            <h4>— WITH LUMEN</h4>
                            <div className="msg">
                                <span className="who">you:</span>explain how our RRF fusion works
                            </div>
                            <div className="msg" style={{ color: 'var(--accent)' }}>
                                <span className="who">brain:</span>
                                brain_ops(reciprocal-rank-fusion) → tier 1, 4 sources
                            </div>
                            <div className="msg">
                                <span className="who">ai:</span>Your fusion uses k=60 with three
                                signals: BM25 (w=1.0), TF-IDF (w=0.7), vector (w=0.9). Ranked by{' '}
                                <code>relevance_density</code>…
                            </div>
                            <div className="msg" style={{ color: 'var(--mute)' }}>
                                <span className="who">{`// grounded in your KB on turn 1`}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
}
