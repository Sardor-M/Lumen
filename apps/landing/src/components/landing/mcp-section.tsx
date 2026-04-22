'use client';

import { useMemo, useState } from 'react';
import { MCP_TOOLS, type McpCategory, type McpTool } from '@/lib/landing/mcp-tools';

type Filter = McpCategory | 'all';
const FILTERS: readonly Filter[] = ['all', 'brain', 'ingest', 'graph', 'meta'];

export function McpSection() {
    const [filter, setFilter] = useState<Filter>('all');
    const [q, setQ] = useState('');

    const rows = useMemo(() => {
        return MCP_TOOLS.filter((t) => {
            if (filter !== 'all' && t.category !== filter) return false;
            if (
                q &&
                !`${t.name} ${t.category} ${t.description}`.toLowerCase().includes(q.toLowerCase())
            )
                return false;
            return true;
        });
    }, [filter, q]);

    const columns = useMemo<readonly McpTool[][]>(() => {
        const split = Math.ceil(rows.length / 2);
        return [rows.slice(0, split), rows.slice(split)];
    }, [rows]);

    return (
        <section id="mcp">
            <div className="sec-head">
                <div>
                    <div className="num">§ 06 / MCP SERVER</div>
                    <div className="tag">19 tools · stdio</div>
                </div>
                <h2>
                    Every capability as an MCP tool.{' '}
                    <span className="mute">
                        Point any MCP client at <code>lumen --mcp</code>.
                    </span>
                </h2>
            </div>

            <div className="mcp-search">
                <input
                    type="text"
                    placeholder="filter tools…"
                    aria-label="filter"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                />
                <div className="mcp-filters">
                    {FILTERS.map((f) => (
                        <button
                            key={f}
                            type="button"
                            className={filter === f ? 'on' : undefined}
                            onClick={() => setFilter(f)}
                        >
                            {f}
                        </button>
                    ))}
                </div>
                <span className="cnt">
                    {rows.length} tool{rows.length === 1 ? '' : 's'}
                </span>
            </div>

            <div className="mcp">
                <div className="mcp-grid">
                    {columns.map((col, i) => (
                        <div className="mcp-card" key={i}>
                            <table>
                                <thead>
                                    <tr>
                                        <th>tool</th>
                                        <th>category</th>
                                        <th>description</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {col.map((t) => (
                                        <tr key={t.name}>
                                            <td className="tool">{t.name}</td>
                                            <td className="cat">{t.category}</td>
                                            <td className="desc">{t.description}</td>
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
