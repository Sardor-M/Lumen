'use client';

import { useEffect, useRef, useState } from 'react';
import { TERMINAL_SCRIPTS, type TerminalKey } from '@/lib/landing/terminal-scripts';

const TAB_ORDER: readonly TerminalKey[] = ['add', 'compile', 'ask', 'graph', 'install'];

const TAB_LABELS: Record<TerminalKey, { num: string; label: string }> = {
    add: { num: '01 · ADD', label: 'ingest a url' },
    compile: { num: '02 · COMPILE', label: 'extract concepts' },
    ask: { num: '03 · ASK', label: 'query your brain' },
    graph: { num: '04 · GRAPH', label: 'pagerank + paths' },
    install: { num: '05 · INSTALL', label: 'wire into claude code' },
};

export function Demo() {
    const [active, setActive] = useState<TerminalKey>('add');
    const [html, setHtml] = useState('');
    const [userInteracted, setUserInteracted] = useState(false);
    const runToken = useRef(0);
    const termBody = useRef<HTMLDivElement>(null);
    const sectionRef = useRef<HTMLElement>(null);
    const started = useRef(false);

    useEffect(() => {
        const el = sectionRef.current;
        if (!el || started.current) return;
        const obs = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting && !started.current) {
                        started.current = true;
                        obs.disconnect();
                        void autoLoop(0);
                    }
                });
            },
            { threshold: 0.3 },
        );
        obs.observe(el);
        return () => obs.disconnect();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    async function runScript(key: TerminalKey) {
        runToken.current++;
        const myToken = runToken.current;
        const script = TERMINAL_SCRIPTS[key];
        setActive(key);
        let buffer = '';
        setHtml('');
        for (const line of script.lines) {
            await new Promise((r) => setTimeout(r, line.t));
            if (myToken !== runToken.current) return;
            buffer += line.text;
            setHtml(buffer);
            if (termBody.current) {
                termBody.current.scrollTop = termBody.current.scrollHeight;
            }
        }
    }

    async function autoLoop(idx: number) {
        if (userInteractedRef.current) return;
        const key = TAB_ORDER[idx % TAB_ORDER.length];
        await runScript(key);
        if (!userInteractedRef.current) {
            setTimeout(() => void autoLoop(idx + 1), 1800);
        }
    }

    const userInteractedRef = useRef(false);
    useEffect(() => {
        userInteractedRef.current = userInteracted;
    }, [userInteracted]);

    function handleTabClick(key: TerminalKey) {
        setUserInteracted(true);
        void runScript(key);
    }

    return (
        <section id="demo" ref={sectionRef}>
            <div className="sec-head">
                <div>
                    <div className="num">§ 02 / LIVE DEMO</div>
                    <div className="tag">terminal · interactive</div>
                </div>
                <h2>
                    Five commands. <span className="mute">One evolving brain.</span>
                </h2>
            </div>

            <div className="term-wrap">
                <div className="term-tabs" role="tablist">
                    {TAB_ORDER.map((key) => (
                        <button
                            key={key}
                            type="button"
                            className={active === key ? 'term-tab active' : 'term-tab'}
                            onClick={() => handleTabClick(key)}
                        >
                            <span className="lab">{TAB_LABELS[key].num}</span>
                            {TAB_LABELS[key].label}
                        </button>
                    ))}
                </div>

                <div className="term">
                    <div className="term-chrome">
                        <div className="dots">
                            <i style={{ background: '#ff5f56' }} />
                            <i style={{ background: '#ffbd2e' }} />
                            <i style={{ background: '#27c93f' }} />
                        </div>
                        <span className="ttl">~/projects/research — lumen</span>
                        <span className="rhs">{TERMINAL_SCRIPTS[active].title}</span>
                    </div>
                    <div
                        className="term-body"
                        ref={termBody}
                        dangerouslySetInnerHTML={{
                            __html: html + '<span class="cursor"></span>',
                        }}
                    />
                </div>
            </div>
        </section>
    );
}
