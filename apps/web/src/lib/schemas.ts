import { z } from 'zod';

export const signInSchema = z.object({
    email: z.string().email('Invalid email'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
});

export const signUpSchema = z.object({
    name: z.string().min(1, 'Name is required'),
    email: z.string().email('Invalid email'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
});

export const searchSchema = z.object({
    query: z.string().min(1, 'Query is required'),
    limit: z.number().int().positive().max(100).optional().default(10),
});

export type SignInInput = z.infer<typeof signInSchema>;
export type SignUpInput = z.infer<typeof signUpSchema>;
export type SearchInput = z.infer<typeof searchSchema>;
