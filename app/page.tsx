'use client';
import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import {ArrowUpDown,ArrowRight,ChevronRight,MapPin,Route as RouteIcon,Navigation,Accessibility,Check,Search,X,LoaderCircle,LocateFixed,PanelLeftClose,PanelLeftOpen,Eye} from 'lucide-react';
import MapView from './Map';
import RouteDetails from './RouteDetails';
import DestinationInfo from './DestinationInfo';
import TransitJourney from './TransitJourney';
import StationFacilityInfo from './StationFacilityInfo';
import type {Coord,Place,JourneyResult,JourneyGoal,RouteDecision} from '@/lib/domain';
import {hasOnlyProviderBarriers,rankRoutes} from '@/lib/domain';
import {journeySnapshotResponse,searchResponse,type JourneySnapshotResponse} from '@/lib/requests';
import type {CapturePreview} from '@/lib/capture-contract';
type ResultScreen = {
    kind: 'result';
    journey: JourneyResult;
    captures:CapturePreview[];
    analysis: {phase:'running'|'ready'|'limited'|'failed'|'canceled';checked:number;total:number;message?:string};
};
type Screen = {kind:'idle'} | {kind:'loading';message:string;previous:ResultScreen|null;previousSelected:string} | ResultScreen | {kind:'error';message:string};
type LocationField = 'start' | 'end';
type LocationSearch = {field:LocationField;kind:'loading'} | {field:LocationField;kind:'results';places:Place[]} | {field:LocationField;kind:'error';message:string};
const normalizedPlaceName = (value:string) => value.replace(/\s+/g,'').toLowerCase();
const decisionLabels:Record<RouteDecision['kind'],string>={recommended:'영상 기준 추천',conditional:'조건부 후보',detour:'우회 필요',hold:'추천 보류'};
function stopWaitingForResult(journey:JourneyResult,message:string):JourneyResult{
    const assessments=Object.fromEntries(Object.entries(journey.assessments).map(([id,assessment])=>{
        const decision=assessment.decision;
        if(decision.exploration.state!=='searching')return [id,assessment];
        const issues=decision.issues.map(issue=>{
            if(issue.status!=='unknown')return issue;
            const item=journey.evidence[issue.id];
            const unfinished=issue.source==='coverage'&&!item?.failure&&(!item||item.stage==='reserved');
            return unfinished?{...issue,reason:item?'판독을 마치기 전에 처리가 종료됐습니다.':'이 탐색에서 관찰하지 않은 지점입니다.',action:'이 지점의 연결부를 확인하거나 다른 후보를 비교하세요.'}:issue;
        });
        return [id,{...assessment,decision:{...decision,issues,action:decision.kind==='hold'||decision.kind==='detour'?message:decision.action,exploration:{...decision.exploration,state:'interrupted' as const,reason:message}}}];
    }));
    return {...journey,assessments};
}
export default function Page() {
    const [screen,setScreen]=useState<Screen>({kind:'idle'}),[profile,setProfile]=useState('수동 휠체어');
    const [goal,setGoal]=useState<JourneyGoal>('arrival');
    const [imageryProvider,setImageryProvider]=useState<'configured'|'kartaview'>('configured');
    const [from, setFrom] = useState('수원시 영통구 영통동 992-1'), [to, setTo] = useState('경희대학교 국제캠퍼스 학생회관');
    const [start, setStart] = useState<Place | null>(null), [end, setEnd] = useState<Place | null>(null);
    const [locationSearch,setLocationSearch]=useState<LocationSearch|null>(null),[focusedField,setFocusedField]=useState<LocationField|null>(null),[highlighted,setHighlighted]=useState(-1);
    const [editingSearch,setEditingSearch]=useState(false),[mapNotice,setMapNotice]=useState('');
    const locationRequest=useRef<AbortController|null>(null);
    const searchTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
    const [selected, setSelected] = useState(''), [active, setActive] = useState(''), [focus, setFocus] = useState<Coord | null>(null), [pick, setPick] = useState<'start' | 'end' | null>(null), [collapsed, setCollapsed] = useState(false), [nav, setNav] = useState<'guide'|'preview'|null>(null), [step, setStep] = useState(0);
    const [detailRouteId,setDetailRouteId]=useState<string|null>(null);
    const [consent,setConsent]=useState('');
    const listScroll=useRef<HTMLDivElement>(null);
    const listPosition=useRef(0);
    const detailButtons=useRef(new Map<string,HTMLButtonElement>());
    const returnToRoute=useRef<string|null>(null);
    const stoppedNotice=useRef<HTMLDivElement>(null),focusStoppedNotice=useRef(false);
    const resultsHeading=useRef<HTMLHeadingElement>(null),focusResults=useRef(false);
    const errorNotice=useRef<HTMLDivElement>(null),focusErrorNotice=useRef(false);
    const explicitRouteSelection=useRef(false),locateButton=useRef<HTMLButtonElement>(null);
    useEffect(()=>{if(detailRouteId||!returnToRoute.current)return;if(listScroll.current)listScroll.current.scrollTop=listPosition.current;detailButtons.current.get(returnToRoute.current)?.focus({preventScroll:true});returnToRoute.current=null;},[detailRouteId]);
    const request = useRef<{
        generation: number;
        controller: AbortController | null;
        jobId: string | null;
    }>({ generation: 0, controller: null, jobId:null });
    useEffect(() => () => {stopJob();locationRequest.current?.abort();}, []);
    useEffect(()=>{if(!focusedField)return;const query=focusedField==='start'?from:to;const place=focusedField==='start'?start:end;if(place)return;searchTimer.current=setTimeout(()=>void find(focusedField,query),300);return()=>{if(searchTimer.current)clearTimeout(searchTimer.current);};},[focusedField,from,to,start,end]);
    useEffect(()=>{if(highlighted<0||locationSearch?.kind!=='results')return;const id=(locationSearch.field==='start'?'from':'to')+'-option-'+highlighted;document.getElementById(id)?.scrollIntoView({block:'nearest'});},[highlighted,locationSearch]);
    useEffect(()=>{if(screen.kind==='result'&&screen.analysis.phase==='canceled'&&focusStoppedNotice.current){focusStoppedNotice.current=false;stoppedNotice.current?.focus({preventScroll:true});}},[screen]);
    useEffect(()=>{if(screen.kind!=='result')return;focusErrorNotice.current=false;if(focusResults.current){const target=resultsHeading.current??document.querySelector<HTMLElement>('.route-details h2');if(target){focusResults.current=false;target.focus({preventScroll:true});}}},[screen]);
    useEffect(()=>{if(screen.kind==='error'&&focusErrorNotice.current){focusErrorNotice.current=false;errorNotice.current?.focus({preventScroll:true});}},[screen]);
    useEffect(()=>{
        if(screen.kind!=='result'||screen.analysis.phase==='running'||explicitRouteSelection.current)return;
        const {journey}=screen;
        const candidate=journey.recommendedId??rankRoutes(journey.routes,journey.evidence).find(route=>{
            const assessment=journey.assessments[route.id];
            return !route.graphSegment&&assessment?.decision.kind==='conditional'&&!assessment.blockedPassageIds.length&&!assessment.decision.issues.some(issue=>issue.status==='blocked');
        })?.id;
        if(candidate)setSelected(candidate);
    },[screen]);
    const journey = screen.kind === 'result' ? screen.journey : null, routes = journey?.routes ?? [], evidence = journey?.evidence ?? {}, route = routes.find(r => r.id === selected), analyzing = screen.kind === 'result' && screen.analysis.phase === 'running', busy = screen.kind === 'loading' || analyzing;
    const routeDecision=route?journey?.assessments[route.id]?.decision:undefined;
    const visibleIssues=(routeDecision?.issues??[]).filter(issue=>issue.status!=='clear'&&(!analyzing||issue.source!=='coverage'||!!evidence[issue.id]&&evidence[issue.id].stage!=='reserved'));
    const keyIssues=visibleIssues.filter(issue=>issue.status==='blocked'||issue.source==='provider'||issue.source==='geometry'||issue.source==='osm'||route?.samples.some(sample=>sample.id===issue.sampleId&&sample.critical));
    const otherIssues=visibleIssues.filter(issue=>!keyIssues.includes(issue));
    const firstIssues=[...keyIssues,...otherIssues.slice(0,3)];
    const remainingIssues=otherIssues.slice(3);
    function issueButtons(issues:RouteDecision['issues']){return issues.map(issue=>{const source=evidence[issue.id]?.source;return <button type="button" className="conditional-issue" key={issue.id} onClick={()=>inspectPoint(issue.id)}><b>출발 후 {Math.round(issue.along)}m · {issue.source==='provider'?'지도 길찾기 정보 · 영상 관찰 아님':issue.source==='geometry'?'선택 지점과 경로 좌표 비교 · 영상 관찰 아님':issue.source==='osm'?'OpenStreetMap 정보 · 영상 관찰 아님':issue.source==='imagery'?'거리영상 관찰':issue.source==='service'?'처리 실패':'영상 확인 상태'}</b>{source&&<span>거리영상 촬영 {source.capturedMonth??(source.capturedAt===null?'시점 미상':new Date(source.capturedAt).toLocaleDateString('ko-KR'))}</span>}<span>{issue.reason}</span><span>{issue.action}</span><span>지도 위치와 근거 보기</span></button>;});}
    function issueList(){return <>{issueButtons(firstIssues)}{!!remainingIssues.length&&<details className="remaining-issues"><summary>나머지 확인할 위치 {remainingIssues.length}곳 보기</summary>{issueButtons(remainingIssues)}</details>}</>;}
    const guideBlocked=!!route&&(!!route.graphSegment||(journey?.assessments[route.id]?.blockedPassageIds.length??0)>0||!!routeDecision?.issues.some(issue=>issue.status==='blocked'));
    const guideVerified=routeDecision?.kind==='recommended'&&!guideBlocked;
    const conditionalKey=route&&routeDecision?.kind==='conditional'&&!guideBlocked&&!analyzing?JSON.stringify([route.id,routeDecision]):'';
    const conditionalConfirmed=!!conditionalKey&&consent===conditionalKey;
    useEffect(()=>{setConsent('');},[conditionalKey]);
    const detailRoute=routes.find(candidate=>candidate.id===detailRouteId);
    const detailDecision=detailRoute?journey?.assessments[detailRoute.id]?.decision:undefined;
    function openDetails(id:string,pointId=''){explicitRouteSelection.current=true;if(id!==selected)setConsent('');if(!detailRouteId)listPosition.current=listScroll.current?.scrollTop??0;setSelected(id);setDetailRouteId(id);setActive(pointId);setNav(null);setStep(0);}
    function closeDetails(){returnToRoute.current=detailRouteId;setDetailRouteId(null);setActive('');}
    function inspectPoint(id:string){const candidate=routes.find(candidate=>journey?.assessments[candidate.id]?.decision?.issues.some(issue=>issue.id===id));if(candidate){openDetails(candidate.id,id);const point=journey?.assessments[candidate.id]?.decision?.issues.find(issue=>issue.id===id);if(point)setFocus(point.coord);}}
    function stopJob(){
        request.current.controller?.abort();const jobId=request.current.jobId;request.current.jobId=null;
        if(jobId)return fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'cancel',jobId}),keepalive:true}).then(async response=>response.ok?journeySnapshotResponse.parse(await response.json()):undefined).catch(()=>undefined);
    }
    function reset() { returnToRoute.current=null;setDetailRouteId(null);stopJob(); request.current.generation++; setScreen({ kind: 'idle' });setEditingSearch(false);setMapNotice(''); setSelected(''); setActive(''); setNav(null); setStep(0); setFocus(null); closeSearch(); }
    function begin(message:string){
        const previous=screen.kind==='result'?{...screen,journey:stopWaitingForResult(screen.journey,'새 검색을 시작하며 이전 분석을 중지했습니다.'),analysis:{...screen.analysis,phase:screen.analysis.phase==='running'?'canceled' as const:screen.analysis.phase}}:null;
        const previousSelected=selected;
        explicitRouteSelection.current=false;returnToRoute.current=null;setDetailRouteId(null);stopJob();const controller=new AbortController();request.current={generation:request.current.generation+1,controller,jobId:null};setScreen({kind:'loading',message,previous,previousSelected});setActive('');setNav(null);setStep(0);return {generation:request.current.generation,controller,previous,previousSelected};
    }
    function cancelLoading(){
        if(screen.kind!=='loading')return;
        if(screen.previous)focusResults.current=true;else focusErrorNotice.current=true;
        stopJob();request.current.generation++;
        if(screen.previous){explicitRouteSelection.current=true;setSelected(screen.previousSelected);setScreen({...screen.previous,analysis:{...screen.previous.analysis,message:'새 경로 검색을 중지했습니다. 이전 결과를 표시합니다.'}});}
        else setScreen({kind:'error',message:'경로 검색을 중지했습니다. 입력한 위치와 조건은 유지됩니다.'});
    }
    async function call(body:unknown,signal:AbortSignal):Promise<unknown>{
        let response:Response;
        try{response=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});}
        catch(error){if(signal.aborted)throw error;throw new Error('서버에 연결하지 못했습니다. 연결을 확인한 뒤 다시 경로를 찾아 주세요.');}
        const data:unknown=await response.json();
        if(!response.ok)throw new Error(data&&typeof data==='object'&&'error' in data&&typeof data.error==='string'?data.error:'길찾기 서비스를 완료하지 못했습니다.');
        return data;
    }
    function closeSearch(){if(searchTimer.current)clearTimeout(searchTimer.current);locationRequest.current?.abort();setLocationSearch(null);setFocusedField(null);setHighlighted(-1);}
    async function searchPlaces(query:string,signal:AbortSignal){
        const address=/\d/.test(query);
        const places=searchResponse.parse(await call({action:'search',query,address},signal)).places;
        return address&&!places.length?searchResponse.parse(await call({action:'search',query,address:false},signal)).places:places;
    }
    async function find(which:LocationField,query=which==='start'?from:to) {
        if(searchTimer.current)clearTimeout(searchTimer.current);
        locationRequest.current?.abort();
        setHighlighted(-1);
        if(query.trim().length<2){setLocationSearch(null);return;}
        const controller=new AbortController();locationRequest.current=controller;
        setLocationSearch({field:which,kind:'loading'});
        try{
            const places=await searchPlaces(query,controller.signal);
            if(controller.signal.aborted)return;
            setLocationSearch(places.length?{field:which,kind:'results',places}:{field:which,kind:'error',message:'검색 결과가 없어요. 다른 이름이나 주소를 입력해 주세요.'});
        }catch(error){if(!controller.signal.aborted)setLocationSearch({field:which,kind:'error',message:error instanceof Error?error.message:'장소를 찾지 못했어요.'});}
    }
    function choose(which:LocationField,place:Place) {
        reset();
        if(which==='start'){setStart(place);setFrom(place.name);}else{setEnd(place);setTo(place.name);}
        setPick(null);
    }
    function editLocation(which:LocationField,value:string){reset();setFocusedField(which);setPick(null);if(which==='start'){setFrom(value);setStart(null);}else{setTo(value);setEnd(null);}}
    function locationKey(event:KeyboardEvent<HTMLInputElement>,which:LocationField){
        if(event.nativeEvent.isComposing||event.keyCode===229)return;
        const places=locationSearch?.field===which&&locationSearch.kind==='results'?locationSearch.places:[];
        if(event.key==='Escape'){closeSearch();return;}
        if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setHighlighted(previous=>!places.length?-1:previous<0?(event.key==='ArrowDown'?0:places.length-1):(previous+(event.key==='ArrowDown'?1:-1)+places.length)%places.length);return;}
        if(event.key==='Enter'){event.preventDefault();if(places.length)choose(which,places[highlighted<0?0:highlighted]);else void find(which);}
    }
    function locationInput(which:LocationField){
        const field=which==='start'?'출발지':'도착지',id=which==='start'?'from':'to';
        const search=locationSearch?.field===which?locationSearch:null;
        return <div className="location-field" key={which}><div className="location-row"><span className={'location-dot '+which}/><label className="location-label" htmlFor={id}>{field}</label><input id={id} value={which==='start'?from:to} autoComplete="off" role="combobox" aria-autocomplete="list" aria-expanded={!!search} aria-controls={search?id+'-suggestions':undefined} aria-activedescendant={search?.kind==='results'&&highlighted>=0?id+'-option-'+highlighted:undefined} onFocus={()=>setFocusedField(which)} onChange={event=>editLocation(which,event.target.value)} onKeyDown={event=>locationKey(event,which)}/><button aria-label={field+' 검색'} onClick={()=>void find(which)}><Search size={18}/></button></div>
        {search&&<div className="search-results" id={id+'-suggestions'}><div className="result-heading">{field} 검색<button aria-label="검색 결과 닫기" onClick={closeSearch}><X size={16}/></button></div>{search.kind==='loading'?<p role="status">장소를 찾고 있어요</p>:search.kind==='error'?<p role="status">{search.message}</p>:<div role="listbox" aria-label={field+' 검색 결과'}>{search.places.map((place,index)=><button key={place.id} id={id+'-option-'+index} role="option" aria-selected={highlighted===index} className="place-result" onClick={()=>choose(which,place)}><MapPin size={17}/><span><b>{place.name}</b><small>{place.address}</small></span><ChevronRight size={16}/></button>)}</div>}</div>}</div>;
    }
    function point(coord: Coord) { if (!pick)
        return; const which = pick; reset(); const name = `${which === 'start' ? '선택한 출발지' : '선택한 도착지'} (${coord[1].toFixed(5)}, ${coord[0].toFixed(5)})`, place = { id: 'map-' + Date.now(), name, address: '지도에서 선택한 위치', coord }; if (which === 'start') {
        setStart(place);
        setFrom(name);
    }
    else {
        setEnd(place);
        setTo(name);
    } setPick(null); }
    async function findJourney() {
        focusResults.current=document.activeElement instanceof HTMLElement&&!!document.activeElement.closest('.search-section, .notice');
        closeSearch();
        const task = begin('출발지와 도착지를 확인하고 있어요');
        let displayedNewResult=false;
        try {
            const resolve=async(which:LocationField,selectedPlace:Place|null,query:string)=>{
                if(selectedPlace)return selectedPlace;
                if(query.trim().length<2)throw new Error('출발지와 도착지를 두 글자 이상 입력해 주세요.');
                const places=await searchPlaces(query,task.controller.signal);
                const exact=places.filter(place=>normalizedPlaceName(place.name)===normalizedPlaceName(query)||normalizedPlaceName(place.address)===normalizedPlaceName(query));
                const resolved=exact.length===1?exact[0]:places.length===1&&places[0].id.startsWith('address-')?places[0]:null;
                if(!resolved){
                    if(task.generation===request.current.generation){focusResults.current=false;if(task.previous){explicitRouteSelection.current=true;setSelected(task.previousSelected);setScreen(task.previous);setEditingSearch(true);}else setScreen({kind:'idle'});setLocationSearch(places.length?{field:which,kind:'results',places}:{field:which,kind:'error',message:'검색 결과가 없어요. 이름이나 주소를 수정해 주세요.'});document.getElementById(which==='start'?'from':'to')?.focus();setFocusedField(null);}
                    return null;
                }
                if(task.generation!==request.current.generation)return null;
                if(which==='start')setStart(resolved);else setEnd(resolved);
                return resolved;
            };
            const resolvedStart=await resolve('start',start,from);if(!resolvedStart)return;
            const resolvedEnd=await resolve('end',end,to);if(!resolvedEnd)return;
            if(task.generation!==request.current.generation)return;
            setScreen({kind:'loading',message:'이동 환경을 살펴보고 우회 경로를 찾고 있어요',previous:task.previous,previousSelected:task.previousSelected});
            let snapshot=journeySnapshotResponse.parse(await call({action:'journey',start:resolvedStart,end:resolvedEnd,profile,goal,imageryProvider},task.controller.signal));
            if (task.generation !== request.current.generation) return;
            request.current.jobId=snapshot.jobId;
            setEditingSearch(false);
            setSelected(snapshot.journey.recommendedId ?? snapshot.journey.routes[0]?.id ?? '');
            const display=(current:JourneySnapshotResponse)=>{
                if(task.generation!==request.current.generation||task.controller.signal.aborted)return;
                displayedNewResult=true;
                const {journey,phase,progress,captures}=current;
                setScreen({kind:'result',journey,captures,analysis:{phase,checked:progress.checked,total:progress.total,message:progress.notice}});
                if(journey.recommendedId&&phase==='ready'&&!explicitRouteSelection.current)setSelected(journey.recommendedId);
            };
            for (;;) {
                if(task.generation!==request.current.generation || task.controller.signal.aborted) return;
                display(snapshot);
                if(snapshot.phase!=='running'){request.current.jobId=null;break;}
                const pending=call({action:'advance',jobId:snapshot.jobId},task.controller.signal).then(
                    value=>({kind:'complete',value} satisfies {kind:'complete';value:unknown}),
                    (error:unknown)=>({kind:'error',error} satisfies {kind:'error';error:unknown}),
                );
                let settled=false;void pending.then(()=>{settled=true;});
                while(!settled){
                    const pause=Promise.withResolvers<void>();setTimeout(pause.resolve,1000);await pause.promise;
                    if(task.generation!==request.current.generation||task.controller.signal.aborted)return;
                    if(settled)break;
                    const statusController=new AbortController();
                    const status=call({action:'status',jobId:snapshot.jobId},AbortSignal.any([task.controller.signal,statusController.signal])).then(
                        value=>({kind:'status',value} satisfies {kind:'status';value:unknown}),
                        (error:unknown)=>({kind:'failed',error} satisfies {kind:'failed';error:unknown}),
                    );
                    const update=await Promise.race([status,pending.then(()=>({kind:'settled' as const}))]);
                    if(update.kind==='settled'){statusController.abort();break;}
                    if(update.kind==='failed'){
                        if(task.controller.signal.aborted)throw update.error;
                        setScreen(previous=>previous.kind==='result'&&previous.analysis.phase==='running'?{...previous,analysis:{...previous.analysis,message:'진행 상태를 잠시 확인하지 못했습니다. 진행 중인 분석 결과를 기다립니다.'}}:previous);
                    }else display(journeySnapshotResponse.parse(update.value));
                }
                const result=await pending;
                if(result.kind==='error')throw result.error;
                snapshot=journeySnapshotResponse.parse(result.value);
            }
        }
        catch (error) {
            if (task.generation !== request.current.generation || task.controller.signal.aborted)
                return;
            const canceled=stopJob();
            const message=error instanceof Error ? error.message : '길을 찾지 못했습니다.';
            if(task.previous){setEditingSearch(false);if(!displayedNewResult){explicitRouteSelection.current=true;setSelected(task.previousSelected);}}
            if(!task.previous)focusErrorNotice.current=true;
            setScreen(previous=>previous.kind==='result'?{...previous,journey:stopWaitingForResult(previous.journey,'요청 실패로 이 화면의 자동 진행과 상태 확인을 중단했습니다. 확보한 근거만 표시합니다.'),analysis:{...previous.analysis,phase:'failed',message}}:previous.kind==='loading'&&previous.previous?{...previous.previous,analysis:{...previous.previous.analysis,phase:'failed',message:'새 검색에 실패했습니다. 아래는 이전 결과입니다. '+message}}:{kind:'error',message});
            const current=await canceled;
            if(current&&task.generation===request.current.generation){const completed=current.phase==='ready'||current.phase==='limited';setScreen({kind:'result',journey:current.journey,captures:current.captures,analysis:{phase:completed?current.phase:'failed',checked:current.progress.checked,total:current.progress.total,message:completed?current.progress.notice:message}});}
        }
    }
    function selectRoute(id: string) { explicitRouteSelection.current=true;setConsent('');setSelected(id); setActive(''); setNav(null); setStep(0); setFocus(null); }
    return <main className="app">
 <nav className="rail" aria-label="주 메뉴"><a href="/" className="brand-icon" aria-label="길이음 홈"><RouteIcon size={26}/></a><button className="rail-item active"><Navigation size={22}/><span>길찾기</span></button><div className="rail-bottom"><Accessibility size={23}/><span>모두의 길</span></div></nav>
 <aside className={'sidebar ' + (collapsed ? 'collapsed' : '')+(detailRoute?' show-details':'')+(screen.kind==='result'?' has-results':'')+(editingSearch?' editing-search':'')}>
 <header className="sidebar-head"><div><h1>길이음<span className="beta">BETA</span></h1><p>나에게 맞는 길로, 일상을 잇다</p></div><button className="icon-button collapse" aria-label="검색 패널 접기" onClick={() => setCollapsed(true)}><PanelLeftClose size={20}/></button></header>
 {screen.kind==='result'&&!detailRoute&&<div className="results-controls"><button type="button" aria-expanded={editingSearch} onClick={()=>setEditingSearch(value=>!value)}>{editingSearch?'검색 조건 접기':'출발지·도착지 및 조건 변경'}</button></div>}
 {!detailRoute && <section className="search-section"><div className="mode-row"><span className="mode active"><Accessibility size={17}/> 편한 길찾기</span><span className="region">보행 · 이동 지원</span></div>
 <div className="locations" onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))closeSearch();}}>{locationInput('start')}{locationInput('end')}<button className="swap" aria-label="출발지와 도착지 바꾸기" onClick={() => { reset(); setFrom(to); setTo(from); setStart(end); setEnd(start); }}><ArrowUpDown size={16}/></button></div>
 <div className="pick-row"><button onClick={() => { reset(); setPick('start'); }}>출발지 지도에서 선택</button><button onClick={() => { reset(); setPick('end'); }}>도착지 지도에서 선택</button></div>
 <div className="profile-row"><label htmlFor="profile"><Accessibility size={17}/> 이동 수단</label><select id="profile" value={profile} onChange={event => { reset(); setProfile(event.target.value); }}>{['수동 휠체어', '전동 휠체어', '유아차', '보행 보조기'].map(value => <option key={value}>{value}</option>)}</select></div>
 <div className="profile-row"><label htmlFor="goal"><MapPin size={17}/> 도착 범위</label><select id="goal" value={goal} onChange={event=>{const value=event.target.value;if(value==='arrival'||value==='entrance'){reset();setGoal(value);}}}><option value="arrival">지도 도착 지점까지</option><option value="entrance">건물 출입구 진입까지 확인</option></select></div>
 <div className="profile-row"><label htmlFor="imagery"><Eye size={17}/> 거리 이미지</label><select id="imagery" value={imageryProvider} onChange={event=>{const value=event.target.value;if(value==='configured'||value==='kartaview'){reset();setImageryProvider(value);}}}><option value="configured">기존 설정</option><option value="kartaview">KartaView · 연구용</option></select></div>
 {imageryProvider==='kartaview'&&<p className="subnote">KartaView는 일부 지역의 과거 사진만 제공합니다. 사진이 없는 구간은 판독할 수 없으며, 서비스 제공 전 이용 허락 확인이 필요합니다.</p>}
 <p className="subnote">정밀 경사율은 미측정입니다. 사진에서 임의의 % 경사율을 만들지 않아요.</p>
 {end&&!journey&&<DestinationInfo place={end}/>}
 <button className="primary search-button" disabled={busy} onClick={findJourney}><RouteIcon size={19}/> 경로 찾기 <ArrowRight size={18}/></button>
 <div className="location-status">{start ? <><Check size={12}/> 출발지 선택</> : <>출발지 입력</>}<span>·</span>{end ? <><Check size={12}/> 도착지 선택</> : <>도착지 입력</>}</div></section>}
 {screen.kind === 'error' && <div ref={errorNotice} tabIndex={-1} className="notice" role="alert">{screen.message}</div>}
 {mapNotice&&<div className="notice" role="alert">{mapNotice}<button type="button" aria-label="위치 안내 닫기" onClick={()=>{setMapNotice('');locateButton.current?.focus({preventScroll:true});}}><X size={16}/></button></div>}
 {screen.kind==='result'&&analyzing&&<div className="progress" role="status"><LoaderCircle size={17} className="spin"/><span>판독 완료 {screen.analysis.checked} / {screen.analysis.total} 지점 · 확보 영상 {screen.captures.length}장{screen.analysis.message&&<><br/>{screen.analysis.message}</>}</span><button onClick={()=>{const generation=request.current.generation;focusStoppedNotice.current=true;void stopJob()?.then(current=>{if(current&&generation===request.current.generation){if(current.phase!=='canceled'){focusStoppedNotice.current=false;focusResults.current=true;}setScreen({kind:'result',journey:current.journey,captures:current.captures,analysis:{phase:current.phase,checked:current.progress.checked,total:current.progress.total,message:current.progress.notice}});}});setScreen({...screen,journey:stopWaitingForResult(screen.journey,'이 화면의 자동 진행을 중지했습니다. 확보한 사진과 관찰만 표시합니다.'),analysis:{...screen.analysis,phase:'canceled',message:'분석 중지를 요청했습니다. 확보한 결과만 표시합니다.'}});}}>중지</button></div>}
 {screen.kind === 'result' && screen.analysis.phase==='canceled' && <div ref={stoppedNotice} tabIndex={-1} className="notice" role="status">{screen.analysis.message??'분석이 중지됐습니다. 확보한 결과만 표시합니다.'}</div>}
 {screen.kind === 'result' && screen.analysis.phase==='limited' && screen.analysis.message && <div className="notice" role="status">{screen.analysis.message} <button type="button" onClick={findJourney}>같은 조건으로 다시 찾기</button>{detailRoute&&<button type="button" onClick={closeDetails}>다른 경로 비교</button>}</div>}
 {screen.kind === 'result' && screen.analysis.phase==='failed' && <div className="notice" role="alert">{screen.analysis.message ?? '이동 환경 분석을 완료하지 못했어요. 조회한 경로를 비교해 보세요.'} <button type="button" onClick={findJourney}>같은 조건으로 다시 찾기</button>{detailRoute&&<button type="button" onClick={closeDetails}>다른 경로 비교</button>}</div>}
 {screen.kind === 'loading' && <div className="progress" role="status"><LoaderCircle size={17} className="spin"/><span>{screen.message}</span><button type="button" onClick={cancelLoading}>검색 중지</button></div>}
 {detailRoute&&detailDecision&&screen.kind==='result'?<RouteDetails key={detailRoute.id} route={detailRoute} goal={screen.journey.goal} evidence={evidence} captures={screen.captures} phase={screen.analysis.phase} activeId={active} decision={detailDecision} onBack={closeDetails} onLocate={(id,coord)=>{setActive(id);setFocus(coord);}}/>:<div className="results-scroll" ref={listScroll}>{!journey?<section className="empty-state"><div className="eyebrow">오늘의 이동</div><h2>필요한 연결부를 확인하고,<br/>갈 수 있는 길을 비교해요.</h2><p>출발지와 도착지를 선택하면 실제 거리영상의 관찰 근거로 경로를 비교합니다.</p></section>:<section className="routes-section"><div className="section-title"><h2 ref={resultsHeading} tabIndex={-1}>이동 경로 <span>{routes.length}</span></h2></div>
 <p className="subnote">{journey.goal==='entrance'?'건물 출입구 연결까지 확인하는 탐색입니다.':'지도 도착 지점까지의 경로입니다. 건물 출입구 진입은 확인하지 않습니다.'}</p>
 {end&&<DestinationInfo place={end}/>}
 {start&&<StationFacilityInfo place={start}/>}
 {end&&<StationFacilityInfo place={end}/>}
 {start&&end&&<TransitJourney start={start} end={end}/>}
 {!journey.recommendedId&&!analyzing&&<div className="no-route-recommendation" role="status"><strong>현재 추천할 수 있는 경로를 찾지 못했어요.</strong><p>관찰 근거와 선택한 이동 조건으로 추천할 수 있는 대안이 확보되지 않았습니다. 각 후보의 이유를 확인하세요. 일반 도보 순서 미리보기는 접근성 안내가 아닙니다.</p></div>}
 {routes.map(candidate=>{const decision=journey.assessments[candidate.id]?.decision;if(!decision)return null;const providerRestriction=hasOnlyProviderBarriers(decision);return <article key={candidate.id} className={'route-card '+(candidate.id===selected?'selected':'')}><button className="route-select" aria-label={candidate.name+' 선택'} aria-pressed={candidate.id===selected} onClick={()=>selectRoute(candidate.id)}><div className="route-card-top"><b>{candidate.name}</b><span className={'route-action-tag kind-'+decision.kind+(providerRestriction?' provider-restriction':'')}>{candidate.graphSegment?'연결되지 않은 지도 구간':providerRestriction?'계단 안내 · 추천 제외':decisionLabels[decision.kind]}</span></div><div className="route-distance">{candidate.graphSegment?<span>지도 선형 {(candidate.distance/1000).toFixed(2)} km</span>:<>{Math.ceil(candidate.seconds/60)}<small> 분</small><span>{(candidate.distance/1000).toFixed(2)} km · 보행 기준</span></>}</div><p className="card-decision-action">{decision.action}</p><p className="card-decision-reason">{decision.reason}</p>{analyzing&&decision.kind==='hold'&&!candidate.graphSegment&&<small>필요한 지점 관찰과 연결부 재확인 중</small>}{candidate.detourReason&&<p className="detour-reason">{candidate.detourReason}</p>}</button><button className="route-detail-button" aria-label={candidate.name+' 상세 보기'} ref={element=>{if(element)detailButtons.current.set(candidate.id,element);else detailButtons.current.delete(candidate.id);}} onClick={()=>openDetails(candidate.id)}>{candidate.graphSegment?'연결되지 않은 구간 보기':'위치와 판단 근거 보기'} <ChevronRight size={15}/></button></article>;})}
 {route&&routeDecision&&(routeDecision.kind==='hold'||routeDecision.kind==='detour')&&!!visibleIssues.length&&<section className="conditional-confirmation" aria-label="확인이 필요한 경로 위치"><h3>안내 전 확인할 위치</h3><p>표시된 위치와 이유를 확인하세요. 미확인은 통행 장애가 확인됐다는 뜻이 아닙니다.</p>{issueList()}</section>}
 {route&&routeDecision&&<>{routeDecision.kind==='conditional'&&!guideBlocked&&<section className="conditional-confirmation" aria-label="조건부 경로 확인"><h3>확인이 필요한 조건부 후보</h3><p>{routeDecision.reason}</p><p>{routeDecision.action}</p><p>{journey.goal==='entrance'?'건물 출입구 연결까지의 후보입니다.':'지도 도착 지점까지의 후보이며 건물 출입구 진입은 포함하지 않습니다.'} 표본 지점 사이와 현재 현장 상태는 확인되지 않았습니다. 거리영상은 촬영 당시의 과거 모습이며 촬영 날짜는 각 지점의 근거에 표시됩니다.</p><h4>확인할 위치와 조치</h4>{issueList()}<label><input type="checkbox" checked={conditionalConfirmed} disabled={!conditionalKey} onChange={event=>setConsent(event.target.checked?conditionalKey:'')}/> 표시된 위치와 더 보기의 모든 미확인 위치, 영상의 한계를 이해했으며 현장에서 직접 확인하겠습니다.</label>{analyzing&&<p>분석이 끝난 뒤 확인하고 시작할 수 있습니다.</p>}</section>}
 <button className="primary full" disabled={!(guideVerified||conditionalConfirmed)||!route.steps.length} onClick={()=>{if(!(guideVerified||conditionalConfirmed))return;explicitRouteSelection.current=true;setNav('guide');setStep(0);if(route.steps[0])setFocus(route.steps[0].coord);}}>{guideVerified?'영상 기준 추천 경로 안내':routeDecision.kind==='conditional'&&!guideBlocked?'조건부 경로 안내 시작':'이 경로는 접근성 안내를 시작할 수 없어요'} <Navigation size={18}/></button>{(routeDecision.kind==='hold'||routeDecision.kind==='conditional')&&!guideBlocked&&<button className="walking-preview" disabled={!route.steps.length} onClick={()=>{explicitRouteSelection.current=true;setNav('preview');setStep(0);if(route.steps[0])setFocus(route.steps[0].coord);}}>일반 도보 순서만 미리 보기 · 접근성 안내 아님</button>}</>}

 </section>}</div>}<footer className="sidebar-footer"><Accessibility size={15}/><span>모두의 일상을 잇는 길찾기</span></footer></aside>
 <section className="map-area"><MapView routes={routes} selected={selected} activeId={active} assessments={journey?.assessments??{}} start={start} end={end} onPoint={point} onEvidence={inspectPoint} focus={focus}/><div className="map-topbar">{collapsed&&<button className="map-button" aria-label="검색 패널 열기" onClick={()=>setCollapsed(false)}><PanelLeftOpen size={20}/></button>}<div className="map-context"><span className="live-dot"/> 관찰 근거로 비교하는 길찾기</div></div>
 {pick && <div className="pick-banner"><MapPin size={17}/> 지도에서 {pick === 'start' ? '출발지' : '도착지'}를 선택하세요<button onClick={() => setPick(null)}>취소</button></div>}
 <button ref={locateButton} className="locate map-button" aria-label="내 위치로 지도 이동" onClick={()=>{if(!navigator.geolocation){setMapNotice('이 기기에서는 현재 위치를 사용할 수 없습니다.');return;}setMapNotice('');navigator.geolocation.getCurrentPosition(position=>setFocus([position.coords.longitude,position.coords.latitude]),()=>setMapNotice('현재 위치를 찾지 못했습니다. 위치 권한을 확인해 주세요.'));}}><LocateFixed size={21}/></button>

 {nav&&route&&routeDecision&&!guideBlocked&&routeDecision.kind!=='detour'&&(nav==='preview'||guideVerified||conditionalConfirmed)&&<div className="navigation-panel">{nav==='preview'?<p role="status" className="notice">일반 도보 순서 미리보기입니다. 선택한 이동 수단의 통행을 권장하는 안내가 아닙니다. {routeDecision.reason}</p>:!guideVerified&&<p role="status" className="notice">조건부 경로입니다. 확인되지 않은 지점과 현재 현장 상태는 보장되지 않습니다. {routeDecision.reason}</p>}<div><span className="eyebrow">{nav==='preview'?'일반 도보 순서':guideVerified?'영상 기준 경로 안내':'조건부 경로 안내'} · {Math.min(step+1,route.steps.length)}/{route.steps.length}</span><button className="icon-button" aria-label="경로 안내 닫기" onClick={()=>setNav(null)}><X size={18}/></button></div><h3><Navigation size={22}/>{route.steps[step]?.text??'목적지 위치입니다'}</h3><p className="nav-note">지도 길찾기 안내입니다. 단계는 직접 넘겨야 하며 현재 위치를 자동으로 추적하지 않습니다.</p><button className="nav-locate" type="button" onClick={()=>{const current=route.steps[step];if(current)setFocus(current.coord);}}><MapPin size={15}/> 이 안내 위치를 지도에서 보기</button><div className="nav-actions"><button disabled={!step} onClick={()=>{setStep(step-1);setFocus(route.steps[step-1].coord);}}>이전</button><button disabled={step>=route.steps.length-1} onClick={()=>{setStep(step+1);setFocus(route.steps[step+1].coord);}}>다음 <ArrowRight size={16}/></button></div></div>}
 </section></main>;
}
