import {orderByRoutePreference} from '../lib/route-grade.ts';
import {evaluateRoute,type Evidence,type Route,type RouteAssessments,type RouteDecision,type RouteIssue} from '../lib/domain.ts';
import type {CapturePreview} from '../lib/capture-contract.ts';
import type {JourneySnapshotResponse} from '../lib/requests.ts';

export type AnalysisPhase=JourneySnapshotResponse['phase'];
export type GradeSelection={routeId:string;index:number};
export type RouteAnalysisStatus={
    kind:'recommended'|'conditional'|'blocked'|'partial'|'required'|'error'|'analyzing'|'pending'|'incomplete';
    label:string;
    detail:string;
};

function snapshotRecord(value:unknown):value is Record<string,unknown>{
    return value!==null&&typeof value==='object';
}
function equalSnapshotValue(left:unknown,right:unknown):boolean{
    if(left===right)return true;
    if(Array.isArray(left)){
        if(!Array.isArray(right)||left.length!==right.length)return false;
        for(let index=0;index<left.length;index++)if(!equalSnapshotValue(left[index],right[index]))return false;
        return true;
    }
    if(Array.isArray(right)||!snapshotRecord(left)||!snapshotRecord(right))return false;
    for(const key in left)if(Object.hasOwn(left,key)&&(!Object.hasOwn(right,key)||!equalSnapshotValue(left[key],right[key])))return false;
    for(const key in right)if(Object.hasOwn(right,key)&&!Object.hasOwn(left,key))return false;
    return true;
}
export function sameJourneySnapshot(previous:JourneySnapshotResponse|undefined,current:JourneySnapshotResponse):boolean{
    return equalSnapshotValue(previous,current);
}

function requiredIssue(route:Route,issue:RouteIssue){
    const sample=route.samples.find(point=>point.id===issue.sampleId);
    return !sample||sample.critical||sample.target==='crossing-entry'||sample.target==='crossing-exit'||sample.target==='entrance'||sample.target==='arrival';
}

function independentConnection(route:Route,issue:RouteIssue){
    return !!route.unverifiedConnections?.some(point=>point.id===issue.sampleId)||!!route.unresolvedCrossings?.some(point=>point.id===issue.sampleId);
}

export function routeAnalysisStatus({route,decision,evidence,phase}:{route:Route;decision:RouteDecision|undefined;evidence:Record<string,Evidence>;phase:AnalysisPhase}):RouteAnalysisStatus{
    if(route.graphSegment)return {kind:'partial',label:'일부 지도 구간',detail:'출발지와 목적지까지 이어지는 경로가 아니에요.'};
    if(decision?.kind==='detour'||decision?.issues.some(issue=>issue.status==='blocked'))return {kind:'blocked',label:'계단·통행 제한',detail:decision.reason};
    if(decision?.kind==='recommended')return {kind:'recommended',label:'영상 기준 추천',detail:decision.reason+' 현재 현장과 표본 사이 구간의 안전을 보장하지는 않아요.'};
    const items=Object.entries(evidence).filter(([id,item])=>id===route.id+':'+item.sampleId);
    if(items.some(([,item])=>item.failure&&item.failure!=='missing'||item.review?.failure))return {kind:'error',label:'사진 확인 오류',detail:'영상 확보 또는 판독을 마치지 못했어요. 현장의 통행 장애가 확인됐다는 뜻은 아니에요.'};
    if(route.graphCoverage?.status==='unavailable')return {kind:'incomplete',label:'지도 연결 자료 부족',detail:decision?.reason??'보행망 자료를 확보하지 못해 횡단 연결을 대조하지 못했어요.'};
    const unknowns=decision?.issues.filter(issue=>issue.status==='unknown'&&requiredIssue(route,issue))??[];
    const unresolved=(decision?.issues??[]).filter(issue=>{
        if(issue.status!=='unknown')return false;
        const item=evidence[issue.id];
        return independentConnection(route,issue)||requiredIssue(route,issue)&&phase!=='running'||!!item&&item.stage!=='reserved'&&item.review?.state!=='reserved';
    });
    if(unresolved.length)return {kind:'required',label:'사진 일부 미확인',detail:`이 후보의 연결 사진 ${unresolved.length}곳을 확인하지 못했어요. ${decision?.reason??''}`.trim()};
    if(decision?.kind==='conditional')return {kind:'conditional',label:'조건부 비교',detail:decision.reason};
    if(phase==='running'){
        if(items.some(([,item])=>item.stage==='reserved'||item.review?.state==='reserved'))return {kind:'analyzing',label:'사진 확인 중',detail:unknowns.length?`이 후보에서 남은 연결 사진 ${unknowns.length}곳을 확인하고 있어요.`:'이 후보의 사진 관찰을 진행하고 있어요.'};
        return {kind:'pending',label:'사진 확인 대기',detail:decision?.reason??'이 후보의 남은 사진 관찰을 기다리고 있어요.'};
    }
    return {kind:'incomplete',label:'일부 정보 미확인',detail:decision?.reason??'이 후보의 판정 결과가 없어요.'};
}

