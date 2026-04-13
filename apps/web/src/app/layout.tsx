import type { Metadata } from 'next';
import './globals.css';
import { Geist, Geist_Mono } from 'next/font/google';
import { cn } from '@/lib/utils';
import { TooltipProvider } from '@/components/ui/tooltip';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
    title: 'Lumen — Knowledge Compiler',
    description: 'Local-first knowledge graph from your reading.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html
            lang="en"
            suppressHydrationWarning
            className={cn('font-sans', geist.variable, geistMono.variable)}
        >
            <body className="bg-background text-foreground min-h-screen antialiased">
                <TooltipProvider delayDuration={0}>{children}</TooltipProvider>
            </body>
        </html>
    );
}
