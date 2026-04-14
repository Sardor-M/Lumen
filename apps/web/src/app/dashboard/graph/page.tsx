import Link from 'next/link';
import { GitFork, Network } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { graphSnapshot } from '@/lib/lumen';

export default function GraphPage() {
    const snapshot = graphSnapshot({ limit: 200 });
    const hasGraph = snapshot.nodes.length > 0;

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold tracking-tight">Graph</h1>
                <p className="text-muted-foreground mt-1 text-sm">
                    {hasGraph
                        ? `${snapshot.nodes.length} concepts · ${snapshot.edges.length} edges · ${snapshot.communities.length} communities`
                        : 'Interactive knowledge graph visualization.'}
                </p>
            </div>

            {!hasGraph && (
                <Card className="border-dashed">
                    <CardContent className="flex flex-col items-center justify-center py-16">
                        <Network className="text-muted-foreground/30 mb-4 h-12 w-12" />
                        <h2 className="text-lg font-semibold">Graph visualization</h2>
                        <p className="text-muted-foreground mt-1 max-w-sm text-center text-sm">
                            Force-directed graph rendering will appear here once concepts and edges
                            are compiled from your sources.
                        </p>
                        <div className="mt-4 flex gap-2">
                            <Badge variant="outline">D3.js</Badge>
                            <Badge variant="outline">Force-directed</Badge>
                            <Badge variant="outline">Interactive</Badge>
                        </div>
                    </CardContent>
                </Card>
            )}

            <div className="grid gap-4 sm:grid-cols-3">
                <Card>
                    <CardHeader className="flex flex-row items-center gap-2 pb-2">
                        <GitFork className="text-muted-foreground h-4 w-4" />
                        <CardTitle className="text-sm font-medium">God Nodes</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="mt-2 text-2xl font-bold">{snapshot.god_nodes.length}</p>
                        <ul className="mt-3 space-y-1 text-sm">
                            {snapshot.god_nodes.slice(0, 5).map((g) => (
                                <li
                                    key={g.slug}
                                    className="flex items-center justify-between gap-2"
                                >
                                    <Link
                                        href={`/dashboard/concepts/${g.slug}`}
                                        className="truncate hover:underline"
                                    >
                                        {g.name}
                                    </Link>
                                    <Badge variant="outline" className="font-mono text-xs">
                                        {g.edgeCount}
                                    </Badge>
                                </li>
                            ))}
                        </ul>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="flex flex-row items-center gap-2 pb-2">
                        <Network className="text-muted-foreground h-4 w-4" />
                        <CardTitle className="text-sm font-medium">Communities</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="mt-2 text-2xl font-bold">{snapshot.communities.length}</p>
                        <ul className="mt-3 space-y-1 text-sm">
                            {snapshot.communities.slice(0, 5).map((c) => (
                                <li
                                    key={c.id}
                                    className="text-muted-foreground flex items-center justify-between gap-2 truncate"
                                >
                                    <span className="truncate">
                                        {c.members.slice(0, 3).join(', ')}
                                    </span>
                                    <Badge variant="outline" className="font-mono text-xs">
                                        {c.size}
                                    </Badge>
                                </li>
                            ))}
                        </ul>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="flex flex-row items-center gap-2 pb-2">
                        <GitFork className="text-muted-foreground h-4 w-4 rotate-180" />
                        <CardTitle className="text-sm font-medium">Top concepts</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="mt-2 text-2xl font-bold">{snapshot.nodes.length}</p>
                        <ul className="mt-3 space-y-1 text-sm">
                            {[...snapshot.nodes]
                                .sort((a, b) => b.mentions - a.mentions)
                                .slice(0, 5)
                                .map((n) => (
                                    <li
                                        key={n.slug}
                                        className="flex items-center justify-between gap-2"
                                    >
                                        <Link
                                            href={`/dashboard/concepts/${n.slug}`}
                                            className="truncate hover:underline"
                                        >
                                            {n.name}
                                        </Link>
                                        <Badge variant="outline" className="font-mono text-xs">
                                            {n.mentions}
                                        </Badge>
                                    </li>
                                ))}
                        </ul>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
