'use client';
import {useEffect,useRef,useState} from 'react';
import {ArrowLeft,ChevronRight,ExternalLink,MapPin,Accessibility,Eye} from 'lucide-react';
import {naverPanoramaPose,imageryProviderLabel} from '@/lib/roadview-source';
import {meters,hasOnlyProviderBarriers,describeFinding} from '@/lib/domain';
import type {CapturePreview} from '@/lib/capture-contract';
import type {Evidence,Finding,Route,Sample,RouteDecision,RouteIssue,JourneyGoal} from '@/lib/domain';
import RouteTerrain from './RouteTerrain';
import PanoramaModal from './PanoramaModal';

type Props={route:Route;goal:JourneyGoal;evidence:Record<string,Evidence>;captures:CapturePreview[];phase:'running'|'ready'|'limited'|'failed'|'canceled';activeId:string;decision:RouteDecision;gradeThreshold?:number;onBack():void;onLocate(id:string,coord:Sample['coord']):void};
const actionLabels={recommended:'영상 기준 추천',conditional:'조건부 후보',detour:'이 경로는 우회가 필요해요',hold:'아직 안내 경로로 추천할 수 없어요'};
const statusLabels={clear:'이동 통로 관찰',caution:'확인된 주의 요소',blocked:'통행 장애 확인',unknown:'추가 확인 필요'};
const featureLabels={present:'관찰됨','not-observed':'관찰 범위에서 발견 안 됨',unobservable:'이 특징을 관찰할 수 없음'};
const sourceLabels={imagery:'거리영상에서 관찰한 내용',provider:'길찾기 API의 이동 안내 · 영상 판독 아님',geometry:'선택 지점과 경로 좌표 비교 · 영상 판독 아님',osm:'OpenStreetMap 지도 정보 · 영상 판독 아님',coverage:'영상 확인 상태',service:'처리 실패'};
function captureDate(source:NonNullable<Evidence['source']>){return source.capturedMonth??(source.capturedAt===null?'시점 미상':new Date(source.capturedAt).toLocaleDateString('ko-KR'));}
const sourceName=imageryProviderLabel;
const graphUnavailableReasons={ 'not-configured':'지도 보행망 서비스가 설정되지 않았어요.',network:'지도 보행망을 불러오는 중 연결에 문제가 생겼어요.',incomplete:'지도 보행망 응답이 불완전해 사용할 수 없어요.','too-large':'요청 범위가 너무 넓어 지도 보행망을 불러오지 못했어요.','no-data':'이 경로 주변에서 사용할 수 있는 지도 보행망을 찾지 못했어요.'};
function GraphCoverage({coverage,partial=false}:{coverage:Route['graphCoverage'];partial?:boolean}){
 if(!coverage)return null;
 return <section className="detail-search" aria-label="지도 보행망 정보"><h3>OpenStreetMap 보행망</h3>{coverage.status==='available'?<><p>경로 주변의 지도 연결 정보를 확보했어요. 일부 지역 정보이며 전체 경로나 실제 접근 가능 여부를 보장하지 않아요.</p><span>지도 데이터 복제 시각 {coverage.snapshotAt?coverage.snapshotAt.slice(0,10):'미상'} · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap 기여자 · ODbL</a></span><p>{partial?'경로 목록에서 다른 후보를 비교하세요.':'아래 영상 판독과 확인이 필요한 지점을 함께 살펴보세요.'}</p></>:<><p>{coverage.reason?graphUnavailableReasons[coverage.reason]:'지도 보행망을 사용할 수 없어요.'}</p><p>경로 후보와 영상 판독 결과를 비교하고, 확인되지 않은 구간은 출발 전에 확인하세요.</p></>}</section>;
}
function Feature({label,observation}:{label:string;observation:NonNullable<Finding['features']>['stairs']|undefined}){
 return <div className="detail-feature"><dt>{label}</dt><dd>{observation?featureLabels[observation.state]:'항목별 관찰 없음'}</dd></div>;
}
function nearestGuidance(route:Route,coord:Sample['coord']){
 return route.steps.reduce<Route['steps'][number]|undefined>((nearest,step)=>!nearest||meters(step.coord,coord)<meters(nearest.coord,coord)?step:nearest,undefined)?.text;
}
function CaptureFrame({capture,processing,onOpen}:{capture:CapturePreview;processing:boolean;onOpen(source:CapturePreview['source']):void}){
 const [unavailable,setUnavailable]=useState(false);
 const kartaview=new URL(capture.source.url).hostname==='kartaview.org';
 return <figure className="capture-frame">
  {unavailable?<p className="capture-unavailable" role="status">보관된 이미지를 불러올 수 없어요. 보관 기간이 지났거나 연결에 문제가 있을 수 있습니다.</p>:<details className="capture-expand"><summary><span className="capture-thumbnail"><img src={capture.url} alt={`${capture.viewId==='initial'?'최초':'재확인'} 판독용 이미지 ${capture.viewId}`} loading={processing?'eager':'lazy'} onError={()=>setUnavailable(true)}/></span><span className="capture-expand-label">{capture.viewId==='initial'?'최초 이미지':'재확인 이미지'} · {capture.viewId}<span>전체 화면 펼치기</span></span></summary><div className="capture-full"><img src={capture.url} alt={`${capture.viewId} 판독용 이미지 전체 화면`} loading="lazy" onError={()=>setUnavailable(true)}/><a href={capture.url} target="_blank" rel="noreferrer">판독 이미지 열기 <ExternalLink size={12}/></a></div></details>}
  <figcaption><strong>{sourceName(capture.source)} · {capture.source.capturedMonth??captureDate(capture.source)} 촬영</strong><span>방향 {capture.source.heading===undefined?'미제공':`${Math.round(capture.source.heading)}°`}{capture.source.tilt!==undefined?` · 기울기 ${capture.source.tilt}° (아래 +)`:''}{capture.source.fov!==undefined?` · 실제 FOV ${capture.source.fov}°`:''}</span><span>대상 지점과 촬영 위치 차이 {Math.round(capture.source.distance)}m</span>{naverPanoramaPose(capture.source)&&<button type="button" className="roadview-open-btn" onClick={()=>onOpen(capture.source)}><Eye size={13}/> 이 사진 위치 360° 거리뷰</button>}<a href={capture.source.url} target="_blank" rel="noreferrer">촬영 위치 원본 (별도 보기) <ExternalLink size={11}/></a>{capture.source.provider==='naver'&&<span>© NAVER Corp.</span>}{kartaview&&<span>© Grab and KartaView Contributors · <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer">CC BY-SA 4.0</a></span>}</figcaption>
 </figure>;
}
function CaptureGallery({captures,processing,onOpen}:{captures:CapturePreview[];processing:boolean;onOpen(source:CapturePreview['source']):void}){
 return <section className="capture-gallery" aria-label="판독용 실제 이미지"><h4>판독용 실제 이미지 · {captures.length}장</h4><p className="capture-disclaimer">판독에 사용한 촬영 당시 이미지입니다. 판독 중·실패·중단 여부는 별도로 표시하며, 현재 현장 사진은 아닙니다. 360° 보기는 보관된 판독 사진을 바꾸지 않습니다.</p>{captures.map(capture=><CaptureFrame key={capture.id} capture={capture} processing={processing} onOpen={onOpen}/>)}</section>;
}
export default function RouteDetails({route,goal,evidence,captures,phase,activeId,decision,gradeThreshold=8,onBack,onLocate}:Props){
 const [showAll,setShowAll]=useState(false),[activeRoadview,setActiveRoadview]=useState<NonNullable<Evidence['source']>|null>(null);
 const heading=useRef<HTMLHeadingElement>(null),rows=useRef(new Map<string,HTMLElement>()),issueRows=useRef(new Map<string,HTMLElement>());
 const samples=[...route.samples].sort((a,b)=>a.along-b.along);
 const providerRestriction=hasOnlyProviderBarriers(decision);
 const routeCaptures=captures.filter(capture=>capture.evidenceId.startsWith(route.id+':'));
 const capturesByPoint=new Map<string,CapturePreview[]>();
 for(const capture of routeCaptures){
  const group=capturesByPoint.get(capture.evidenceId);
  if(group)group.push(capture);else capturesByPoint.set(capture.evidenceId,[capture]);
 }
 const readings=samples.filter(sample=>{const item=evidence[route.id+':'+sample.id];return item?.stage!=='reserved'&&!item?.failure&&item?.finding&&item.source;});
 const working=samples.filter(sample=>{
  const id=route.id+':'+sample.id,item=evidence[id];
  return phase==='running'&&(item?.stage==='reserved'||item?.review?.state==='reserved'&&!item.review.failure||capturesByPoint.has(id)&&!item?.finding&&!item?.failure);
 });
 const workingIds=new Set(working.map(sample=>route.id+':'+sample.id));
 const available=samples.filter(sample=>{const id=route.id+':'+sample.id;return capturesByPoint.has(id)||!!evidence[id]&&evidence[id].stage!=='reserved'||decision.issues.some(issue=>issue.sampleId===sample.id&&issue.source==='provider');});
 const visible=(showAll?samples:available).filter(sample=>!workingIds.has(route.id+':'+sample.id));
 const important=decision.issues.filter(issue=>issue.status!=='clear'&&(phase!=='running'||issue.source!=='coverage'||!!evidence[issue.id]&&evidence[issue.id].stage!=='reserved'));
 const keyIssues=important.filter(issue=>issue.status==='blocked'||issue.source==='provider'||issue.source==='geometry'||issue.source==='osm'||samples.some(sample=>sample.id===issue.sampleId&&sample.critical));
 const otherIssues=important.filter(issue=>!keyIssues.includes(issue));
 const firstIssues=[...keyIssues,...otherIssues.slice(0,3)],remainingIssues=otherIssues.slice(3);
 useEffect(()=>{heading.current?.focus({preventScroll:true});},[]);
 useEffect(()=>{if(activeId)setShowAll(true);},[activeId]);
 useEffect(()=>{if(!activeId||!showAll)return;const target=rows.current.get(activeId)??issueRows.current.get(activeId);const disclosure=target?.closest('details');if(disclosure)disclosure.open=true;target?.scrollIntoView({block:'nearest'});target?.focus({preventScroll:true});},[activeId,showAll]);
 if(route.graphSegment){
  const segment=route.graphSegment;
  return <section className="route-details" aria-label="지도에 연결된 일부 구간">
   <header className="detail-header"><button className="detail-back" onClick={onBack}><ArrowLeft size={17}/> 경로 목록으로</button><div className="detail-title"><h2 ref={heading} tabIndex={-1}>지도에 연결된 일부 구간</h2><span>지도 선형 {(route.distance/1000).toFixed(2)}km</span></div><p>출발지와 목적지까지 연결된 경로가 아닙니다.</p></header>
   <div className="detail-body" tabIndex={0} role="region" aria-label="일부 지도 구간 정보">
    <section className="route-action kind-hold"><h3>이 구간은 길안내로 사용할 수 없어요</h3><p>지도에 기록된 선형만 표시합니다. 장애물 회피, 영상 판독과 실제 통행 여부는 확인하지 않았어요.</p></section>
   <GraphCoverage coverage={route.graphCoverage} partial/>
    <section className="detail-search"><h3>양 끝의 연결이 빠져 있어요</h3><p>출발지와 지도 선형 사이 직선거리 약 {Math.round(segment.startGapMeters)}m · 선형과 목적지 사이 직선거리 약 {Math.round(segment.endGapMeters)}m</p><p>이 수치는 걸을 수 있는 거리나 연결 경로가 아닙니다. 지도에도 빈 구간을 선으로 잇지 않습니다.</p>{segment.sharedRoadMeters>0&&<p>약 {Math.round(segment.sharedRoadMeters)}m는 차도와 보도가 따로 구분되지 않은 도로입니다.</p>}<span>지도 데이터 복제 시각 {segment.snapshotAt.slice(0,10)} · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap 기여자 · ODbL</a></span></section>
   </div>
  </section>;
 }
 function renderPoint(sample:Sample){
  const id=route.id+':'+sample.id,item=evidence[id],finding=item?.stage==='reserved'?undefined:item?.finding,issue=decision.issues.find(point=>point.sampleId===sample.id);
  const pointCaptures=capturesByPoint.get(id)??[],processing=workingIds.has(id),guidance=nearestGuidance(route,sample.coord);
  const modelFailed=item?.failure==='analysis'||item?.review?.failure==='analysis';
  const processingText=modelFailed?(pointCaptures.length?'영상 확보 · 모델 판독 실패':'모델 판독 실패 · 제출 이미지 미보관'):processing?(pointCaptures.length?'영상 확보 · 판독 중':'영상 확보 대기'):item?.failure==='capture'||item?.review?.failure==='capture'?'영상 확보 실패':item?.failure==='service'||item?.review?.failure==='service'?'처리 서비스 실패':item?.stage==='reserved'?'판독 미완료 · 처리 종료':pointCaptures.length?(finding?'제출 영상 보관 중':'영상 확보 · 판독 결과 없음'):null;
  const source=item?.source??pointCaptures[pointCaptures.length-1]?.source;
  return <li key={id} tabIndex={-1} ref={element=>{if(element)rows.current.set(id,element);else rows.current.delete(id);}} className={'detail-point '+(processing?'is-processing ':'')+(activeId===id?'focused':'')}>
   <div className="detail-point-heading"><span className="detail-point-distance">{Math.round(sample.along)}<small>m 지점</small></span><span className={'detail-status '+(issue?.source==='provider'&&issue.status==='blocked'?'provider':issue?.status??'unknown')}>{processing?'영상 확인 중':issue?.source==='provider'&&issue.status==='blocked'?'길찾기의 계단 안내':issue?statusLabels[issue.status]:'미판독'}</span></div>
   {guidance&&<p className="point-guidance">가장 가까운 지도 안내 · {guidance}</p>}
   <p className="detail-reason">{issue?.reason??item?.reason??'아직 관찰 결과가 없습니다.'}</p>{issue?.action&&<p className="point-next-action">{issue.action}</p>}
   {issue?.source==='provider'&&<p className="provider-evidence-note">길찾기가 반환한 이동 안내입니다. 사진을 보고 계단을 확인했다는 뜻이 아닙니다. 이 지점의 영상 판독은 아래에서 별도로 표시합니다.</p>}
   {processingText&&<p className={'capture-status'+(processing?' processing':'')+(modelFailed?' failed':'')} role={processing?'status':undefined}>{processingText}</p>}
   {pointCaptures.length?<CaptureGallery captures={pointCaptures} processing={processing} onOpen={setActiveRoadview}/>:<p className="capture-unavailable">{processing?'아직 모델에 제출할 화면을 확보하지 못했습니다. 확보되면 판독 완료 전에도 여기에 표시됩니다.':issue?.source==='provider'?'지도 정보만 있으며 이 지점에 보관된 제출 이미지는 없습니다.':finding||source?'이전 관찰의 제출 이미지는 보관되어 있지 않습니다. 아래 거리뷰는 당시 제출 화면을 대신하지 않습니다.':'보관된 제출 이미지가 없습니다.'}</p>}
   {finding&&<><dl className="detail-features"><Feature label="계단" observation={finding.features?.stairs}/><Feature label="경사로·경사 모습" observation={finding.features?.incline}/></dl>{finding.observation&&<div className="detail-evidence"><h4>목표 연결부 관찰</h4><p>{describeFinding(finding)}</p>{finding.observation.uncertainty!=='none'&&<p>AI 설명 · 사진과 함께 확인: {finding.observation.reason}</p>}</div>}<details className="detail-limitations"><summary>AI 원본 설명 보기 · 검증되지 않음</summary><p>AI가 작성한 설명은 틀릴 수 있습니다. 특히 폭이나 개인의 통과 가능 여부는 이 서비스의 판정 범위가 아닙니다. 보관된 사진과 함께 확인하세요.</p><p>{finding.reason}</p>{finding.observation&&<p>{finding.observation.reason}</p>}{finding.features&&<><p>계단: {finding.features.stairs.reason}</p><p>경사 모습: {finding.features.incline.reason}</p></>}{!!finding.evidence.length&&<ul>{finding.evidence.map((text,index)=><li key={index}>{text}</li>)}</ul>}{!!finding.limitations.length&&<ul>{finding.limitations.map((text,index)=><li key={index}>{text}</li>)}</ul>}</details></>}
   {item?.review&&<section className="detail-evidence" aria-label="연결부 재확인"><h4>{item.review.reason==='framing'?'시선 회전':'촬영 위치 변경'} 재확인 · {item.review.state==='complete'?'처리 종료':phase!=='running'?'미완료 · 처리 종료':item.review.state==='reserved'?'진행 중':'대기'}</h4><p>{item.review.note}</p>{item.review.sources.map(view=><p key={view.id}><a href={view.source.url} target="_blank" rel="noreferrer">{sourceName(view.source)} · {view.id} · 촬영 {captureDate(view.source)}</a>{naverPanoramaPose(view.source)&&<button type="button" className="roadview-open-btn" onClick={()=>setActiveRoadview(view.source)}>이 재확인 사진 위치 360°</button>}{item.review?.supportIds.includes(view.id)?' · 목표 판독 근거':''}</p>)}</section>}
   {source&&<div className="detail-source"><span>{sourceName(source)} 촬영 {captureDate(source)} · 현재 상태 아님</span>{naverPanoramaPose(source)&&<button type="button" className="roadview-open-btn" onClick={()=>setActiveRoadview(source)}><Eye size={13}/> 관찰 위치 360° 거리뷰 (별도)</button>}<a href={source.url} target="_blank" rel="noreferrer">촬영 위치 원본 <ExternalLink size={12}/></a></div>}<button className="detail-locate" onClick={()=>onLocate(issue?.id??id,issue?.coord??sample.coord)}><MapPin size={14}/> 지도에서 위치 보기 <ChevronRight size={14}/></button>
  </li>;
 }
 function renderIssue(issue:RouteIssue){
    const guidance=nearestGuidance(route,issue.coord),sample=samples.find(point=>point.id===issue.sampleId);
    return <button type="button" key={issue.id} ref={element=>{if(element)issueRows.current.set(issue.id,element);else issueRows.current.delete(issue.id);}} className={'action-issue issue-'+issue.status+(issue.source==='provider'&&issue.status==='blocked'?' provider-restriction':'')+(activeId===issue.id?' focused':'')} onClick={()=>{onLocate(issue.id,issue.coord);if(sample){setShowAll(true);rows.current.get(route.id+':'+sample.id)?.scrollIntoView({block:'nearest'});}}}><span><b>출발 후 {Math.round(issue.along)}m · {issue.source==='provider'&&issue.status==='blocked'?'길찾기의 “계단이용” 안내':statusLabels[issue.status]}</b><strong>{issue.action}</strong>{guidance&&<span className="point-guidance">가장 가까운 지도 안내 원문 · {guidance}</span>}<small>{sourceLabels[issue.source]}</small><span>{issue.reason}</span>{issue.source==='provider'&&<span className="provider-evidence-note">길찾기 API가 반환한 정보이며, 사진으로 확인한 내용이 아닙니다.</span>}<span>{sample?'지도 위치와 해당 지점의 관찰 근거 보기':'지도에서 위치 보기 · 다른 관찰 지점은 아래에서 확인'}</span></span><MapPin size={16}/></button>;
 }
 return <section className="route-details" aria-label={route.name+' 상세 보기'}>
  <header className="detail-header"><button className="detail-back" onClick={onBack}><ArrowLeft size={17}/> 경로 목록으로</button><div className="detail-title"><h2 ref={heading} tabIndex={-1}>{route.name} 상세</h2><span>도보 기준 {Math.ceil(route.seconds/60)}분 · {(route.distance/1000).toFixed(2)}km</span></div><p>{goal==='entrance'?'목표 건물 출입구 연결까지 확인합니다.':'지도 도착 지점까지입니다. 건물 출입구 진입은 확인하지 않습니다.'}</p></header>
  <div className="detail-body" tabIndex={0} role="region" aria-label="경로 상세 판독 결과">
   <section className={'route-action kind-'+decision.kind+(providerRestriction?' provider-restriction':'')} aria-label="이 경로의 안내 결정"><h3>{providerRestriction?(decision.issues.some(issue=>issue.status==='blocked'&&issue.sampleId.startsWith('shared-'))?'다른 후보의 계단 안내 통로와 겹쳐 추천에서 제외했어요':'길찾기에 계단 안내가 있어 추천에서 제외했어요'):actionLabels[decision.kind]}</h3><strong>{decision.action}</strong><p className="decision-concrete-reason">{decision.reason}</p>{route.detourReason&&<p>{route.detourReason}</p>}</section>
   <GraphCoverage coverage={route.graphCoverage}/>
   {route.crossingSources?.map(source=><section className="detail-search" key={source.along}><h3>출발 후 {Math.round(source.along)}m · 횡단보도 {source.wayIds.length}곳의 지도 위치</h3><p>공개 보행망의 연결 관계와 지도 경로를 대조해 진입·진출 지점을 나눴어요. 지도 위치는 통행 가능 판정이 아니며, 각 지점의 영상 판독 결과는 아래에 표시합니다.</p><span>지도 데이터 복제 시각 {source.snapshotAt.slice(0,10)} · 개별 시설 조사일 미상 · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap 기여자 · ODbL</a></span></section>)}
   {!!important.length&&<section className="action-issues" aria-label="행동이 필요한 위치"><h3>어디를 확인하거나 피해야 하나요?</h3>{firstIssues.map(renderIssue)}{!!remainingIssues.length&&<details className="remaining-issues"><summary>나머지 확인할 위치 {remainingIssues.length}곳 보기</summary>{remainingIssues.map(renderIssue)}</details>}</section>}
   {!!working.length&&<section className="current-analysis" aria-label="현재 영상 처리"><h3>현재 영상 처리</h3><p>판독 결과가 나오기 전에도 실제 제출 화면을 확인할 수 있어요.</p><ol className="detail-timeline">{working.map(renderPoint)}</ol></section>}
   <details className={'detail-search state-'+decision.exploration.state}><summary>{decision.exploration.state==='searching'?'우회 경로 탐색 중':decision.exploration.state==='finished'?'우회 경로 탐색 결과':'우회 경로 탐색 중단'} · 탐색 {decision.exploration.attempts}회 · 대안 {decision.exploration.alternatives}개</summary>{decision.exploration.reason!==decision.action&&decision.exploration.reason!==decision.reason&&<p>{decision.exploration.reason}</p>}{decision.exploration.state==='finished'&&decision.exploration.alternatives===0&&(decision.kind==='hold'||decision.kind==='detour')&&<p>확인이 필요한 지점의 지도 위치와 관찰 근거를 살펴보세요. 경로 목록에서 목적지나 도착 범위를 바꿔 다시 비교할 수도 있습니다. 이 확인만으로 실제 접근 가능 여부를 보장할 수는 없습니다.</p>}</details>
   <div className="detail-list-heading"><h3>제출 영상과 관찰 근거</h3><span>출발 → 도착</span></div><div className="detail-tabs" role="group" aria-label="표시할 지점"><button aria-pressed={!showAll} onClick={()=>setShowAll(false)}>영상·처리 지점 {available.length}</button><button aria-pressed={showAll} onClick={()=>setShowAll(true)}>전체 확인 지점 {samples.length}</button></div>
   {!visible.length&&!working.length&&<div className="detail-empty"><MapPin size={24}/><p>{phase==='running'?'아직 확보된 제출 영상이 없습니다. 영상 확보와 모델 판독은 별도 단계로 표시됩니다.':'보관된 제출 영상과 완료된 관찰이 없습니다. 위 안내 결정과 처리 상태를 확인하세요.'}</p></div>}
   <ol className="detail-timeline">{visible.map(renderPoint)}</ol>
   <section className="detail-overview"><div className="detail-coverage"><Accessibility size={18}/><strong>영상 판독 결과 {readings.length}<span> / {samples.length} 지점</span></strong></div><progress value={readings.length} max={Math.max(1,samples.length)} aria-label="영상 판독 결과가 있는 지점"/><p className="detail-caption">실제 제출 이미지 {routeCaptures.length}장 · 판독 중인 영상은 결과 수와 별도로 표시합니다. 처리 실패와 미분석은 통행 장애로 세지 않아요. 관찰 지점 사이와 현재 현장 상태까지 보장하지 않아요.</p></section>
   <RouteTerrain route={route} threshold={gradeThreshold} onLocate={coord=>onLocate('',coord)}/>
  </div>{activeRoadview&&<PanoramaModal source={activeRoadview} onClose={()=>setActiveRoadview(null)}/>}
 </section>;
}