export function analysisActivity({routes,evidence,captures,phase,selectedId,message}:{routes:Route[];evidence:Record<string,Evidence>;captures:CapturePreview[];phase:AnalysisPhase;selectedId:string;message?:string}):{title:string;detail:string;busy:boolean}{
    const selected=routes.find(route=>route.id===selectedId);
    let selectedDetail='';
    if(selected){
        const remaining=evaluateRoute(selected,evidence).issues.filter(issue=>issue.status==='unknown'&&requiredIssue(selected,issue)).length;
        const scope=selected.graphSegment?'출발·도착 연결 미확인':selected.graphCoverage?.status==='unavailable'?'지도 연결 자료 부족':!selected.samples.length?'관찰 지점 자료 없음':remaining?`연결 사진 ${remaining}곳 미확인`:'판독 결과 확인';
        selectedDetail=`선택 ‘${selected.name}’ · ${scope}`;
    }
    if(phase!=='running'){
        const creditFailure=(phase==='limited'||phase==='failed')&&/크레딧이 부족|\bHTTP\s*402\b/.test(message??'');
        const title=creditFailure?'사진 분석 크레딧이 부족해요':phase==='canceled'?'추가 분석을 중지했어요':phase==='failed'?'분석을 마치지 못했어요':phase==='limited'?'이번 분석에 미확인 항목이 남았어요':'이번 분석이 종료됐어요';
        const observations=Object.values(evidence).filter(item=>item.stage!=='reserved'&&item.finding&&item.source).length;
        const received=captures.length||observations?`사진 ${captures.length}장 · 판독 ${observations}곳 보관`:'받은 결과 없음';
        const action=creditFailure?'분석 서비스의 크레딧·결제 상태를 확인한 뒤 다시 경로를 찾아 주세요.':'';
        return {title,detail:[action,received,selectedDetail].filter(Boolean).join('\n'),busy:false};
    }
    const active=Object.entries(evidence).flatMap(([id,item])=>{
        if(item.stage!=='reserved'&&item.review?.state!=='reserved')return [];
        const route=routes.find(candidate=>id===candidate.id+':'+item.sampleId);
        return route?[{id,item,route}]:[];
    });
    if(!active.length)return {title:'다음 확인 대상을 준비하고 있어요',detail:selectedDetail,busy:true};
    const reviewing=active.filter(point=>point.item.review?.state==='reserved');
    const initial=active.filter(point=>point.item.stage==='reserved'&&point.item.review?.state!=='reserved');
    const initialCaptured=initial.filter(point=>captures.some(capture=>capture.evidenceId===point.id&&capture.viewId==='initial')).length;
    const reviewCaptured=reviewing.filter(point=>captures.some(capture=>capture.evidenceId===point.id&&capture.viewId.startsWith('review-'))).length;
    let title='길 사진을 확보하고 있어요';
    if(reviewing.length&&initial.length)title='사진 확보·판독과 연결부 재확인을 진행하고 있어요';
    else if(reviewing.length){
        title=reviewCaptured===reviewing.length?'재확인 사진의 판독 결과를 기다리고 있어요':reviewCaptured?'재확인 사진을 확보하고 판독을 기다리고 있어요':'연결부를 다른 시선에서 재확인하고 있어요';
    }else if(initialCaptured===initial.length)title='확보한 사진의 판독 결과를 기다리고 있어요';
    else if(initialCaptured)title='사진을 확보하고 판독 결과를 기다리고 있어요';
    const locations=routes.flatMap(route=>{
        const points=active.filter(point=>point.route.id===route.id);
        if(!points.length)return [];
        const distances=points.flatMap(point=>{
            const location=route.samples.find(sample=>sample.id===point.item.sampleId)??route.barriers?.find(barrier=>barrier.sampleId===point.item.sampleId);
            return location?[Math.round(location.along)]:[];
        });
        const along=[...new Set(distances)].sort((a,b)=>a-b).map(distance=>`${distance}m`).join('·');
        return [`‘${route.name}’${along?` · 출발 후 ${along}`:''}`];
    }).join(' / ');
    const otherSelection=active.some(point=>point.route.id===selectedId)?'':selectedDetail;
    return {title,detail:[locations,otherSelection].filter(Boolean).join('\n'),busy:true};
}

