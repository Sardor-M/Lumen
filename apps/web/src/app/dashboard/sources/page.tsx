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
import { sources } from '@/lib/lumen';

const sourceTypeIcons: Record<string, React.ComponentType<{ className?: string }>> = {
    url: Globe,
    pdf: FileCode,
    youtube: Video,
    arxiv: BookOpen,
    file: FileText,
    folder: FileText,
};

export default function SourcesPage() {
    const list = sources().sort((a, b) => b.added_at.localeCompare(a.added_at));

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold tracking-tight">Sources</h1>
                <p className="text-muted-foreground mt-1 text-sm">
                    {list.length === 0
                        ? 'All ingested sources in your knowledge base.'
                        : `${list.length} ingested sources in your knowledge base.`}
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
                            {list.length === 0 ? (
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
                            ) : (
                                list.map((s) => {
                                    const Icon = sourceTypeIcons[s.source_type] ?? FileText;
                                    return (
                                        <TableRow key={s.id}>
                                            <TableCell className="max-w-xs truncate font-medium">
                                                {s.title}
                                            </TableCell>
                                            <TableCell>
                                                <Badge variant="outline" className="gap-1">
                                                    <Icon className="h-3 w-3" />
                                                    {s.source_type}
                                                </Badge>
                                            </TableCell>
                                            <TableCell className="text-right">
                                                {s.word_count.toLocaleString()}
                                            </TableCell>
                                            <TableCell className="text-muted-foreground text-right text-xs">
                                                {new Date(s.added_at).toLocaleDateString()}
                                            </TableCell>
                                            <TableCell className="text-right">
                                                <Badge
                                                    variant={
                                                        s.compiled_at ? 'default' : 'secondary'
                                                    }
                                                    className="text-xs"
                                                >
                                                    {s.compiled_at ? 'Yes' : 'Pending'}
                                                </Badge>
                                            </TableCell>
                                        </TableRow>
                                    );
                                })
                            )}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    );
}
