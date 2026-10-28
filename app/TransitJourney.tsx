'use client';

import { useEffect, useState } from 'react';
import { z } from 'zod';
import type { Place } from '../lib/domain.ts';
import { transitResultSchema, type TransitResult } from '../lib/transit.ts';

type State = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; result: TransitResult };
const errorSchema = z.object({ error: z.string() });

export default function TransitJourney({ start, end }: { start: Place; end: Place }) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const body = JSON.stringify({ start, end });
  useEffect(() => {
    if (!attempt) return;
    const controller = new AbortController();
    setState({ kind: 'loading' });
    async function load() {
      try {
        const response = await fetch('/api/transit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal });
        const data: unknown = await response.json();
        if (!response.ok) {
          const error = errorSchema.safeParse(data);
          throw new Error(error.success ? error.data.error : '대중교통 경로를 불러올 수 없습니다.');
        }
        const result = transitResultSchema.parse(data);
        if (!controller.signal.aborted) setState({ kind: 'ready', result });
      } catch (error) {
        if (!controller.signal.aborted) setState({ kind: 'error', message: error instanceof Error ? error.message : '대중교통 경로를 불러올 수 없습니다.' });
      }
    }
    void load();
    return () => controller.abort();
  }, [body, attempt]);

  return <section className="transit-journey" aria-label="대중교통 경로">
    <h3>대중교통 후보</h3>
    <button type="button" onClick={() => setAttempt(n => n + 1)} disabled={state.kind === 'loading'}>
      {state.kind === 'loading' ? '경로 검색 중' : attempt ? '다시 검색' : '대중교통 경로 검색'}
    </button>
    {state.kind === 'error' && <p role="alert">{state.message}</p>}
    {state.kind === 'ready' && <>
      <p>ODsay 제공 일반 경로 후보입니다. 보행·승강장·환승·차량 및 승강기 운행 상태는 확인되지 않았습니다.</p>
      {state.result.candidates.length === 0 && <p>대중교통 후보가 없습니다.</p>}
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
