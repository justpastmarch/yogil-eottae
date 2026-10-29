'use client';
import {useId} from 'react';
import {GRADE_BANDS,UNKNOWN_GRADE,gradeBand} from './grade-colors.ts';
import {meters,type Coord,type Route} from '../lib/domain.ts';

type Props={route:Route;threshold?:number;activeSegmentIndex:number|null;onSelectSegment:(index:number)=>void;onPoint:(id:string,coord:Coord)=>void};
const gradeLabel=(value:number)=>value===0?'평지':`${value>0?'오르막':'내리막'} 약 ${Math.abs(value).toFixed(1)}%`;

export default function RouteTerrain({route,threshold=8,activeSegmentIndex,onSelectSegment,onPoint}:Props){
 const titleId=useId();
 const grade=route.grade;
 const crossings=route.samples.filter(sample=>sample.target==='crossing-entry').sort((a,b)=>a.along-b.along);
 const segments=grade?.segments??[];
 const length=Math.max(1,route.coords.reduce((sum,coord,index)=>sum+(index?meters(route.coords[index-1],coord):0),0),...segments.map(segment=>segment.toAlong));
 const extent=Math.max(1,...segments.map(segment=>Math.abs(segment.gradePercent)));
 const steepSegments=segments.filter(segment=>Math.abs(segment.gradePercent)>=threshold);
 const steepLength=steepSegments.reduce((sum,segment)=>sum+segment.toAlong-segment.fromAlong,0);
 const selected=activeSegmentIndex===null?undefined:segments[activeSegmentIndex];
 const width=400,height=220,left=48,right=16,top=48,bottom=32;
 const x=(along:number)=>left+along/length*(width-left-right);
 const y=(percent:number)=>top+(extent-percent)/(2*extent)*(height-top-bottom);
 const gaps:{from:number;to:number}[]=[];
 let coveredTo=0;
 for(const segment of segments){
  if(segment.fromAlong>coveredTo+.5)gaps.push({from:coveredTo,to:segment.fromAlong});
  coveredTo=Math.max(coveredTo,segment.toAlong);
 }
 if(coveredTo<length-.5)gaps.push({from:coveredTo,to:length});
 return <section className="route-terrain" aria-labelledby={titleId}>
  <h3 id={titleId}>경사 · 횡단보도</h3>
  {!grade||grade.status==='unavailable'?<p>경사 정보가 없어요. 평탄한 길이라는 뜻은 아닙니다.</p>:<>
   <div className="terrain-summary"><b>확인된 최대 약 {grade.maxAbsPercent.toFixed(1)}%</b><span>{steepSegments.length?`통계 기준 ${threshold}% 이상 ${steepSegments.length}구간 · 합계 약 ${Math.round(steepLength)}m`:`확인된 구간에 통계 기준 ${threshold}% 이상 경사 없음`}</span>{grade.status==='partial'&&<span className="terrain-incomplete">일부 구간 자료 없음 · 빈 구간은 경사를 알 수 없어요.</span>}</div>
   <p className="terrain-profile-help">출발부터 도착까지의 경사 변화예요. 구간을 누르면 지도와 수치를 함께 볼 수 있어요.</p>
   <div className="terrain-profile-scroll">
    <svg className="terrain-profile" viewBox={`0 0 ${width} ${height}`} role="group" aria-label="출발 거리별 지형 경사 프로필. 위는 오르막, 아래는 내리막. 빈 구간은 자료 없음.">
     <text x={left-5} y={top+4} textAnchor="end">+{extent.toFixed(0)}%</text><text x={left-5} y={y(0)+4} textAnchor="end">0%</text><text x={left-5} y={height-bottom+4} textAnchor="end">−{extent.toFixed(0)}%</text>
     <line className="terrain-zero" x1={left} x2={width-right} y1={y(0)} y2={y(0)}/>
     {gaps.map(gap=><g key={`gap-${gap.from}`} className="terrain-gap"><rect x={x(gap.from)} y={top} width={x(gap.to)-x(gap.from)} height={height-top-bottom}/><title>{`출발 후 ${Math.round(gap.from)}~${Math.round(gap.to)}m 자료 없음`}</title></g>)}
     {segments.map((segment,index)=>{
      const active=activeSegmentIndex===index,steep=Math.abs(segment.gradePercent)>=threshold;
      const band=gradeBand(segment.gradePercent);
      return <g key={`${route.id}-${index}`} style={{color:band.color}} className={`terrain-profile-segment ${band.className}${steep?' is-steep':''}${active?' is-selected':''}`} role="button" tabIndex={0} aria-pressed={active} data-grade-index={index} aria-label={`${index+1}구간, 출발 후 ${Math.round(segment.fromAlong)}~${Math.round(segment.toAlong)}m, ${gradeLabel(segment.gradePercent)}${steep?', 통계 기준 이상':''}`} onClick={()=>onSelectSegment(index)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onSelectSegment(index);}}}>
       <rect className="terrain-segment-area" x={x(segment.fromAlong)} y={Math.min(y(0),y(segment.gradePercent))} width={Math.max(.5,x(segment.toAlong)-x(segment.fromAlong))} height={Math.max(2,Math.abs(y(0)-y(segment.gradePercent)))}/>
       <line className="terrain-segment-line" x1={x(segment.fromAlong)} x2={x(segment.toAlong)} y1={y(segment.gradePercent)} y2={y(segment.gradePercent)}/>
       <rect className="terrain-segment-hit" x={x(segment.fromAlong)} y={top} width={Math.max(.5,x(segment.toAlong)-x(segment.fromAlong))} height={height-top-bottom}/>
      </g>;
     })}
     {!!crossings.length&&<line className="terrain-crossing-axis" x1={left} x2={width-right} y1={20} y2={20}/>}
     {crossings.map((crossing,index)=><g className="terrain-crossing-dot" key={crossing.id} role="button" tabIndex={0} data-evidence-id={`${route.id}:${crossing.id}`} aria-label={`횡단 ${index+1}, 출발 후 ${Math.round(crossing.along)}m, 지점 보기`} onClick={()=>onPoint(`${route.id}:${crossing.id}`,crossing.coord)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onPoint(`${route.id}:${crossing.id}`,crossing.coord);}}}><circle cx={x(crossing.along)} cy={20} r={5}/><rect x={x(crossing.along)-22} y={0} width={44} height={44}/><title>{`횡단 ${index+1}`}</title></g>)}
     <text x={left} y={height-7}>출발 0m</text><text x={width-right} y={height-7} textAnchor="end">도착 {Math.round(length)}m</text>
    </svg>
   </div>
   <p className="terrain-profile-key">{GRADE_BANDS.map(band=><span className="terrain-key-entry" key={band.className}><i className={band.className} style={{background:band.color}}/> {band.label}</span>)}<span className="terrain-key-entry"><i className={UNKNOWN_GRADE.className} style={{background:UNKNOWN_GRADE.color}}/> {UNKNOWN_GRADE.label}</span>{!!crossings.length&&<><span className="is-crossing"/> 위쪽 점: 횡단 지점</>}</p>
   <p className="subnote">색상은 오르막·내리막 절댓값의 10%·20% 고정 기준입니다. 경사 통계 기준은 구간 수·길이 집계에만 적용해요.</p>
   <div className="terrain-selected" aria-live="polite" aria-atomic="true">{selected?<><b>{activeSegmentIndex===null?'':activeSegmentIndex+1}구간 · {gradeLabel(selected.gradePercent)}</b><span>출발 후 {Math.round(selected.fromAlong)}~{Math.round(selected.toAlong)}m · 약 {Math.round(selected.toAlong-selected.fromAlong)}m{Math.abs(selected.gradePercent)>=threshold?' · 통계 기준 이상':''}</span></>:<span>프로필에서 구간을 선택해 자세히 보세요.</span>}</div>
   <p className="subnote">지형자료로 추정한 값이며 보도의 실측 경사나 통행 가능 판정이 아닙니다.</p>
   <details className="terrain-numeric"><summary>전체 경사 수치 · 자료 출처</summary>
    <p>오르막 누적 약 {Math.round(grade.ascentMeters)}m · 내리막 누적 약 {Math.round(grade.descentMeters)}m{grade.status==='partial'?' (자료가 있는 구간만)':''}</p>
    <ol>{segments.map((segment,index)=><li key={index}><button type="button" data-grade-index={index} aria-pressed={activeSegmentIndex===index} onClick={()=>onSelectSegment(index)}>{index+1}구간 · 출발 후 {Math.round(segment.fromAlong)}~{Math.round(segment.toAlong)}m · {gradeLabel(segment.gradePercent)}{Math.abs(segment.gradePercent)>=threshold?' · 통계 기준 이상':''}</button></li>)}</ol>
    <p>약 {grade.resolutionMeters}m 해상도 지형자료 · 구간 산정 기준 거리 {grade.baselineMeters}m</p>
    <a href="https://www.opentopodata.org/datasets/srtm/" target="_blank" rel="noreferrer">SRTM 지형자료</a>
   </details>
  </>}
  {!!crossings.length&&<details className="terrain-crossings"><summary>횡단보도 {crossings.length}곳 · 지점 목록{route.crossingChoice?' · '+route.crossingChoice.label:''}</summary><div className="terrain-crossing-points" aria-label="출발 거리별 횡단 지점">{crossings.map((crossing,index)=><button type="button" key={crossing.id} data-evidence-id={`${route.id}:${crossing.id}`} onClick={()=>onPoint(`${route.id}:${crossing.id}`,crossing.coord)}>횡단 {index+1}<span>{Math.round(crossing.along)}m · 지점 보기</span></button>)}</div></details>}
 </section>;
}
