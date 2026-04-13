'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import { signUp } from '@/lib/auth-client';
import { signUpSchema } from '@/lib/schemas';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

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
        <main className="flex min-h-screen items-center justify-center px-4">
            <Card className="w-full max-w-sm">
                <CardHeader className="text-center">
                    <div className="bg-primary text-primary-foreground mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-lg">
                        <Sparkles className="h-5 w-5" />
                    </div>
                    <CardTitle className="text-xl">Create your account</CardTitle>
                    <CardDescription>Start building your knowledge graph.</CardDescription>
                </CardHeader>
                <CardContent>
                    <form onSubmit={onSubmit} className="space-y-4">
                        <div className="space-y-2">
                            <label htmlFor="name" className="text-sm font-medium">
                                Name
                            </label>
                            <Input
                                id="name"
                                name="name"
                                type="text"
                                autoComplete="name"
                                required
                                placeholder="Your name"
                            />
                        </div>
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
                                autoComplete="new-password"
                                required
                                minLength={8}
                                placeholder="8+ characters"
                            />
                        </div>

                        {error && (
                            <p className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-sm">
                                {error}
                            </p>
                        )}

                        <Button type="submit" className="w-full" disabled={loading}>
                            {loading ? 'Creating account…' : 'Create account'}
                        </Button>
                    </form>

                    <p className="text-muted-foreground mt-4 text-center text-sm">
                        Already have an account?{' '}
                        <Link
                            href="/login"
                            className="text-foreground underline hover:no-underline"
                        >
                            Sign in
                        </Link>
                    </p>
                </CardContent>
            </Card>
        </main>
    );
}
