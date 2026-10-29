import { NextResponse } from 'next/server';
import { publicMapConfig } from '@/lib/server-config';
export const dynamic = 'force-dynamic';
export function GET() {
    try { return NextResponse.json(publicMapConfig(), {headers:{'Cache-Control':'no-store'}}); }
    catch { return NextResponse.json({error:'네이버 지도 설정을 확인해 주세요. NAVER_MAP_CLIENT_ID가 필요합니다.'},{status:503,headers:{'Cache-Control':'no-store'}}); }
}
