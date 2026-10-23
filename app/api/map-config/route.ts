import { NextResponse } from 'next/server';
import { publicMapConfig } from '@/lib/server-config';
export const dynamic = 'force-dynamic';
export function GET() {
    try { return NextResponse.json(publicMapConfig(), {headers:{'Cache-Control':'no-store'}}); }
    catch { return NextResponse.json({error:'지도를 불러오지 못했습니다.'},{status:503,headers:{'Cache-Control':'no-store'}}); }
}
