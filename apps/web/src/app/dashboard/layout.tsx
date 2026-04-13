import Link from 'next/link';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) redirect('/login');

    return (
        <div className="flex min-h-screen">
            <aside className="w-56 border-r border-neutral-200 p-6 dark:border-neutral-800">
                <Link href="/" className="mb-8 block text-xl font-bold">
                    Lumen
                </Link>
                <nav className="space-y-1 text-sm">
                    <NavLink href="/dashboard">Overview</NavLink>
                    <NavLink href="/dashboard/search">Search</NavLink>
                    <NavLink href="/dashboard/concepts">Concepts</NavLink>
                    <NavLink href="/dashboard/graph">Graph</NavLink>
                    <NavLink href="/dashboard/sources">Sources</NavLink>
                </nav>
                <div className="mt-8 border-t border-neutral-200 pt-4 text-xs dark:border-neutral-800">
                    <p className="truncate text-neutral-600 dark:text-neutral-400">
                        {session.user.email}
                    </p>
                    <form action="/api/auth/sign-out" method="post" className="mt-2">
                        <button
                            type="submit"
                            className="text-neutral-600 underline hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white"
                        >
                            Sign out
                        </button>
                    </form>
                </div>
            </aside>
            <div className="flex-1 px-8 py-6">{children}</div>
        </div>
    );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
    return (
        <Link
            href={href}
            className="block rounded px-2 py-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-900"
        >
            {children}
        </Link>
    );
}
