import { GitFork, Network } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export default function GraphPage() {
    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold tracking-tight">Graph</h1>
                <p className="text-muted-foreground mt-1 text-sm">
                    Interactive knowledge graph visualization.
                </p>
            </div>

            <Card className="border-dashed">
                <CardContent className="flex flex-col items-center justify-center py-16">
                    <Network className="text-muted-foreground/30 mb-4 h-12 w-12" />
                    <h2 className="text-lg font-semibold">Graph visualization</h2>
                    <p className="text-muted-foreground mt-1 max-w-sm text-center text-sm">
                        Force-directed graph rendering will appear here once concepts and edges are
                        compiled from your sources.
                    </p>
                    <div className="mt-4 flex gap-2">
                        <Badge variant="outline">D3.js</Badge>
                        <Badge variant="outline">Force-directed</Badge>
                        <Badge variant="outline">Interactive</Badge>
                    </div>
                </CardContent>
            </Card>

            <div className="grid gap-4 sm:grid-cols-3">
                <Card>
                    <CardHeader className="flex flex-row items-center gap-2 pb-2">
                        <GitFork className="text-muted-foreground h-4 w-4" />
                        <CardTitle className="text-sm font-medium">God Nodes</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-muted-foreground text-sm">
                            Most connected concepts in your graph.
                        </p>
                        <p className="mt-2 text-2xl font-bold">—</p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="flex flex-row items-center gap-2 pb-2">
                        <Network className="text-muted-foreground h-4 w-4" />
                        <CardTitle className="text-sm font-medium">Communities</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-muted-foreground text-sm">
                            Topic clusters detected by label propagation.
                        </p>
                        <p className="mt-2 text-2xl font-bold">—</p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="flex flex-row items-center gap-2 pb-2">
                        <GitFork className="text-muted-foreground h-4 w-4 rotate-180" />
                        <CardTitle className="text-sm font-medium">PageRank Top</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-muted-foreground text-sm">
                            Concepts ranked by structural importance.
                        </p>
                        <p className="mt-2 text-2xl font-bold">—</p>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
