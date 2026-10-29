'use client';
import {useEffect,useRef,type ReactNode} from 'react';
import {ArrowLeft,ChevronRight,MapPin,Navigation} from 'lucide-react';
import {meters,describeFinding} from '@/lib/domain';
import type {CapturePreview} from '@/lib/capture-contract';
import type {Evidence,Route,Sample,RouteAssessments,JourneyGoal} from '@/lib/domain';
import {customerRouteIssues,routeAnalysisStatus,routeAdmissionStatus,routeGuideBlocked,routeIssueTitle,type AnalysisPhase} from './route-presentation';
import RouteTerrain from './RouteTerrain';
import EvidencePhoto,{EvidenceSourceInfo} from './EvidencePhoto';

type Props={route:Route;goal:JourneyGoal;evidence:Record<string,Evidence>;captures:CapturePreview[];activeId:string;assessment:RouteAssessments[string];destinationBlockedReason?:string;gradeThreshold?:number;phase:AnalysisPhase;activity:ReactNode;activeGradeIndex:number|null;onGradeSegment(index:number):void;onBack():void;onStart():void;onLocate(id:string,coord:Sample['coord']):void};
const pointLabels:Partial<Record<NonNullable<Sample['target']>,string>>={'crossing-entry':'횡단보도 진입','crossing-exit':'횡단보도 도착','underpass-entry':'지하보도 입구',entrance:'출입구 연결'};
export default function RouteDetails({route,goal,evidence,captures,activeId,assessment,destinationBlockedReason,gradeThreshold=8,phase,activity,activeGradeIndex,onGradeSegment,onBack,onStart,onLocate}:Props){
 const decision=assessment.decision,admission=routeAdmissionStatus(assessment);
 const guideBlocked=!!destinationBlockedReason||routeGuideBlocked(assessment);
 const heading=useRef<HTMLHeadingElement>(null),selectedPoint=useRef<HTMLElement>(null);
 const samples=[...route.samples].sort((a,b)=>a.along-b.along);
 const capturesByPoint=new Map<string,CapturePreview[]>();
 for(const capture of captures){
  if(!capture.evidenceId.startsWith(route.id+':'))continue;
  const group=capturesByPoint.get(capture.evidenceId);
  if(group)group.push(capture);else capturesByPoint.set(capture.evidenceId,[capture]);
 }
 const issues=customerRouteIssues(route,decision.issues,evidence).filter((issue,index,all)=>all.findIndex(other=>other.sampleId===issue.sampleId)===index);
 const activeIssue=decision.issues.find(issue=>issue.id===activeId)??decision.issues.find(issue=>route.id+':'+issue.sampleId===activeId);
 const sample=samples.find(point=>route.id+':'+point.id===activeId||point.id===activeIssue?.sampleId);
 const selectedId=sample?route.id+':'+sample.id:activeIssue?.id;
 const item=selectedId?evidence[selectedId]:undefined;
 const pointCaptures=selectedId?capturesByPoint.get(selectedId)??[]:[];
 const coord=sample?.coord??activeIssue?.coord;
 const along=sample?.along??activeIssue?.along;
 const finding=item?.stage==='reserved'?undefined:item?.finding;
 const reason=activeIssue?.reason??(item?.stage==='reserved'?'이 지점을 분석하고 있어요.':item?.reason??(finding?describeFinding(finding):'아직 이 지점의 관찰 결과가 없어요.'));
 const status=routeAnalysisStatus({route,decision,evidence,phase});
 const guidance=coord?route.steps.reduce<Route['steps'][number]|undefined>((nearest,step)=>!nearest||meters(step.coord,coord)<meters(nearest.coord,coord)?step:nearest,undefined)?.text:undefined;
 const extraIssues=decision.issues.filter(issue=>!samples.some(point=>point.id===issue.sampleId)).filter((issue,index,all)=>all.findIndex(other=>other.sampleId===issue.sampleId)===index);
 useEffect(()=>{heading.current?.focus({preventScroll:true});},[]);
 useEffect(()=>{if(!activeId)return;selectedPoint.current?.scrollIntoView({block:'nearest'});selectedPoint.current?.focus({preventScroll:true});},[activeId]);
 function selectPoint(id:string,coord:Sample['coord']){
  onLocate(id,coord);
  if(id===activeId||id===selectedId||id===activeIssue?.id){selectedPoint.current?.scrollIntoView({block:'nearest'});selectedPoint.current?.focus({preventScroll:true});}
 }
 return <section className="route-details" aria-label={route.name+' 상세 보기'}>
  <header className="detail-header"><button type="button" className="detail-back" onClick={onBack}><ArrowLeft size={17}/> 경로 목록으로</button><div className="detail-title"><h2 ref={heading} tabIndex={-1}>{route.name}</h2><span>{route.graphSegment?'일부 구간':`도보 ${Math.ceil(route.seconds/60)}분`} · {(route.distance/1000).toFixed(2)}km</span></div><span className="route-status" data-kind={destinationBlockedReason?'blocked':admission.kind}>{destinationBlockedReason?'입구에 계단·턱':admission.label}</span></header>
  <div className="detail-body" tabIndex={0} role="region" aria-label="경로 위치와 사진">
   {destinationBlockedReason&&<p className="notice" role="status">{destinationBlockedReason}</p>}
   {activity}
   {route.graphSegment&&<section className="route-obstacle"><h3>출발지·도착지까지 이어지지 않은 구간이에요</h3><p>이 구간만으로는 길안내를 시작할 수 없어요. 경로 목록에서 다른 경로를 선택하세요.</p></section>}
   {guideBlocked&&!destinationBlockedReason&&!route.graphSegment&&!issues.some(issue=>issue.status==='blocked')&&<section className="route-obstacle"><h3>{admission.label}</h3><p>{admission.detail}</p></section>}
   <RouteTerrain route={route} threshold={gradeThreshold} activeSegmentIndex={activeGradeIndex} onSelectSegment={onGradeSegment} onPoint={selectPoint}/>
   <section className="selected-point-evidence" aria-label="선택한 지점의 사진과 근거">
    <div className="detail-list-heading"><h3>선택한 지점</h3><span>사진과 관찰 근거</span></div>
    {selectedId&&coord&&along!==undefined?<article key={selectedId} ref={selectedPoint} tabIndex={-1} className="detail-point focused" data-evidence-id={selectedId}>
     <div className="detail-point-heading"><h4>출발 후 {Math.round(along)}m · {sample?(sample.target&&pointLabels[sample.target])||'길 확인 지점':'연결 확인 지점'}</h4>{activeIssue&&<span className={'detail-status '+activeIssue.status} data-source={activeIssue.source}>{activeIssue.status==='unknown'?'미확인':activeIssue.status==='blocked'?(activeIssue.source==='provider'?'길찾기 계단 안내':activeIssue.source==='osm'?'지도 통행 제한':'사진에서 장애 확인'):activeIssue.status==='caution'?'노면 주의':'영상 관찰'}</span>}</div>
     {guidance&&<p className="point-guidance">{guidance}</p>}
     <p className="detail-reason">{reason}</p>
     <p className="capture-disclaimer">촬영 당시의 모습이며 현재 현장과 다를 수 있어요.</p>
     {pointCaptures.map((capture,index)=><EvidencePhoto key={capture.id} url={capture.url} source={capture.source} alt={`출발 후 ${Math.round(along)}m 지점 거리 사진 ${index+1}`} caption={pointCaptures.length>1?`이 지점의 보관 사진 ${index+1} / ${pointCaptures.length}`:undefined}/>)}
     {!pointCaptures.length&&item?.source&&<div className="detail-source"><p className="capture-unavailable">표시할 보관 사진은 없어요. 촬영 위치를 확인할 수 있어요.</p><EvidenceSourceInfo source={item.source}/></div>}
     {!pointCaptures.length&&!item?.source&&<p className="capture-unavailable">{phase==='running'&&item?.stage==='reserved'?'이 지점의 사진을 확보하고 있어요.':phase==='running'&&!item?'아직 이 지점의 사진을 확보하지 않았어요.':'이 지점의 사진이 없어요. 다른 확인 지점의 사진이나 지도를 살펴보세요.'}</p>}
     <button type="button" className="detail-locate" onClick={()=>onLocate(activeIssue?.id??selectedId,coord)}><MapPin size={14}/> 지도에서 위치 보기 <ChevronRight size={14}/></button>
     {finding&&activeIssue?.status==='unknown'&&<details className="point-raw-finding"><summary>원래 사진 판독·재확인 정보</summary><p>아래 판독은 위의 미확인 판단을 대체하지 않아요.</p><p>{describeFinding(finding)}</p>{item?.review&&<p>{item.review.note}</p>}</details>}
    </article>:<p className="detail-empty">지도나 전체 확인 지점에서 사진을 볼 위치를 선택하세요.</p>}
   </section>
   <details className="point-raw-finding"><summary>분석 상세</summary><p className="detail-analysis-detail">{status.label} · {status.detail}</p><p className="detail-scope">{goal==='entrance'?'도착 주변 출입문도 살펴봐요 · 실제 매장 입구 별도 확인 · 실내 제외':'지도 도착점까지 · 출입문 연결·실내 이동 제외'}</p></details>
   <details className="detail-all-points"><summary>전체 확인 지점 ({samples.length+extraIssues.length}곳)</summary><ol>{samples.map(point=>{const id=route.id+':'+point.id,count=capturesByPoint.get(id)?.length??0;return <li key={id}><button type="button" data-evidence-id={id} aria-pressed={selectedId===id} onClick={()=>selectPoint(id,point.coord)}><span>출발 후 {Math.round(point.along)}m · {(point.target&&pointLabels[point.target])||'길 확인 지점'}</span><small>{count?`보관 사진 ${count}장`:evidence[id]?.source?'촬영 위치 있음':'사진 없음'}</small><ChevronRight size={16}/></button></li>;})}{extraIssues.map(issue=><li key={issue.id}><button type="button" data-evidence-id={issue.id} aria-pressed={activeId===issue.id} onClick={()=>selectPoint(issue.id,issue.coord)}><span>출발 후 {Math.round(issue.along)}m · {routeIssueTitle(route,issue)}</span><ChevronRight size={16}/></button></li>)}</ol></details>
  </div>
  <footer className="detail-actions"><button type="button" className="primary full" data-admission={assessment.admission?.kind} disabled={guideBlocked} onClick={onStart}>{destinationBlockedReason?'이 입구로는 안내할 수 없어요':guideBlocked?admission.label:'길안내 시작'} <Navigation size={18}/></button>{guideBlocked&&<button type="button" className="detail-locate" onClick={onBack}>다른 경로 보기 <ChevronRight size={14}/></button>}</footer>
 </section>;
}
