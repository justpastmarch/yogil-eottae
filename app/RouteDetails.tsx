'use client';
import {useEffect,useRef,useState} from 'react';
import {ArrowLeft,ChevronRight,ExternalLink,MapPin,Accessibility,TriangleAlert} from 'lucide-react';
import {summary,type Evidence,type Finding,type Route,type Sample} from '@/lib/domain';

type Props={route:Route;evidence:Record<string,Evidence>;phase:'running'|'ready'|'limited'|'failed'|'canceled';activeId:string;hasExcludedPassage:boolean;onBack():void;onLocate(sample:Sample):void};
const verdictLabels={clear:'이동 공간 관찰',caution:'주의 구간',blocked:'통행 장애 관찰',unknown:'판정 불가'};
const featureLabels={present:'관찰됨','not-observed':'사진에서 보이지 않음',unobservable:'판단 어려움'};
function eligibleFinding(item:Evidence|undefined){const finding=item?.finding;return item?.stage!=='reserved'&&finding?.pathVisible&&finding.routeMatch==='same-path'&&finding.status!=='unknown'?finding:undefined;}
function captureDate(source:NonNullable<Evidence['source']>){return source.capturedMonth??(source.capturedAt===null?'시점 미상':new Date(source.capturedAt).toLocaleDateString('ko-KR'));}
function Feature({label,observation}:{label:string;observation:NonNullable<Finding['features']>['stairs']|undefined}){
 return <div className="detail-feature"><dt>{label}</dt><dd>{observation?featureLabels[observation.state]:'항목별 판독 없음'}</dd>{observation&&<p>{observation.reason}</p>}</div>;
}
export default function RouteDetails({route,evidence,phase,activeId,hasExcludedPassage,onBack,onLocate}:Props){
 const [showAll,setShowAll]=useState(false);
 const heading=useRef<HTMLHeadingElement>(null);
 const rows=useRef(new Map<string,HTMLLIElement>());
 const samples=[...route.samples].sort((a,b)=>a.along-b.along);
 const readings=samples.filter(sample=>{const item=evidence[route.id+':'+sample.id];return item?.stage!=='reserved'&&item?.finding&&item.source;});
 const classified=readings.map(sample=>eligibleFinding(evidence[route.id+':'+sample.id])?.features).filter(features=>features!==undefined);
 const stairs=classified.filter(features=>features.stairs.state==='present').length;
 const inclines=classified.filter(features=>features.incline.state==='present').length;
 const visible=showAll?samples:readings;
 const stats=summary(route,evidence);
 const blocked=hasExcludedPassage||stats.blocked>0;
 const complete=stats.total>0&&stats.clear===stats.total&&!blocked;
 const readiness=blocked?'통행 장애 구간 포함':complete?'표본 지점 판독 완료':phase==='running'?'접근성 분석 중':'접근성 미검증';
 useEffect(()=>{heading.current?.focus({preventScroll:true});},[]);
 useEffect(()=>{if(activeId)setShowAll(true);},[activeId]);
 useEffect(()=>{if(!activeId||!showAll)return;const row=rows.current.get(activeId);row?.scrollIntoView({block:'nearest'});row?.focus({preventScroll:true});},[activeId,showAll]);
 return <section className="route-details" aria-label={route.name+' 상세 보기'}>
  <header className="detail-header"><button className="detail-back" onClick={onBack}><ArrowLeft size={17}/> 경로 목록으로</button><div className="detail-title"><h2 ref={heading} tabIndex={-1}>{route.name} 상세</h2><span>{Math.ceil(route.seconds/60)}분 · {(route.distance/1000).toFixed(2)}km</span></div><p>계단·경사와 판정 근거를 이동 순서대로 살펴보세요.</p></header>
  <div className="detail-body" tabIndex={0} role="region" aria-label="경로 상세 판독 결과">
   <section className="detail-overview"><p className={'detail-readiness '+(blocked?'blocked':complete?'complete':'incomplete')}>{readiness}</p><div className="detail-coverage"><Accessibility size={18}/><strong>이 경로의 거리영상 판독 {readings.length}<span> / {samples.length} 지점</span></strong></div><progress value={readings.length} max={Math.max(1,samples.length)} aria-label="이 경로의 거리영상 판독 지점 비율"/>{hasExcludedPassage&&<p className="detail-warning"><TriangleAlert size={15}/> 관찰된 장애 통로가 이 경로에 포함되어 있어요.</p>}<p className="detail-caption">{phase==='running'?'분석 결과가 순서대로 추가되고 있어요.':'판독되지 않은 지점의 통행 상태는 알 수 없어요.'}</p><div className="detail-feature-totals">{classified.length?<><span>계단 관찰 <b>{stairs}개 지점</b></span><span>경사 관찰 <b>{inclines}개 지점</b></span></>:<span>계단·경사 항목별 판독 결과가 아직 없어요.</span>}</div></section>
   <section className="detail-grade"><span className="detail-kicker">경사 정보</span><div><h3>수치 경사도</h3><strong>미측정</strong></div><p>사진에서는 경사의 모습을 관찰해요. 정확한 % 경사도는 고도·측량 데이터가 없어 제공하지 않아요.</p></section>
   <div className="detail-list-heading"><h3>지점별 판정 근거</h3><span>출발 → 도착</span></div><div className="detail-tabs" role="group" aria-label="표시할 지점"><button aria-pressed={!showAll} onClick={()=>setShowAll(false)}>판독 결과 {readings.length}</button><button aria-pressed={showAll} onClick={()=>setShowAll(true)}>이 경로 전체 지점 {samples.length}</button></div>
   {!visible.length&&<div className="detail-empty"><MapPin size={24}/><p>아직 표시할 거리영상 판독 결과가 없어요.</p><small>전체 지점에서 미분석 지점의 위치를 볼 수 있어요.</small></div>}
   <ol className="detail-timeline">{visible.map(sample=>{
    const id=route.id+':'+sample.id,item=evidence[id],reserved=item?.stage==='reserved',finding=reserved?undefined:item?.finding,features=eligibleFinding(item)?.features;
    const displayFeatures=features??(finding?.features?.stairs.state==='unobservable'&&finding.features.incline.state==='unobservable'?finding.features:undefined);
    const label=reserved?(phase==='running'?'분석 중':'분석 미완료'):finding?verdictLabels[finding.status]:item?'영상 판독 없음':'미분석';
    const reason=reserved?(phase==='running'?'이 지점의 이동 환경을 살펴보고 있어요.':'이 지점의 분석이 완료되지 않았어요.'):item?.reason??'아직 이 지점의 거리영상을 분석하지 않았어요.';
    return <li key={id} tabIndex={-1} ref={element=>{if(element)rows.current.set(id,element);else rows.current.delete(id);}} className={'detail-point '+(activeId===id?'focused':'')}>
     <div className="detail-point-heading"><span className="detail-point-distance">{Math.round(sample.along)}<small>m 지점</small></span><span className={'detail-status '+(finding?.status??'unknown')}>{label}</span></div>
     <p className="detail-reason">{reason}</p>
     {finding&&<><dl className="detail-features"><Feature label="계단" observation={displayFeatures?.stairs}/><Feature label="경사·경사로" observation={displayFeatures?.incline}/><div className="detail-feature grade-unmeasured"><dt>수치 경사도</dt><dd>미측정</dd></div></dl>
      {(!finding.pathVisible||finding.routeMatch!=='same-path')&&<p className="detail-scope">{finding.routeMatch==='different-path'?'사진이 실제 이동 경로와 다른 통로를 보여줘요.':'사진에서 실제 이동 통로를 충분히 식별하지 못했어요.'}</p>}
      {!!finding.evidence.length&&<div className="detail-evidence"><h4>사진에서 관찰한 근거</h4><ul>{finding.evidence.map((text,index)=><li key={index}>{text}</li>)}</ul></div>}
      {!!finding.limitations.length&&<div className="detail-limitations"><h4>사진으로 판단하지 못한 부분</h4><ul>{finding.limitations.map((text,index)=><li key={index}>{text}</li>)}</ul></div>}
     </>}
     {!reserved&&item?.source&&<div className="detail-source"><span>촬영 {captureDate(item.source)}</span><a href={item.source.url} target="_blank" rel="noreferrer">거리 모습 보기 <ExternalLink size={12}/></a></div>}
     <button className="detail-locate" onClick={()=>onLocate(sample)}><MapPin size={14}/> 지도에서 위치 보기 <ChevronRight size={14}/></button>
    </li>;
   })}</ol>
   <p className="detail-footnote">촬영 당시 표본 지점의 관찰 결과예요. 사진에서 보이지 않는 요소와 현재 현장 상태까지 보장하지는 않아요.</p>
  </div>
 </section>;
}
