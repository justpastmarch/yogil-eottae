import { NextResponse } from 'next/server';
import { search, geocode } from '@/lib/providers';
import { startJourney, advanceJourney, cancelJourney } from '@/lib/journey-jobs';
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
        if (body.action === 'search') return NextResponse.json({places: await (body.address ? geocode : search)(body.query, routingConfig(), signal)}, {headers:{'Cache-Control':'no-store'}});
        const userId = request.headers.get('oai-authenticated-user-id');
        const local = import.meta.env.DEV && ['localhost','127.0.0.1'].includes(new URL(request.url).hostname);
        const ownerId = userId || (local ? 'local-preview-owner' : null);
        if (!ownerId) return NextResponse.json({error:'로그인 후 길찾기를 이용해 주세요.'},{status:401,headers:{'Cache-Control':'no-store'}});
        const data = body.action === 'journey' ? await startJourney(body, ownerId, signal)
            : body.action === 'advance' ? await advanceJourney(body.jobId, ownerId, signal)
            : await cancelJourney(body.jobId, ownerId);
        return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
    }
    catch (error) {
        console.warn('Journey request failed', error instanceof Error ? error.name : 'UnknownError', error && typeof error === 'object' && 'status' in error ? error.status : null);
        return NextResponse.json({ error: '길찾기 서비스를 잠시 이용할 수 없습니다. 잠시 후 다시 시도해 주세요.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
}
