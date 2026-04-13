import { FileText, Layers, Boxes, GitFork, Database, BarChart3 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export default function DashboardPage() {
    return (
        <div className="space-y-8">
            <div>
                <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
                <p className="text-muted-foreground mt-1 text-sm">
                    Your knowledge graph at a glance.
                </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <StatCard
                    icon={FileText}
                    label="Sources"
                    value="—"
                    description="Articles ingested"
                />
                <StatCard icon={Layers} label="Chunks" value="—" description="Text segments" />
                <StatCard icon={Boxes} label="Concepts" value="—" description="Extracted nodes" />
                <StatCard icon={GitFork} label="Edges" value="—" description="Relationships" />
                <StatCard icon={Database} label="Tokens" value="—" description="Total indexed" />
                <StatCard
                    icon={BarChart3}
                    label="Graph Density"
                    value="—"
                    description="Connectivity"
                />
            </div>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Getting started</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="text-muted-foreground space-y-3 text-sm">
                        <Step n={1} done>
                            Install Lumen CLI and initialize workspace
                        </Step>
                        <Step n={2}>
                            Ingest sources:{' '}
                            <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
                                lumen add &lt;url&gt;
                            </code>
                        </Step>
                        <Step n={3}>
                            Compile knowledge graph:{' '}
                            <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
                                lumen compile
                            </code>
                        </Step>
                        <Step n={4}>Explore concepts and search from this dashboard</Step>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}

function StatCard({
    icon: Icon,
    label,
    value,
    description,
}: {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    value: string;
    description: string;
}) {
    return (
        <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">{label}</CardTitle>
                <Icon className="text-muted-foreground h-4 w-4" />
            </CardHeader>
            <CardContent>
                <div className="text-2xl font-bold">{value}</div>
                <p className="text-muted-foreground text-xs">{description}</p>
            </CardContent>
        </Card>
    );
}

function Step({ n, done, children }: { n: number; done?: boolean; children: React.ReactNode }) {
    return (
        <div className="flex items-start gap-3">
            <Badge
                variant={done ? 'default' : 'outline'}
                className="mt-0.5 h-5 w-5 shrink-0 justify-center rounded-full p-0 text-[10px]"
            >
                {n}
            </Badge>
            <span className={done ? 'line-through opacity-50' : ''}>{children}</span>
        </div>
    );
}
