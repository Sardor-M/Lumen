import { ArrowLeft, ArrowRight, ArrowLeftRight } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { concept } from '@/lib/lumen';

export default async function ConceptDetailPage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const c = concept(slug);
    if (!c) notFound();

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-3">
                <Button variant="ghost" size="icon" render={<Link href="/dashboard/concepts" />}>
                    <ArrowLeft className="h-4 w-4" />
                </Button>
                <div>
                    <h1 className="text-2xl font-bold tracking-tight">{c.name}</h1>
                    <Badge variant="outline" className="mt-1 font-mono text-xs">
                        {c.slug}
                    </Badge>
                </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                    <CardHeader>
                        <CardTitle className="text-sm font-medium">Summary</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {c.summary ? (
                            <p className="text-sm">{c.summary}</p>
                        ) : (
                            <p className="text-muted-foreground text-sm">
                                No summary available. Run{' '}
                                <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
                                    lumen compile
                                </code>{' '}
                                to generate.
                            </p>
                        )}
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
                                <dd className="text-lg font-semibold">{c.mention_count}</dd>
                            </div>
                            <div>
                                <dt className="text-muted-foreground">Neighbors</dt>
                                <dd className="text-lg font-semibold">
                                    {c.neighborhood.nodes.size}
                                </dd>
                            </div>
                            <div>
                                <dt className="text-muted-foreground">Outgoing edges</dt>
                                <dd className="text-lg font-semibold">{c.outgoing.length}</dd>
                            </div>
                            <div>
                                <dt className="text-muted-foreground">Incoming edges</dt>
                                <dd className="text-lg font-semibold">{c.incoming.length}</dd>
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
                        {c.outgoing.length === 0 ? (
                            <p className="text-muted-foreground text-sm">No outgoing edges.</p>
                        ) : (
                            <ul className="space-y-2 text-sm">
                                {c.outgoing.map((e) => (
                                    <li
                                        key={`${e.from_slug}-${e.to_slug}-${e.relation}`}
                                        className="flex items-center justify-between gap-2"
                                    >
                                        <Link
                                            href={`/dashboard/concepts/${e.to_slug}`}
                                            className="truncate hover:underline"
                                        >
                                            {e.to_slug}
                                        </Link>
                                        <Badge variant="secondary" className="font-mono text-xs">
                                            {e.relation}
                                        </Badge>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="flex flex-row items-center gap-2">
                        <ArrowLeftRight className="text-muted-foreground h-4 w-4" />
                        <CardTitle className="text-sm font-medium">Incoming edges</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {c.incoming.length === 0 ? (
                            <p className="text-muted-foreground text-sm">No incoming edges.</p>
                        ) : (
                            <ul className="space-y-2 text-sm">
                                {c.incoming.map((e) => (
                                    <li
                                        key={`${e.from_slug}-${e.to_slug}-${e.relation}`}
                                        className="flex items-center justify-between gap-2"
                                    >
                                        <Link
                                            href={`/dashboard/concepts/${e.from_slug}`}
                                            className="truncate hover:underline"
                                        >
                                            {e.from_slug}
                                        </Link>
                                        <Badge variant="secondary" className="font-mono text-xs">
                                            {e.relation}
                                        </Badge>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
