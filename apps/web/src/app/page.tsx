import Link from 'next/link';
import { Sparkles, Search, Boxes, GitFork, FileText, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function Home() {
    return (
        <main className="mx-auto max-w-3xl px-6 py-24">
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <Sparkles className="h-4 w-4" />
                <span>Local-first knowledge compiler</span>
            </div>

            <h1 className="mt-4 text-5xl font-bold tracking-tight">Lumen</h1>
            <p className="text-muted-foreground mt-4 text-xl">
                Turn your reading into a knowledge graph. Locally.
            </p>

            <div className="mt-8 flex gap-3">
                <Button size="lg" render={<Link href="/dashboard" />}>
                    Open dashboard
                </Button>
                <Button variant="outline" size="lg" render={<Link href="/login" />}>
                    Sign in
                </Button>
            </div>

            <div className="mt-16 grid gap-6 sm:grid-cols-2">
                <Feature
                    icon={Search}
                    title="Hybrid search"
                    description="BM25 + TF-IDF with reciprocal rank fusion. Finds what grep can't."
                />
                <Feature
                    icon={Boxes}
                    title="Concept extraction"
                    description="LLM compiles your reading into structured concepts and relations."
                />
                <Feature
                    icon={GitFork}
                    title="Knowledge graph"
                    description="PageRank, communities, shortest paths. See the structure of your reading."
                />
                <Feature
                    icon={FileText}
                    title="Multi-format ingest"
                    description="URLs, PDFs, arXiv papers, YouTube videos, local files and folders."
                />
                <Feature
                    icon={Shield}
                    title="100% local"
                    description="SQLite on your machine. Nothing leaves your laptop. Ever."
                />
                <Feature
                    icon={Sparkles}
                    title="MCP server"
                    description="Works with Claude Code, Cursor, and any MCP-compatible AI assistant."
                />
            </div>
        </main>
    );
}

function Feature({
    icon: Icon,
    title,
    description,
}: {
    icon: React.ComponentType<{ className?: string }>;
    title: string;
    description: string;
}) {
    return (
        <div className="rounded-lg border p-4">
            <Icon className="text-muted-foreground mb-2 h-5 w-5" />
            <h3 className="font-medium">{title}</h3>
            <p className="text-muted-foreground mt-1 text-sm">{description}</p>
        </div>
    );
}
