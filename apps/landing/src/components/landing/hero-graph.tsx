'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
    HERO_CONCEPTS,
    HERO_EDGES,
    CLUSTER_COLORS,
    type Cluster,
    type Concept,
} from '@/lib/landing/graph-data';

type HoverState = {
    concept: Concept;
    x: number;
    y: number;
    neighbors: number;
} | null;

function tierFill(tier: 1 | 2 | 3) {
    return tier === 1 ? '#111' : tier === 2 ? 'var(--accent)' : '#fff';
}
function tierStroke(tier: 1 | 2 | 3) {
    return tier === 3 ? '#9a9a9a' : tier === 2 ? 'var(--accent)' : '#111';
}

export function HeroGraph() {
    const [cluster, setCluster] = useState<Cluster | 'all'>('all');
    const [focused, setFocused] = useState<string | null>(null);
    const [hover, setHover] = useState<HoverState>(null);
    const canvasRef = useRef<HTMLDivElement>(null);

    const adj = useMemo(() => {
        const m: Record<string, Set<string>> = {};
        HERO_CONCEPTS.forEach((n) => (m[n.id] = new Set()));
        HERO_EDGES.forEach(([a, b]) => {
            m[a].add(b);
            m[b].add(a);
        });
        return m;
    }, []);

    const twoHop = useMemo(() => {
        return (id: string) => {
            const s = new Set<string>([id]);
            adj[id]?.forEach((b) => {
                s.add(b);
                adj[b]?.forEach((c) => s.add(c));
            });
            return s;
        };
    }, [adj]);

    const clusterHulls = useMemo(() => {
        const groups: Record<string, Concept[]> = {};
        HERO_CONCEPTS.forEach((n) => {
            (groups[n.cluster] ||= []).push(n);
        });
        return Object.entries(groups).map(([k, arr]) => {
            const cx = arr.reduce((s, n) => s + n.x, 0) / arr.length;
            const cy = arr.reduce((s, n) => s + n.y, 0) / arr.length;
            const maxR = Math.max(...arr.map((n) => Math.hypot(n.x - cx, n.y - cy))) + 30;
            return { cluster: k as Cluster, cx, cy, rx: maxR, ry: maxR * 0.85 };
        });
    }, []);

    const visible = (n: Concept) => {
        if (focused) {
            if (n.id !== focused && !twoHop(focused).has(n.id)) return false;
        }
        if (cluster !== 'all' && n.cluster !== cluster) return false;
        return true;
    };

    const visibleSet = new Set(HERO_CONCEPTS.filter(visible).map((n) => n.id));

    const visibleEdges = HERO_EDGES.filter(([a, b]) => visibleSet.has(a) && visibleSet.has(b));

    const hoverNeighbors = hover ? adj[hover.concept.id] : null;

    const pathLabel = (() => {
        const parts: string[] = [];
        if (focused) {
            const f = HERO_CONCEPTS.find((n) => n.id === focused);
            if (f) parts.push('focus: ' + f.label);
        }
        if (cluster !== 'all') parts.push('cluster: ' + cluster);
        return parts.length ? parts.join(' · ') : 'all concepts';
    })();

    function handleMouseMove(e: React.MouseEvent, concept: Concept) {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        setHover({
            concept,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
            neighbors: adj[concept.id]?.size ?? 0,
        });
    }

    function handleNodeClick(id: string, e: React.MouseEvent) {
        e.stopPropagation();
        setFocused((prev) => (prev === id ? null : id));
    }

    useEffect(() => {
        if (cluster === 'all') setFocused(null);
    }, [cluster]);

    return (
        <div className="hg">
            <div className="hg-head">
                <div className="hg-title">
                    <span className="hg-dot" />
                    <span>your brain</span>
                    <span className="hg-slash">/</span>
                    <span className="hg-path">{pathLabel}</span>
                </div>
                <div className="hg-stats">
                    <span>
                        <b>{visibleSet.size}</b> concepts
                    </span>
                    <span>
                        <b>{visibleEdges.length}</b> edges
                    </span>
                    <span>
                        <b>23</b> sources
                    </span>
                </div>
            </div>

            <div className="hg-canvas" ref={canvasRef} onDoubleClick={() => setFocused(null)}>
                <svg
                    viewBox="0 0 640 520"
                    width="100%"
                    height="100%"
                    preserveAspectRatio="xMidYMid meet"
                >
                    <defs>
                        <pattern id="hg-dots" width="22" height="22" patternUnits="userSpaceOnUse">
                            <circle cx="1" cy="1" r=".7" fill="#dedede" />
                        </pattern>
                    </defs>
                    <rect width="640" height="520" fill="url(#hg-dots)" />

                    <g>
                        {clusterHulls.map((h) => (
                            <g key={h.cluster}>
                                <ellipse
                                    cx={h.cx}
                                    cy={h.cy}
                                    rx={h.rx}
                                    ry={h.ry}
                                    fill={CLUSTER_COLORS[h.cluster]}
                                    opacity={0.035}
                                />
                                <text
                                    x={h.cx}
                                    y={h.cy - h.ry + 14}
                                    textAnchor="middle"
                                    fontFamily="JetBrains Mono, monospace"
                                    fontSize="9.5"
                                    letterSpacing=".15em"
                                    fill={CLUSTER_COLORS[h.cluster]}
                                    opacity={0.6}
                                >
                                    {`// ${h.cluster.toUpperCase()}`}
                                </text>
                            </g>
                        ))}
                    </g>

                    <g>
                        {HERO_EDGES.map(([a, b, w], i) => {
                            const na = HERO_CONCEPTS.find((n) => n.id === a);
                            const nb = HERO_CONCEPTS.find((n) => n.id === b);
                            if (!na || !nb) return null;
                            const isVisible = visibleSet.has(a) && visibleSet.has(b);
                            const touchingHover =
                                hover && (hover.concept.id === a || hover.concept.id === b);
                            return (
                                <line
                                    key={i}
                                    x1={na.x}
                                    y1={na.y}
                                    x2={nb.x}
                                    y2={nb.y}
                                    stroke={touchingHover ? '#111' : '#c4c4c4'}
                                    strokeWidth={0.4 + w * 1.6}
                                    opacity={!isVisible ? 0 : hover && !touchingHover ? 0.1 : 1}
                                    style={{ transition: 'opacity .15s' }}
                                />
                            );
                        })}
                    </g>

                    <g>
                        {HERO_CONCEPTS.map((n) => {
                            const isVisible = visibleSet.has(n.id);
                            const dimmed =
                                hover && hover.concept.id !== n.id && !hoverNeighbors?.has(n.id);
                            const pulse = n.id === 'transformer' || n.id === 'agent';
                            return (
                                <g
                                    key={n.id}
                                    transform={`translate(${n.x},${n.y})`}
                                    style={{
                                        cursor: 'pointer',
                                        opacity: !isVisible ? 0 : dimmed ? 0.2 : 1,
                                        transition: 'opacity .15s',
                                        pointerEvents: isVisible ? 'auto' : 'none',
                                    }}
                                    onMouseEnter={(e) => handleMouseMove(e, n)}
                                    onMouseMove={(e) => handleMouseMove(e, n)}
                                    onMouseLeave={() => setHover(null)}
                                    onClick={(e) => handleNodeClick(n.id, e)}
                                >
                                    {pulse ? (
                                        <circle
                                            r={n.r}
                                            fill="none"
                                            stroke={tierStroke(n.tier)}
                                            strokeWidth="1"
                                            opacity="0.5"
                                        >
                                            <animate
                                                attributeName="r"
                                                values={`${n.r};${n.r + 14}`}
                                                dur="2.6s"
                                                repeatCount="indefinite"
                                            />
                                            <animate
                                                attributeName="opacity"
                                                values=".5;0"
                                                dur="2.6s"
                                                repeatCount="indefinite"
                                            />
                                        </circle>
                                    ) : null}
                                    <circle
                                        r={n.r}
                                        fill={tierFill(n.tier)}
                                        stroke={tierStroke(n.tier)}
                                        strokeWidth={hover?.concept.id === n.id ? 3 : 1.5}
                                    />
                                    <text
                                        y={n.r + 12}
                                        textAnchor="middle"
                                        fontFamily="JetBrains Mono, monospace"
                                        fontSize={n.tier === 1 ? 10.5 : 9.5}
                                        fill={n.tier === 1 ? '#222' : '#666'}
                                    >
                                        {n.label}
                                    </text>
                                </g>
                            );
                        })}
                    </g>
                </svg>

                {hover ? (
                    <div className="hg-tip" style={{ left: hover.x, top: hover.y }}>
                        <div className="tip-name">{hover.concept.label}</div>
                        <div className="tip-meta">
                            tier {hover.concept.tier} · {hover.concept.cluster} · {hover.neighbors}{' '}
                            edges
                        </div>
                        <div className="tip-truth">{hover.concept.truth}</div>
                    </div>
                ) : null}

                <div className="hg-legend">
                    <span className="it">
                        <span className="sw s1" />
                        tier 1 · full
                    </span>
                    <span className="it">
                        <span className="sw s2" />
                        tier 2 · enriched
                    </span>
                    <span className="it">
                        <span className="sw s3" />
                        tier 3 · stub
                    </span>
                </div>
            </div>

            <div className="hg-foot">
                {(['all', 'ml', 'retrieval', 'systems', 'mlops'] as const).map((c) => {
                    const dotColor = c === 'all' ? '#888' : CLUSTER_COLORS[c as Cluster];
                    return (
                        <button
                            key={c}
                            className={cluster === c ? 'fp on' : 'fp'}
                            type="button"
                            onClick={() => setCluster(c)}
                        >
                            <span className="fp-dot" style={{ background: dotColor }} />
                            {c}
                        </button>
                    );
                })}
                <span className="fp-hint">
                    click a node to focus · double-click canvas to reset
                </span>
            </div>
        </div>
    );
}
