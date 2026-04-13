import { Boxes } from 'lucide-react';
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

export default function ConceptsPage() {
    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold tracking-tight">Concepts</h1>
                <p className="text-muted-foreground mt-1 text-sm">
                    All concepts extracted from your sources.
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
                                <TableHead className="text-right">Sources</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            <TableRow>
                                <TableCell
                                    colSpan={4}
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
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    );
}

export function ConceptRow({
    name,
    slug,
    mentions,
    sourceCount,
}: {
    name: string;
    slug: string;
    mentions: number;
    sourceCount: number;
}) {
    return (
        <TableRow>
            <TableCell>
                <a href={`/dashboard/concepts/${slug}`} className="font-medium hover:underline">
                    {name}
                </a>
            </TableCell>
            <TableCell>
                <Badge variant="outline" className="font-mono text-xs">
                    {slug}
                </Badge>
            </TableCell>
            <TableCell className="text-right">{mentions}</TableCell>
            <TableCell className="text-right">{sourceCount}</TableCell>
        </TableRow>
    );
}
