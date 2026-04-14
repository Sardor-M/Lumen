import { NextResponse } from 'next/server';
import { route } from '@/lib/api';
import { profile } from '@/lib/lumen';

export const dynamic = 'force-dynamic';

export const GET = route(() => {
    const data = profile();
    if (!data) return NextResponse.json({ initialized: false });
    return NextResponse.json(data);
});
