import { FileText, Globe, FileCode, Video, BookOpen } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';

const sourceTypeIcons: Record<string, React.ComponentType<{ className?: string }>> = {
    url: Globe,
    pdf: FileCode,
    youtube: Video,
    arxiv: BookOpen,
    file: FileText,
    folder: FileText,
};

export default function SourcesPage() {
    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold tracking-tight">Sources</h1>
                <p className="text-muted-foreground mt-1 text-sm">
                    All ingested sources in your knowledge base.
                </p>
            </div>

            <Card>
                <CardContent className="p-0">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Title</TableHead>
                                <TableHead>Type</TableHead>
                                <TableHead className="text-right">Words</TableHead>
                                <TableHead className="text-right">Added</TableHead>
                                <TableHead className="text-right">Compiled</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            <TableRow>
                                <TableCell
                                    colSpan={5}
                                    className="text-muted-foreground py-8 text-center"
                                >
                                    <div className="flex flex-col items-center gap-2">
                                        <FileText className="text-muted-foreground/40 h-8 w-8" />
                                        <p className="text-sm">No sources yet</p>
                                        <p className="text-xs">
                                            Run{' '}
                                            <code className="bg-muted rounded px-1.5 py-0.5 font-mono">
                                                lumen add &lt;url&gt;
                                            </code>{' '}
                                            to ingest your first source.
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

export function SourceRow({
    title,
    type,
    wordCount,
    addedAt,
    compiled,
}: {
    title: string;
    type: string;
    wordCount: number;
    addedAt: string;
    compiled: boolean;
}) {
    const Icon = sourceTypeIcons[type] ?? FileText;

    return (
        <TableRow>
            <TableCell className="max-w-xs truncate font-medium">{title}</TableCell>
            <TableCell>
                <Badge variant="outline" className="gap-1">
                    <Icon className="h-3 w-3" />
                    {type}
                </Badge>
            </TableCell>
            <TableCell className="text-right">{wordCount.toLocaleString()}</TableCell>
            <TableCell className="text-muted-foreground text-right text-xs">
                {new Date(addedAt).toLocaleDateString()}
            </TableCell>
            <TableCell className="text-right">
                <Badge variant={compiled ? 'default' : 'secondary'} className="text-xs">
                    {compiled ? 'Yes' : 'Pending'}
                </Badge>
            </TableCell>
        </TableRow>
    );
}
