import { NextResponse } from 'next/server';
import { route } from '@/lib/api';
import { graphQuerySchema } from '@/lib/schemas';
import { graphSnapshot } from '@/lib/lumen';

export const dynamic = 'force-dynamic';

export const GET = route({ query: graphQuerySchema }, ({ query }) =>
    NextResponse.json(graphSnapshot({ limit: query.limit })),
);
