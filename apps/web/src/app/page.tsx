import Link from 'next/link';

export default function Home() {
    return (
        <main className="mx-auto max-w-3xl px-6 py-24">
            <h1 className="mb-4 text-5xl font-bold tracking-tight">Lumen</h1>
            <p className="mb-8 text-xl text-neutral-600 dark:text-neutral-400">
                Turn your reading into a knowledge graph. Locally.
            </p>
            <div className="flex gap-4">
                <Link
                    href="/dashboard"
                    className="rounded-lg bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
                >
                    Open dashboard
                </Link>
                <Link
                    href="/login"
                    className="rounded-lg border border-neutral-300 px-5 py-2.5 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
                >
                    Sign in
                </Link>
            </div>
        </main>
    );
}
