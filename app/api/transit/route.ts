import { transitApiKey } from '../../../lib/server-config.ts';
import { searchTransit, TransitError, transitRequestSchema } from '../../../lib/transit.ts';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

export async function POST(request: Request) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return Response.json({ error: '요청을 처리할 수 없습니다.' }, { status: 403, headers });
  const owner = request.headers.get('oai-authenticated-user-id');
  const local = import.meta.env?.DEV && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (!owner && !local) return Response.json({ error: '로그인 후 길찾기를 이용해 주세요.' }, { status: 401, headers });
  if (Number(request.headers.get('content-length')) > 20000) return Response.json({ error: '입력값을 확인해 주세요.' }, { status: 413, headers });
  let text: string;
  try { text = await request.text(); } catch { return Response.json({ error: '입력값을 확인해 주세요.' }, { status: 400, headers }); }
  if (text.length > 20000) return Response.json({ error: '입력값을 확인해 주세요.' }, { status: 413, headers });
  let value: unknown;
  try { value = JSON.parse(text); } catch { return Response.json({ error: '입력값을 확인해 주세요.' }, { status: 400, headers }); }
  const input = transitRequestSchema.safeParse(value);
  if (!input.success) return Response.json({ error: '입력값을 확인해 주세요.' }, { status: 400, headers });
  const key = transitApiKey();
  if (!key) return Response.json({ error: '대중교통 경로 제공자 설정이 필요합니다.' }, { status: 503, headers });
  try {
    const result = await searchTransit(input.data.start, input.data.end, key, AbortSignal.any([request.signal, AbortSignal.timeout(30000)]));
    return Response.json(result, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof TransitError ? error.message : '대중교통 경로를 불러올 수 없습니다.' }, { status: error instanceof TransitError ? error.status : 503, headers });
  }
}
