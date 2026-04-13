'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { signUp } from '@/lib/auth-client';
import { signUpSchema } from '@/lib/schemas';

export default function SignupPage() {
    const router = useRouter();
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        setError(null);
        setLoading(true);

        const formData = new FormData(e.currentTarget);
        const parsed = signUpSchema.safeParse({
            name: formData.get('name'),
            email: formData.get('email'),
            password: formData.get('password'),
        });

        if (!parsed.success) {
            setError(parsed.error.issues[0]?.message ?? 'Invalid input');
            setLoading(false);
            return;
        }

        const { error: authError } = await signUp.email({
            name: parsed.data.name,
            email: parsed.data.email,
            password: parsed.data.password,
        });

        if (authError) {
            setError(authError.message ?? 'Sign up failed');
            setLoading(false);
            return;
        }

        router.push('/dashboard');
        router.refresh();
    }

    return (
        <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
            <h1 className="mb-2 text-3xl font-bold">Create account</h1>
            <p className="mb-8 text-sm text-neutral-600 dark:text-neutral-400">
                Start building your knowledge graph.
            </p>

            <form onSubmit={onSubmit} className="space-y-4">
                <div>
                    <label htmlFor="name" className="mb-1 block text-sm font-medium">
                        Name
                    </label>
                    <input
                        id="name"
                        name="name"
                        type="text"
                        autoComplete="name"
                        required
                        className="w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none dark:border-neutral-700 dark:focus:border-neutral-100"
                    />
                </div>
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
                        autoComplete="new-password"
                        required
                        minLength={8}
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
                    {loading ? 'Creating account…' : 'Create account'}
                </button>
            </form>

            <p className="mt-6 text-center text-sm text-neutral-600 dark:text-neutral-400">
                Already have an account?{' '}
                <Link
                    href="/login"
                    className="underline hover:text-neutral-900 dark:hover:text-white"
                >
                    Sign in
                </Link>
            </p>
        </main>
    );
}
