import { NextResponse } from 'next/server';
import { search, geocode } from '@/lib/providers';
import { findJourney } from '@/lib/journey';
import { routingConfig } from '@/lib/server-config';
import { requestSchema } from '@/lib/requests';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
    try {
        const origin = request.headers.get('origin');
        if (origin && origin !== new URL(request.url).origin)
            return NextResponse.json({ error: '요청을 처리할 수 없습니다.' }, { status: 403 });
        if (Number(request.headers.get('content-length')) > 20000)
            return NextResponse.json({ error: '입력값을 확인해 주세요.' }, { status: 413 });
        const text = await request.text();
        if (text.length > 20000)
            return NextResponse.json({ error: '입력값을 확인해 주세요.' }, { status: 413 });
        let body;
        try {
            body = requestSchema.parse(JSON.parse(text));
        }
        catch {
            return NextResponse.json({ error: '입력값을 확인해 주세요.' }, { status: 400 });
        }
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(85000)]);
        const data = body.action === 'search' ? { places: await (body.address ? geocode : search)(body.query, routingConfig(), signal) } : await findJourney(body.start, body.end, body.profile, signal);
        return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
    }
    catch (error) {
        console.warn('Journey request failed', error instanceof Error ? error.name : 'UnknownError');
        return NextResponse.json({ error: '길찾기 서비스를 잠시 이용할 수 없습니다. 잠시 후 다시 시도해 주세요.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
}
