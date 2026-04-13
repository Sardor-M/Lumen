'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { signIn } from '@/lib/auth-client';
import { signInSchema } from '@/lib/schemas';

export default function LoginPage() {
    const router = useRouter();
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        setError(null);
        setLoading(true);

        const formData = new FormData(e.currentTarget);
        const parsed = signInSchema.safeParse({
            email: formData.get('email'),
            password: formData.get('password'),
        });

        if (!parsed.success) {
            setError(parsed.error.issues[0]?.message ?? 'Invalid input');
            setLoading(false);
            return;
        }

        const { error: authError } = await signIn.email({
            email: parsed.data.email,
            password: parsed.data.password,
        });

        if (authError) {
            setError(authError.message ?? 'Sign in failed');
            setLoading(false);
            return;
        }

        router.push('/dashboard');
        router.refresh();
    }

    return (
        <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
            <h1 className="mb-2 text-3xl font-bold">Sign in</h1>
            <p className="mb-8 text-sm text-neutral-600 dark:text-neutral-400">
                Welcome back to Lumen.
            </p>

            <form onSubmit={onSubmit} className="space-y-4">
                <div>
                    <label htmlFor="email" className="mb-1 block text-sm font-medium">
                        Email
                    </label>
                    <input
                        id="email"
                        name="email"
                        type="email"
                        autoComplete="email"
                        required
                        className="w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none dark:border-neutral-700 dark:focus:border-neutral-100"
                    />
                </div>
                <div>
                    <label htmlFor="password" className="mb-1 block text-sm font-medium">
                        Password
                    </label>
                    <input
                        id="password"
                        name="password"
                        type="password"
                        autoComplete="current-password"
                        required
                        className="w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none dark:border-neutral-700 dark:focus:border-neutral-100"
                    />
                </div>

                {error && (
                    <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-900 dark:bg-red-950 dark:text-red-200">
                        {error}
                    </p>
                )}

                <button
                    type="submit"
                    disabled={loading}
                    className="w-full rounded-lg bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
                >
                    {loading ? 'Signing in…' : 'Sign in'}
                </button>
            </form>

            <p className="mt-6 text-center text-sm text-neutral-600 dark:text-neutral-400">
                No account?{' '}
                <Link
                    href="/signup"
                    className="underline hover:text-neutral-900 dark:hover:text-white"
                >
                    Sign up
                </Link>
            </p>
        </main>
    );
}