export function routeSelectionReason(route:Route,routes:Route[],preference:'gentle'|'fast',explicitSelection:boolean):string{
    const prefix=explicitSelection?'직접 선택한 후보 · ':'';
    if(route.graphSegment)return prefix+'출발·도착까지 이어지지 않은 참고 구간이에요.';
    const peers=routes.filter(candidate=>candidate.id!==route.id&&!candidate.graphSegment);
    if(!peers.length)return prefix+'현재 표시된 이동 후보예요.';
    if(preference==='fast'){
        const minutes=Math.ceil(route.seconds/60);
        if(peers.some(candidate=>Math.ceil(candidate.seconds/60)===minutes))return prefix+'표시된 예상 시간이 비슷해 거리와 경사도 함께 비교하세요.';
        if(peers.every(candidate=>candidate.seconds>route.seconds))return prefix+'표시된 후보 중 예상 이동 시간이 가장 짧아요.';
        return prefix+'예상 이동 시간과 거리로 비교하는 후보예요.';
    }
    const grade=route.grade;
    if(!grade||grade.status==='unavailable')return prefix+'지형 경사 자료가 없어 예상 이동 시간으로 비교해요.';
    if(grade.status==='partial')return prefix+'일부 구간만 경사가 추정돼 완만함은 비교하지 않아요.';
    if(peers.some(candidate=>candidate.grade?.status==='available'&&candidate.grade.maxAbsPercent.toFixed(1)===grade.maxAbsPercent.toFixed(1)))return prefix+'표시된 최대 지형 경사가 비슷해 시간과 거리도 함께 비교하세요.';
    if(peers.some(candidate=>candidate.grade?.status!=='available'))return prefix+'전 구간 지형 추정값이 있어 경사 수치를 비교할 수 있어요.';
    if(peers.every(candidate=>candidate.grade?.status==='available'&&candidate.grade.maxAbsPercent>grade.maxAbsPercent))return prefix+'표시된 최대 지형 경사 추정값이 가장 작아요.';
    return prefix+'최대 지형 경사 추정값과 예상 이동 시간을 함께 비교하세요.';
}

export function routeAdmissionStatus(assessment:RouteAssessments[string]|undefined):{kind:'available'|'blocked'|'required'|'pending';label:string;detail:string}{
    const admission=assessment?.admission;
    if(!admission)return {kind:'pending',label:'경로 확인 대기',detail:'경로 안내 조건을 확인하고 있어요.'};
    switch(admission.kind){
        case 'available':return {kind:'available',label:assessment?.decision.issues.some(issue=>issue.status==='caution')?'길안내 가능 · 노면 주의':'길안내 가능',detail:admission.reason};
        case 'blocked':return {kind:'blocked',label:admission.cause==='disconnected'?'일부 지도 구간':'계단·통행 제한',detail:admission.reason};
        case 'requires-check':return {kind:'required',label:admission.cause==='structure'?'시설 연결 확인 필요':'요청한 경사 기준 미확인',detail:admission.reason};
    }
}
export function routeGuideBlocked(assessment:RouteAssessments[string]|undefined){
    return assessment?.admission?.kind!=='available';
}

