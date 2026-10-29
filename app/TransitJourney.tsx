'use client';

import { useEffect, useState } from 'react';
import { z } from 'zod';
import type { Place } from '../lib/domain.ts';
import { transitResultSchema, type TransitResult } from '../lib/transit.ts';

type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; result: TransitResult };
const errorSchema = z.object({ error: z.string() });

export default function TransitJourney({ start, end }: { start: Place; end: Place }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const body = JSON.stringify({ start, end });
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    async function load() {
      try {
        const response = await fetch('/api/transit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal });
        const data: unknown = await response.json();
        if (!response.ok) {
          if (response.status === 503) throw new Error('대중교통 경로 서비스를 아직 연결하지 못했어요. 잠시 후 다시 시도하거나 도보 경로를 확인해 주세요.');
          const error = errorSchema.safeParse(data);
          throw new Error(error.success ? error.data.error : '대중교통 경로를 불러올 수 없습니다.');
        }
        const result = transitResultSchema.parse(data);
        if (!controller.signal.aborted) setState({ kind: 'ready', result });
      } catch (error) {
        if (!controller.signal.aborted) setState({ kind: 'error', message: error instanceof Error ? error.message : '대중교통 경로를 불러올 수 없습니다.' });
      }
    }
    queueMicrotask(() => { if (!controller.signal.aborted) void load(); });
    return () => controller.abort();
  }, [body, attempt]);

  return <section className="transit-journey" aria-label="대중교통 경로">
    <h3>대중교통 경로</h3>
    <p className="transit-scope">일반 경로를 안내해요. 승강기 운행과 보행·환승 구간의 접근성은 확인되지 않았어요.</p>
    {state.kind === 'loading' && <p role="status">대중교통 경로를 찾고 있어요</p>}
    {state.kind === 'error' && <div role="alert"><p>{state.message}</p><button type="button" onClick={() => setAttempt(n => n + 1)}>다시 시도</button></div>}
    {state.kind === 'ready' && <>
      {state.result.candidates.length === 0 && <p role="status">이 출발지와 도착지를 잇는 대중교통 경로가 없어요. 위치를 바꾸거나 도보 경로를 확인해 주세요.</p>}
      {state.result.candidates.map((candidate, index) => <article key={index}>
        <h4>후보 {index + 1} · 약 {candidate.minutes}분</h4>
        <p>도보 {candidate.walkMeters}m{candidate.fare !== undefined ? ` · 예상 요금 ${candidate.fare.toLocaleString('ko-KR')}원` : ''}</p>
        <ol>
          {candidate.legs.map((leg, legIndex) => <li key={legIndex}>
            {leg.kind === 'walk' ? <>
              도보 {leg.distanceMeters}m · 약 {leg.minutes}분
              {legIndex > 0 && legIndex < candidate.legs.length - 1 ? ' (환승 이동)' : ''}
            </> : <>
              {legIndex > 0 && candidate.legs.slice(0, legIndex).some(previous => previous.kind !== 'walk') ? '환승: ' : ''}
              {leg.kind === 'bus' ? '버스' : '지하철'} {leg.lines.length ? leg.lines.join(' / ') : '노선 미제공'}
              {leg.direction ? ` (${leg.direction} 방면)` : ''}
              {' · '}{leg.startName ?? '승차 정류장 미제공'} 승차 → {leg.endName ?? '하차 정류장 미제공'} 하차
              {leg.startExit ? ` · 출발역 ${leg.startExit}번 출입구 안내` : ''}{leg.endExit ? ` · 도착역 ${leg.endExit}번 출입구 안내` : ''} · 약 {leg.minutes}분
              {leg.stationCount !== undefined ? ` · ${leg.stationCount}정거장` : ''}
            </>}
          </li>)}
          <li>목적지: {end.name} · 최종 연결과 출입구 접근성 미확인</li>
        </ol>
      </article>)}
    </>}
  </section>;
}
