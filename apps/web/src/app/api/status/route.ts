import { NextResponse } from 'next/server';
import { route } from '@/lib/api';
import { status } from '@/lib/lumen';

export const dynamic = 'force-dynamic';

export const GET = route(() => NextResponse.json(status()));