export function customerRouteIssues(route:Route,issues:RouteIssue[],evidence:Record<string,Evidence>){
    return issues.filter(issue=>{
        if(issue.status==='blocked'||issue.status==='caution')return true;
        if(issue.status!=='unknown'||!requiredIssue(route,issue))return false;
        const crossing=route.unresolvedCrossings?.find(point=>point.id===issue.sampleId);
        if(crossing?.count===1&&crossing.source!=='osm'&&issues.some(observed=>observed.status==='clear'&&observed.source==='imagery'&&route.samples.some(sample=>sample.id===observed.sampleId&&sample.target==='crossing-entry'&&sample.along===crossing.along&&sample.coord[0]===crossing.coord[0]&&sample.coord[1]===crossing.coord[1])))return false;
        if(independentConnection(route,issue))return true;
        const item=evidence[issue.id];
        return !!item&&(!!item.failure||!!item.finding||!!item.review?.failure)&&item.stage!=='reserved';
    });
}

export function routeIssueTitle(route:Route,issue:RouteIssue){
    if(issue.status==='blocked')return issue.source==='provider'?'길찾기에 계단 안내가 있어요':issue.source==='osm'?'지도에 계단·출입 제한이 있어요':'사진에 계단·턱이 보여요';
    if(issue.status==='caution')return '고르지 않은 노면에 주의하세요';
    const connection=route.unverifiedConnections?.find(item=>item.id===issue.sampleId);
    if(connection)return connection.kind==='elevator'?'엘리베이터 연결을 확인하세요':connection.kind==='underpass'?'지하통로 연결을 확인하세요':'역 출입구 연결을 확인하세요';
    const sample=route.samples.find(point=>point.id===issue.sampleId);
    if(route.unresolvedCrossings?.some(point=>point.id===issue.sampleId)||sample?.target==='crossing-entry'||sample?.target==='crossing-exit')return '횡단 연결부를 확인하세요';
    if(sample?.target==='entrance')return '건물 출입구 연결을 확인하세요';
    if(sample?.target==='arrival')return '도착 지점의 연결을 확인하세요';
    return '이 지점의 이동 통로를 확인하세요';
}

export function routeIssueAction(route:Route,issue:RouteIssue){
    if(issue.status==='blocked')return '이 지점을 피하는 다른 경로를 선택하세요.';
    if(issue.status==='caution')return '사진에서 노면 상태를 살펴보고 이동 부담을 비교하세요.';
    const connection=route.unverifiedConnections?.find(item=>item.id===issue.sampleId);
    if(connection)return connection.kind==='elevator'?'이용 가능한 엘리베이터와 운영 여부를 시설에 확인하세요.':connection.kind==='underpass'?'계단 없는 출입구와 엘리베이터 위치를 확인하세요.':'역의 계단 없는 출입구와 승강기 위치를 확인하세요.';
    return issue.action;
}


export function nameRouteCandidates(routes:Route[],assessments:RouteAssessments):Route[]{
    const complete=routes.filter(route=>!route.graphSegment);
    const shortest=[...complete].sort((a,b)=>a.distance-b.distance||a.seconds-b.seconds)[0];
    const gentle=orderByRoutePreference(complete.filter(route=>route.grade?.status==='available'&&!routeGuideBlocked(assessments[route.id])),'gentle')[0];
    let alternative=0;
    return routes.map(route=>({...route,name:route.id===gentle?.id?(route.id===shortest?.id?'최적 경로(완만한 길·최단)':'최적 경로(완만한 길)'):route.id===shortest?.id?'최단 경로':`다른 경로 ${++alternative}`}));
}
