import { NextResponse } from 'next/server';
import { jsonError, route } from '@/lib/api';
import { conceptParamsSchema } from '@/lib/schemas';
import { concept } from '@/lib/lumen';

export const dynamic = 'force-dynamic';

export const GET = route({ params: conceptParamsSchema }, ({ params }) => {
    const data = concept(params.slug);
    if (!data) return jsonError('Concept not found', 404);
    return NextResponse.json(data);
});
