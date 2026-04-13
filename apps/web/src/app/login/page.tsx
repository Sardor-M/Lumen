'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import { signIn } from '@/lib/auth-client';
import { signInSchema } from '@/lib/schemas';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

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
        <main className="flex min-h-screen items-center justify-center px-4">
            <Card className="w-full max-w-sm">
                <CardHeader className="text-center">
                    <div className="bg-primary text-primary-foreground mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-lg">
                        <Sparkles className="h-5 w-5" />
                    </div>
                    <CardTitle className="text-xl">Sign in to Lumen</CardTitle>
                    <CardDescription>Welcome back.</CardDescription>
                </CardHeader>
                <CardContent>
                    <form onSubmit={onSubmit} className="space-y-4">
                        <div className="space-y-2">
                            <label htmlFor="email" className="text-sm font-medium">
                                Email
                            </label>
                            <Input
                                id="email"
                                name="email"
                                type="email"
                                autoComplete="email"
                                required
                                placeholder="you@example.com"
                            />
                        </div>
                        <div className="space-y-2">
                            <label htmlFor="password" className="text-sm font-medium">
                                Password
                            </label>
                            <Input
                                id="password"
                                name="password"
                                type="password"
                                autoComplete="current-password"
                                required
                            />
                        </div>

                        {error && (
                            <p className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-sm">
                                {error}
                            </p>
                        )}

                        <Button type="submit" className="w-full" disabled={loading}>
                            {loading ? 'Signing in…' : 'Sign in'}
                        </Button>
                    </form>

                    <p className="text-muted-foreground mt-4 text-center text-sm">
                        No account?{' '}
                        <Link
                            href="/signup"
                            className="text-foreground underline hover:no-underline"
                        >
                            Sign up
                        </Link>
                    </p>
                </CardContent>
            </Card>
        </main>
    );
}
