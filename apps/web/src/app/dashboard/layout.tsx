import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { AppSidebar } from '@/components/app-sidebar';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) redirect('/login');

    return (
        <SidebarProvider>
            <AppSidebar session={session} />
            <SidebarInset>
                <header className="flex h-14 items-center gap-2 border-b px-6">
                    <SidebarTrigger className="-ml-2" />
                    <Separator orientation="vertical" className="h-4" />
                    <span className="text-muted-foreground text-sm">Knowledge Base</span>
                </header>
                <main className="flex-1 px-6 py-6">{children}</main>
            </SidebarInset>
        </SidebarProvider>
    );
}
