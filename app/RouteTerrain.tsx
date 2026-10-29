'use client';
import type {Coord,Route} from '../lib/domain.ts';

export default function RouteTerrain({route,threshold=8,onLocate}:{route:Route;threshold?:number;onLocate?:(coord:Coord)=>void}){
 const grade=route.grade;
 const crossings=route.samples.filter(sample=>sample.target==='crossing-entry').sort((a,b)=>a.along-b.along);
 return <section className="route-terrain" aria-label="경사와 횡단보도">
  <h3>경사 · 횡단보도</h3>
  {!grade||grade.status==='unavailable'?<p>이 경로의 경사 추정 자료를 받지 못했습니다. 평지로 간주하지 않습니다.</p>:<>
   <div className="terrain-summary"><b>최대 약 {grade.maxAbsPercent.toFixed(1)}%</b><span>오르막 누적 약 {Math.round(grade.ascentMeters)}m · 내리막 약 {Math.round(grade.descentMeters)}m</span></div>
   <p className="subnote">30m 지형고도에서 60m 이상 구간으로 계산한 추정입니다. 보도·경사판의 실측 경사나 통행 가능 판정이 아닙니다. 자료 범위 {Math.round(grade.coverageFraction*100)}%.</p>
   <details><summary>경사 구간과 근거 펼치기</summary>
    <p>지도에서 절대 경사 {threshold}% 이상을 진하게 표시합니다. 이 값은 표시·비교 기준이며 통행 불가 기준이 아닙니다.</p>
    <ol>{grade.segments.map((segment,index)=><li key={index}><button type="button" onClick={()=>onLocate?.(segment.coords[Math.floor(segment.coords.length/2)])}>출발 후 {Math.round(segment.fromAlong)}~{Math.round(segment.toAlong)}m · {segment.gradePercent>=0?'오르막':'내리막'} 약 {Math.abs(segment.gradePercent).toFixed(1)}%{Math.abs(segment.gradePercent)>=threshold?' · 설정 기준 이상':''}</button></li>)}</ol>
    <a href="https://www.opentopodata.org/datasets/srtm/" target="_blank" rel="noreferrer">SRTM 지형자료 설명</a><p>조회 {new Date(grade.retrievedAt).toLocaleString('ko-KR')}</p>
   </details>
  </>}
  {!!crossings.length?<><p>선택한 경로의 횡단 진입 관찰점 {crossings.length}곳{route.crossingChoice?' · '+route.crossingChoice.label:''}</p><ol>{crossings.map((crossing,index)=><li key={crossing.id}><button type="button" onClick={()=>onLocate?.(crossing.coord)}>횡단 {index+1} · 출발 후 {Math.round(crossing.along)}m 위치 보기</button></li>)}</ol><p className="subnote">횡단 위치는 지도 안내·보행망에서 찾은 관찰점입니다. 진입·진출부의 로드뷰 판독은 경로 근거에서 따로 확인합니다.</p></>:<p className="subnote">이 경로에 대응하는 횡단 지점을 지도에서 찾지 못했습니다. 횡단이 없다는 뜻은 아닙니다.</p>}
 </section>;
}
