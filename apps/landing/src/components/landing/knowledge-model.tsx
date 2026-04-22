'use client';

import { useState, useRef, useEffect } from 'react';
import { MINI_NODES, MINI_EDGES } from '@/lib/landing/graph-data';
import { CONCEPT_DETAILS } from '@/lib/landing/concepts';

function miniFill(tier: 1 | 2 | 3) {
    return tier === 1 ? 'var(--accent)' : tier === 2 ? '#111' : '#fff';
}
function miniStroke(tier: 1 | 2 | 3) {
    return tier === 3 ? '#bbb' : tier === 1 ? 'var(--accent)' : '#111';
}

export function KnowledgeModel() {
    const [conceptId, setConceptId] = useState('transformer');
    const [hover, setHover] = useState<string | null>(null);
    const cardRef = useRef<HTMLElement>(null);

    const detail = CONCEPT_DETAILS[conceptId] ?? CONCEPT_DETAILS.transformer;

    useEffect(() => {
        if (cardRef.current) {
            cardRef.current.animate([{ background: '#eef2ff' }, { background: '#fff' }], {
                duration: 500,
            });
        }
    }, [conceptId]);

    useEffect(() => {
        const onClick = (e: MouseEvent) => {
            const target = e.target as HTMLElement | null;
            const c = target?.dataset?.c;
            if (c && CONCEPT_DETAILS[c]) {
                setConceptId(c);
                document
                    .getElementById('graph')
                    ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        };
        document.addEventListener('click', onClick);
        return () => document.removeEventListener('click', onClick);
    }, []);

    return (
        <section id="graph">
            <div className="sec-head">
                <div>
                    <div className="num">§ 04 / KNOWLEDGE MODEL</div>
                    <div className="tag">compiled truth + timeline</div>
                </div>
                <h2>
                    Every concept:{' '}
                    <span className="mute">a mutable understanding. An immutable trail.</span>
                </h2>
            </div>

            <div className="graph-wrap">
                <div className="graph-box">
                    <div className="graph-toolbar">
                        <span className="chip">lumen graph neighbors transformer -d 2</span>
                        <span className="chip">layout: force · pagerank · 22 nodes · 32 edges</span>
                    </div>
                    <svg
                        viewBox="0 0 600 520"
                        width="100%"
                        height="100%"
                        style={{ display: 'block' }}
                    >
                        <defs>
                            <pattern
                                id="mg-dots"
                                width="22"
                                height="22"
                                patternUnits="userSpaceOnUse"
                            >
                                <circle cx="1" cy="1" r=".7" fill="#e4e4e4" />
                            </pattern>
                        </defs>
                        <rect width="600" height="520" fill="url(#mg-dots)" />

                        <g>
                            {MINI_EDGES.map(([a, b, w], i) => {
                                const na = MINI_NODES.find((n) => n.id === a);
                                const nb = MINI_NODES.find((n) => n.id === b);
                                if (!na || !nb) return null;
                                const touching = hover === a || hover === b;
                                return (
                                    <line
                                        key={i}
                                        x1={na.x}
                                        y1={na.y}
                                        x2={nb.x}
                                        y2={nb.y}
                                        stroke={touching ? '#111' : '#b7b7b7'}
                                        strokeWidth={0.6 + w * 1.8}
                                        opacity={hover && !touching ? 0.25 : 1}
                                        style={{ transition: 'opacity .15s' }}
                                    />
                                );
                            })}
                        </g>

                        <g>
                            {MINI_NODES.map((n) => (
                                <g
                                    key={n.id}
                                    transform={`translate(${n.x},${n.y})`}
                                    style={{ cursor: 'pointer' }}
                                    onMouseEnter={() => setHover(n.id)}
                                    onMouseLeave={() => setHover(null)}
                                    onClick={() => CONCEPT_DETAILS[n.id] && setConceptId(n.id)}
                                >
                                    <circle
                                        r={n.r}
                                        fill={miniFill(n.tier)}
                                        stroke={miniStroke(n.tier)}
                                        strokeWidth={hover === n.id ? 3 : 1.5}
                                    />
                                    <text
                                        y={n.r + 14}
                                        textAnchor="middle"
                                        fontFamily="JetBrains Mono, monospace"
                                        fontSize="10"
                                        fill="#555"
                                    >
                                        {n.label}
                                    </text>
                                </g>
                            ))}
                        </g>
                    </svg>
                </div>

                <aside className="concept-card" ref={cardRef}>
                    <div className="cc-head">
                        <div className="slug">concept · {conceptId}</div>
                        <div className="name">{detail.name}</div>
                        <span className="tier">{detail.tier}</span>
                    </div>
                    <div className="cc-body">
                        <div className="lbl">{`// COMPILED TRUTH — mutable`}</div>
                        <div dangerouslySetInnerHTML={{ __html: detail.truth }} />
                    </div>
                    <div className="cc-timeline">
                        <div className="lbl">{`// TIMELINE — append-only`}</div>
                        {detail.timeline.map(([dt, text]) => (
                            <div className="ev" key={dt + text}>
                                <span className="dt">{dt}</span>
                                {text}
                            </div>
                        ))}
                    </div>
                    <div className="cc-edges">
                        <div className="lbl">{`// OUTBOUND EDGES — ${detail.edges.length}`}</div>
                        <div className="row">
                            {detail.edges.map((e) => (
                                <button className="e" key={e} data-c={e} type="button">
                                    {e}
                                </button>
                            ))}
                        </div>
                    </div>
                </aside>
            </div>
        </section>
    );
}
