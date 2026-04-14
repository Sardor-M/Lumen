import { NextResponse } from 'next/server';
import { route } from '@/lib/api';
import { searchQuerySchema } from '@/lib/schemas';
import { hybridSearch } from '@/lib/lumen';

export const dynamic = 'force-dynamic';

export const GET = route({ query: searchQuerySchema }, ({ query }) => {
    const results = hybridSearch(query.q, query.limit);
    return NextResponse.json({ query: query.q, results });
});
