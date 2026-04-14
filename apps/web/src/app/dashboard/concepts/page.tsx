import { Boxes } from 'lucide-react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { concepts } from '@/lib/lumen';

export default function ConceptsPage() {
    const list = concepts().sort((a, b) => b.mention_count - a.mention_count);

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold tracking-tight">Concepts</h1>
                <p className="text-muted-foreground mt-1 text-sm">
                    {list.length === 0
                        ? 'All concepts extracted from your sources.'
                        : `${list.length} concepts extracted from your sources.`}
                </p>
            </div>

            <Card>
                <CardContent className="p-0">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Name</TableHead>
                                <TableHead>Slug</TableHead>
                                <TableHead className="text-right">Mentions</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {list.length === 0 ? (
                                <TableRow>
                                    <TableCell
                                        colSpan={3}
                                        className="text-muted-foreground py-8 text-center"
                                    >
                                        <div className="flex flex-col items-center gap-2">
                                            <Boxes className="text-muted-foreground/40 h-8 w-8" />
                                            <p className="text-sm">No concepts yet</p>
                                            <p className="text-xs">
                                                Run{' '}
                                                <code className="bg-muted rounded px-1.5 py-0.5 font-mono">
                                                    lumen compile
                                                </code>{' '}
                                                to extract concepts from your sources.
                                            </p>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ) : (
                                list.map((c) => (
                                    <TableRow key={c.slug}>
                                        <TableCell>
                                            <Link
                                                href={`/dashboard/concepts/${c.slug}`}
                                                className="font-medium hover:underline"
                                            >
                                                {c.name}
                                            </Link>
                                        </TableCell>
                                        <TableCell>
                                            <Badge variant="outline" className="font-mono text-xs">
                                                {c.slug}
                                            </Badge>
                                        </TableCell>
                                        <TableCell className="text-right">
                                            {c.mention_count}
                                        </TableCell>
                                    </TableRow>
                                ))
                            )}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    );
}
