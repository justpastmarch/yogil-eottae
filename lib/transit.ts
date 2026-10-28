import { z } from 'zod';
import { placeSchema, type Place } from './domain.ts';

export const transitRequestSchema = z.object({ start: placeSchema, end: placeSchema }).strict();
const nonnegative = z.number().finite().nonnegative();
const coordinate = z.tuple([z.number().min(124).max(132), z.number().min(33).max(40)]);
const lane = z.object({ name: z.string().optional(), busNo: z.string().optional() });
const part = z.object({
  trafficType: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  distance: nonnegative, sectionTime: nonnegative,
  startName: z.string().optional(), endName: z.string().optional(),
  startX: z.number().optional(), startY: z.number().optional(), endX: z.number().optional(), endY: z.number().optional(),
  startExitNo: z.string().optional(), endExitNo: z.string().optional(),
  lane: z.union([z.array(lane),lane]).optional(), way: z.string().optional(), stationCount: nonnegative.optional(),
});
const providerResponse = z.object({
  result: z.object({ searchType: z.literal(0), path: z.array(z.object({
    info: z.object({ totalTime: nonnegative, totalWalk: nonnegative, payment: nonnegative.optional() }),
    subPath: z.array(part).min(1),
  })).max(100) }),
});
const providerError = z.object({ error: z.array(z.object({ code: z.union([z.string(), z.number()]) })).min(1) });

type ProviderPart = z.infer<typeof part>;
export const transitLegSchema = z.object({
  kind: z.enum(['walk', 'bus', 'subway']),
  minutes: nonnegative, distanceMeters: nonnegative,
  startName: z.string().optional(), endName: z.string().optional(),
  startCoord: coordinate.optional(), endCoord: coordinate.optional(),
  lines: z.array(z.string()), direction: z.string().optional(), stationCount: nonnegative.optional(),
  startExit: z.string().optional(), endExit: z.string().optional(),
  accessibility: z.literal('unknown'),
});
export type TransitLeg = z.infer<typeof transitLegSchema>;
export const transitResultSchema = z.object({
  provider: z.literal('ODsay'),
  candidates: z.array(z.object({ minutes: nonnegative, walkMeters: nonnegative, fare: nonnegative.optional(), legs: z.array(transitLegSchema) })),
});
export type TransitResult = z.infer<typeof transitResultSchema>;

export class TransitError extends Error {
  readonly status:number;
  constructor(message:string,status:number){super(message);this.status=status;}
}

function point(x: number | undefined, y: number | undefined): [number, number] | undefined {
  const parsed = coordinate.safeParse([x, y]);
  return parsed.success ? parsed.data : undefined;
}
function convertPart(p: ProviderPart): TransitLeg {
  return {
    kind: p.trafficType === 3 ? 'walk' : p.trafficType === 2 ? 'bus' : 'subway',
    minutes: p.sectionTime, distanceMeters: p.distance,
    startName: p.startName, endName: p.endName, startCoord: point(p.startX, p.startY), endCoord: point(p.endX, p.endY),
    lines: (p.lane ? Array.isArray(p.lane) ? p.lane : [p.lane] : []).map(l => p.trafficType === 2 ? l.busNo : l.name).filter((s): s is string => Boolean(s)),
    direction: p.way, stationCount: p.stationCount, startExit: p.startExitNo, endExit: p.endExitNo,
    accessibility: 'unknown',
  };
}

export function parseTransitResponse(input: unknown): TransitResult {
  const failure = providerError.safeParse(input);
  if (failure.success) {
    const code = String(failure.data.error[0].code);
    if (['3', '4', '5', '6', '-98', '-99'].includes(code)) {
      throw new TransitError(code === '-98' ? '출발지와 목적지가 가까워 대중교통 후보를 검색할 수 없습니다.' : '이 구간의 대중교통 후보를 찾지 못했습니다.', 404);
    }
    throw new TransitError('대중교통 제공자 요청을 처리할 수 없습니다. 서비스 설정과 이용 한도를 확인해 주세요.', 502);
  }
  const parsed = providerResponse.safeParse(input);
  if (!parsed.success) throw new TransitError('대중교통 제공자의 응답을 해석할 수 없습니다.', 502);
  return { provider: 'ODsay', candidates: parsed.data.result.path.map(path => ({
    minutes: path.info.totalTime, walkMeters: path.info.totalWalk, fare: path.info.payment,
    legs: path.subPath.map(convertPart),
  })) };
}

export async function searchTransit(start: Place, end: Place, key: string, signal: AbortSignal): Promise<TransitResult> {
  const params = new URLSearchParams({ SX: String(start.coord[0]), SY: String(start.coord[1]), EX: String(end.coord[0]), EY: String(end.coord[1]), SearchType: '0', apiKey: key });
  let response: Response;
  try {
    response = await fetch('https://api.odsay.com/v1/api/searchPubTransPathT', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params, signal, cache: 'no-store',
    });
  } catch {
    throw new TransitError('대중교통 제공자에 연결할 수 없습니다.', 502);
  }
  if (!response.ok) throw new TransitError('대중교통 제공자에 연결할 수 없습니다.', 502);
  let data: unknown;
  try { data = await response.json(); } catch { throw new TransitError('대중교통 제공자의 응답을 해석할 수 없습니다.', 502); }
  return parseTransitResponse(data);
}
