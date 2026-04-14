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

/**
 * Query-string validators for GET API routes. All fields are strings coming
 * out of `URLSearchParams`; Zod coerces where appropriate.
 */
export const searchQuerySchema = z.object({
    q: z.string().trim().min(1).max(500),
    limit: z.coerce.number().int().positive().max(100).optional().default(20),
});

export const graphQuerySchema = z.object({
    limit: z.coerce.number().int().min(10).max(2000).optional().default(500),
});

export const conceptSlugSchema = z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9-]+$/, 'Invalid concept slug');

export const conceptParamsSchema = z.object({ slug: conceptSlugSchema });

export type SignInInput = z.infer<typeof signInSchema>;
export type SignUpInput = z.infer<typeof signUpSchema>;
export type SearchInput = z.infer<typeof searchSchema>;
