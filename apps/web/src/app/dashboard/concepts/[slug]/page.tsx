import { ArrowLeft, ArrowRight, ArrowLeftRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import Link from 'next/link';

export default async function ConceptDetailPage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-3">
                <Button variant="ghost" size="icon" render={<Link href="/dashboard/concepts" />}>
                    <ArrowLeft className="h-4 w-4" />
                </Button>
                <div>
                    <h1 className="text-2xl font-bold tracking-tight capitalize">
                        {slug.replace(/-/g, ' ')}
                    </h1>
                    <Badge variant="outline" className="mt-1 font-mono text-xs">
                        {slug}
                    </Badge>
                </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                    <CardHeader>
                        <CardTitle className="text-sm font-medium">Summary</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-muted-foreground text-sm">
                            No summary available. Run{' '}
                            <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
                                lumen compile
                            </code>{' '}
                            to generate.
                        </p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle className="text-sm font-medium">Stats</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <dl className="grid grid-cols-2 gap-4 text-sm">
                            <div>
                                <dt className="text-muted-foreground">Mentions</dt>
                                <dd className="text-lg font-semibold">—</dd>
                            </div>
                            <div>
                                <dt className="text-muted-foreground">Sources</dt>
                                <dd className="text-lg font-semibold">—</dd>
                            </div>
                            <div>
                                <dt className="text-muted-foreground">Outgoing edges</dt>
                                <dd className="text-lg font-semibold">—</dd>
                            </div>
                            <div>
                                <dt className="text-muted-foreground">Incoming edges</dt>
                                <dd className="text-lg font-semibold">—</dd>
                            </div>
                        </dl>
                    </CardContent>
                </Card>
            </div>

            <Separator />

            <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                    <CardHeader className="flex flex-row items-center gap-2">
                        <ArrowRight className="text-muted-foreground h-4 w-4" />
                        <CardTitle className="text-sm font-medium">Outgoing edges</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-muted-foreground text-sm">No outgoing edges.</p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="flex flex-row items-center gap-2">
                        <ArrowLeftRight className="text-muted-foreground h-4 w-4" />
                        <CardTitle className="text-sm font-medium">Incoming edges</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-muted-foreground text-sm">No incoming edges.</p>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
