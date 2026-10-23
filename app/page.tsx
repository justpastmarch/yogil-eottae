'use client';
import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { ArrowUpDown, ArrowRight, ChevronRight, MapPin, Route as RouteIcon, Navigation, Accessibility, Check, Search, X, LoaderCircle, LocateFixed, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import MapView from './Map';
import RouteDetails from './RouteDetails';
import { summary, type Coord, type Place, type JourneyResult } from '@/lib/domain';
import { journeySnapshotResponse, searchResponse } from '@/lib/requests';
type Screen = {
    kind: 'idle';
} | {
    kind: 'loading';
    message: string;
} | {
    kind: 'result';
    journey: JourneyResult;
    analysis: {phase:'running'|'ready'|'limited'|'failed'|'canceled';checked:number;total:number;message?:string};
} | {
    kind: 'error';
    message: string;
};
type LocationField = 'start' | 'end';
type LocationSearch = {field:LocationField;kind:'loading'} | {field:LocationField;kind:'results';places:Place[]} | {field:LocationField;kind:'error';message:string};
const normalizedPlaceName = (value:string) => value.replace(/\s+/g,'').toLowerCase();
export default function Page() {
    const [screen, setScreen] = useState<Screen>({ kind: 'idle' }), [profile, setProfile] = useState('수동 휠체어');
    const [from, setFrom] = useState('수원시 영통구 영통동 992-1'), [to, setTo] = useState('경희대학교 국제캠퍼스 학생회관');
    const [start, setStart] = useState<Place | null>(null), [end, setEnd] = useState<Place | null>(null);
    const [locationSearch,setLocationSearch]=useState<LocationSearch|null>(null),[focusedField,setFocusedField]=useState<LocationField|null>(null),[highlighted,setHighlighted]=useState(-1);
    const locationRequest=useRef<AbortController|null>(null);
    const searchTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
    const [selected, setSelected] = useState(''), [active, setActive] = useState(''), [focus, setFocus] = useState<Coord | null>(null), [pick, setPick] = useState<'start' | 'end' | null>(null), [collapsed, setCollapsed] = useState(false), [nav, setNav] = useState(false), [step, setStep] = useState(0);
    const [detailRouteId,setDetailRouteId]=useState<string|null>(null);
    const listScroll=useRef<HTMLDivElement>(null);
    const listPosition=useRef(0);
    const detailButtons=useRef(new Map<string,HTMLButtonElement>());
    const returnToRoute=useRef<string|null>(null);
    useEffect(()=>{if(detailRouteId||!returnToRoute.current)return;if(listScroll.current)listScroll.current.scrollTop=listPosition.current;detailButtons.current.get(returnToRoute.current)?.focus({preventScroll:true});returnToRoute.current=null;},[detailRouteId]);
    const request = useRef<{
        generation: number;
        controller: AbortController | null;
        jobId: string | null;
    }>({ generation: 0, controller: null, jobId:null });
    useEffect(() => () => {stopJob();locationRequest.current?.abort();}, []);
    useEffect(()=>{if(!focusedField)return;const query=focusedField==='start'?from:to;const place=focusedField==='start'?start:end;if(place)return;searchTimer.current=setTimeout(()=>void find(focusedField,query),300);return()=>{if(searchTimer.current)clearTimeout(searchTimer.current);};},[focusedField,from,to,start,end]);
    const journey = screen.kind === 'result' ? screen.journey : null, routes = journey?.routes ?? [], evidence = journey?.evidence ?? {}, route = routes.find(r => r.id === selected), analyzing = screen.kind === 'result' && screen.analysis.phase === 'running', busy = screen.kind === 'loading' || analyzing;
    const guideBlocked=!!route&&(summary(route,evidence).blocked>0||(journey?.assessments[route.id]?.blockedPassageIds.length??0)>0);
    const guideVerified=!!route&&journey?.recommendedId===route.id&&!guideBlocked;
    const detailRoute=routes.find(candidate=>candidate.id===detailRouteId);
    function openDetails(id:string,pointId=''){if(!detailRouteId)listPosition.current=listScroll.current?.scrollTop??0;setSelected(id);setDetailRouteId(id);setActive(pointId);setNav(false);setStep(0);}
    function closeDetails(){returnToRoute.current=detailRouteId;setDetailRouteId(null);setActive('');}
    function inspectPoint(id:string){const candidate=routes.find(candidate=>candidate.samples.some(sample=>candidate.id+':'+sample.id===id));if(candidate){openDetails(candidate.id,id);const point=candidate.samples.find(sample=>candidate.id+':'+sample.id===id);if(point)setFocus([point.coord[0],point.coord[1]]);}}
    function stopJob() { request.current.controller?.abort(); const jobId=request.current.jobId; request.current.jobId=null; if(jobId) void fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'cancel',jobId}),keepalive:true}).catch(()=>{}); }
    function reset() { returnToRoute.current=null;setDetailRouteId(null);stopJob(); request.current.generation++; setScreen({ kind: 'idle' }); setSelected(''); setActive(''); setNav(false); setStep(0); setFocus(null); closeSearch(); }
    function begin(message: string) { returnToRoute.current=null;setDetailRouteId(null);stopJob(); const controller = new AbortController(); request.current = { generation: request.current.generation + 1, controller, jobId:null }; setScreen({ kind: 'loading', message }); setActive(''); setNav(false); setStep(0); return { generation: request.current.generation, controller }; }
    async function call(body: unknown, signal: AbortSignal): Promise<unknown> { const response = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }); if (!response.ok)
        throw new Error(response.status === 400 ? '출발지와 도착지를 확인해 주세요.' : '길찾기 서비스를 잠시 이용할 수 없습니다. 잠시 후 다시 시도해 주세요.'); return response.json(); }
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
        return <div className="location-field" key={which}><div className="location-row"><span className={'location-dot '+which}/><label className="sr-only" htmlFor={id}>{field}</label><input id={id} value={which==='start'?from:to} autoComplete="off" role="combobox" aria-autocomplete="list" aria-expanded={!!search} aria-controls={search?id+'-suggestions':undefined} aria-activedescendant={search?.kind==='results'&&highlighted>=0?id+'-option-'+highlighted:undefined} onFocus={()=>setFocusedField(which)} onChange={event=>editLocation(which,event.target.value)} onKeyDown={event=>locationKey(event,which)}/><button aria-label={field+' 검색'} onClick={()=>void find(which)}><Search size={18}/></button></div>
        {search&&<div className="search-results" id={id+'-suggestions'}><div className="result-heading">{field} 검색<button aria-label="검색 결과 닫기" onClick={closeSearch}><X size={16}/></button></div>{search.kind==='loading'?<p role="status">장소를 찾고 있어요</p>:search.kind==='error'?<p role="status">{search.message}</p>:<div role="listbox" aria-label={field+' 검색 결과'}>{search.places.map((place,index)=><button key={place.id} id={id+'-option-'+index} role="option" aria-selected={highlighted===index} className="place-result" onClick={()=>choose(which,place)}><MapPin size={17}/><span><b>{place.name}</b><small>{place.address}</small></span><ChevronRight size={16}/></button>)}</div>}</div>}</div>;
    }
    function point(coord: Coord) { if (!pick)
        return; const which = pick; reset(); const name = which === 'start' ? '선택한 출발지' : '선택한 도착지', place = { id: 'map-' + Date.now(), name, address: '지도에서 선택한 위치', coord }; if (which === 'start') {
        setStart(place);
        setFrom(name);
    }
    else {
        setEnd(place);
        setTo(name);
    } setPick(null); }
    async function findJourney() {
        closeSearch();
        const task = begin('출발지와 도착지를 확인하고 있어요');
        setSelected('');
        try {
            const resolve=async(which:LocationField,selectedPlace:Place|null,query:string)=>{
                if(selectedPlace)return selectedPlace;
                if(query.trim().length<2)throw new Error('출발지와 도착지를 두 글자 이상 입력해 주세요.');
                const places=await searchPlaces(query,task.controller.signal);
                const exact=places.filter(place=>normalizedPlaceName(place.name)===normalizedPlaceName(query)||normalizedPlaceName(place.address)===normalizedPlaceName(query));
                const resolved=exact.length===1?exact[0]:places.length===1&&places[0].id.startsWith('address-')?places[0]:null;
                if(!resolved){
                    if(task.generation===request.current.generation){setScreen({kind:'idle'});setLocationSearch(places.length?{field:which,kind:'results',places}:{field:which,kind:'error',message:'검색 결과가 없어요. 이름이나 주소를 수정해 주세요.'});document.getElementById(which==='start'?'from':'to')?.focus();setFocusedField(null);}
                    return null;
                }
                if(task.generation!==request.current.generation)return null;
                if(which==='start')setStart(resolved);else setEnd(resolved);
                return resolved;
            };
            const resolvedStart=await resolve('start',start,from);if(!resolvedStart)return;
            const resolvedEnd=await resolve('end',end,to);if(!resolvedEnd)return;
            if(task.generation!==request.current.generation)return;
            setScreen({kind:'loading',message:'이동 환경을 살펴보고 우회 경로를 찾고 있어요'});
            let snapshot = journeySnapshotResponse.parse(await call({ action: 'journey', start:resolvedStart, end:resolvedEnd, profile }, task.controller.signal));
            if (task.generation !== request.current.generation) return;
            request.current.jobId=snapshot.jobId;
            setSelected(snapshot.journey.recommendedId ?? snapshot.journey.routes[0]?.id ?? '');
            for (;;) {
                if(task.generation!==request.current.generation || task.controller.signal.aborted) return;
                const {journey,phase,progress}=snapshot;
                setScreen({kind:'result',journey,analysis:{phase,checked:progress.checked,total:progress.total}});
                if(phase!=='running') { request.current.jobId=null; break; }
                await new Promise(resolve=>setTimeout(resolve,350));
                if(task.generation!==request.current.generation || task.controller.signal.aborted) return;
                snapshot=journeySnapshotResponse.parse(await call({action:'advance',jobId:snapshot.jobId},task.controller.signal));
            }
        }
        catch (error) {
            if (task.generation !== request.current.generation || task.controller.signal.aborted)
                return;
            stopJob();
            const message=error instanceof Error ? error.message : '길을 찾지 못했습니다.';
            setScreen(previous=>previous.kind==='result'?{...previous,analysis:{...previous.analysis,phase:'failed',message}}:{kind:'error',message});
        }
    }
    function selectRoute(id: string) { setSelected(id); setActive(''); setNav(false); setStep(0); setFocus(null); }
    return <main className="app">
 <nav className="rail" aria-label="주 메뉴"><a href="/" className="brand-icon" aria-label="길이음 홈"><RouteIcon size={26}/></a><button className="rail-item active"><Navigation size={22}/><span>길찾기</span></button><div className="rail-bottom"><Accessibility size={23}/><span>모두의 길</span></div></nav>
 <aside className={'sidebar ' + (collapsed ? 'collapsed' : '')+(detailRoute?' show-details':'')}>
 <header className="sidebar-head"><div><h1>길이음<span className="beta">BETA</span></h1><p>나에게 맞는 길로, 일상을 잇다</p></div><button className="icon-button collapse" aria-label="검색 패널 접기" onClick={() => setCollapsed(true)}><PanelLeftClose size={20}/></button></header>
 {!detailRoute && <section className="search-section"><div className="mode-row"><span className="mode active"><Accessibility size={17}/> 편한 길찾기</span><span className="region">보행 · 이동 지원</span></div>
 <div className="locations" onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))closeSearch();}}>{locationInput('start')}{locationInput('end')}<button className="swap" aria-label="출발지와 도착지 바꾸기" onClick={() => { reset(); setFrom(to); setTo(from); setStart(end); setEnd(start); }}><ArrowUpDown size={16}/></button></div>
 <div className="pick-row"><button onClick={() => { reset(); setPick('start'); }}>출발지 지도에서 선택</button><button onClick={() => { reset(); setPick('end'); }}>도착지 지도에서 선택</button></div>
 <div className="profile-row"><label htmlFor="profile"><Accessibility size={17}/> 이동 수단</label><select id="profile" value={profile} onChange={event => { reset(); setProfile(event.target.value); }}>{['수동 휠체어', '전동 휠체어', '유아차', '보행 보조기'].map(value => <option key={value}>{value}</option>)}</select></div>
 <button className="primary search-button" disabled={busy} onClick={findJourney}><RouteIcon size={19}/> 경로 찾기 <ArrowRight size={18}/></button>
 <div className="location-status">{start ? <><Check size={12}/> 출발지 선택</> : <>출발지 입력</>}<span>·</span>{end ? <><Check size={12}/> 도착지 선택</> : <>도착지 입력</>}</div></section>}
 {screen.kind === 'error' && <div className="notice" role="alert">{screen.message}</div>}
 {screen.kind === 'result' && analyzing && <div className="progress" role="status"><LoaderCircle size={17} className="spin"/><span>전체 후보 {routes.length}개 · {screen.analysis.total}지점 중 {screen.analysis.checked}지점 분석 시도 완료</span><button onClick={()=>{stopJob();setScreen({...screen,analysis:{...screen.analysis,phase:'canceled'}});}}>중지</button></div>}
 {screen.kind === 'result' && screen.analysis.phase==='failed' && <div className="notice" role="alert">{screen.analysis.message ?? '이동 환경 분석을 완료하지 못했어요. 조회한 경로를 비교해 보세요.'}</div>}
 {screen.kind === 'loading' && <div className="progress" role="status"><LoaderCircle size={17} className="spin"/><span>{screen.message}</span></div>}
 {detailRoute && screen.kind==='result' ? <RouteDetails key={detailRoute.id} route={detailRoute} evidence={evidence} phase={screen.analysis.phase} activeId={active} hasExcludedPassage={(journey?.assessments[detailRoute.id]?.blockedPassageIds.length??0)>0} onBack={closeDetails} onLocate={sample=>{setActive(detailRoute.id+':'+sample.id);setFocus([sample.coord[0],sample.coord[1]]);}}/> : <div className="results-scroll" ref={listScroll}>{!journey ? <section className="empty-state"><div className="eyebrow">오늘의 이동</div><h2>나에게 편한 길로,<br />목적지까지.</h2><p>출발지와 도착지를 선택하면<br />이동 환경을 고려한 경로를 찾아드려요.</p><div className="journey-graphic"><div className="graphic-line"/><span className="graphic-start"><MapPin size={22}/></span><span className="graphic-person"><Accessibility size={32}/></span><span className="graphic-end"><Check size={20}/></span></div></section> : <section className="routes-section"><div className="section-title"><h2>이동 경로 <span>{routes.length}</span></h2></div>
 {journey.status === 'limited' && !analyzing && <p className="subnote">{Object.keys(evidence).length === 0 ? '일반 도보 경로예요. 접근성 분석은 아직 완료되지 않았어요.' : routes.length > 1 ? '이동 환경 정보가 일부 부족해요. 후보 경로와 주요 지점을 비교해 보세요.' : '이동 환경 정보가 일부 부족해요. 주요 지점을 살펴보세요.'}</p>}
 {routes.map(candidate => { const stats = summary(candidate, evidence); const hasBlock = stats.blocked > 0 || (journey.assessments[candidate.id]?.blockedPassageIds.length ?? 0) > 0; return <article key={candidate.id} className={'route-card ' + (candidate.id === selected ? 'selected' : '')}><button className="route-select" aria-label={candidate.name+' 선택'} aria-pressed={candidate.id===selected} onClick={() => selectRoute(candidate.id)}><div className="route-card-top"><b>{candidate.name}</b>{journey.recommendedId === candidate.id && <span className="tag green">추천</span>}{hasBlock && <span className="tag red">장애 구간 있음</span>}</div><div className="route-distance">{Math.ceil(candidate.seconds / 60)}<small> 분</small><span>{(candidate.distance / 1000).toFixed(2)} km · 보행 기준</span></div>{candidate.detourReason && <p className="detour-reason">{candidate.detourReason}</p>}<small>{journey.recommendedId === candidate.id ? '확인한 주요 지점에서 통행 장애가 보이지 않아요' : hasBlock ? candidate.knownBarriers?.[0]??'관찰된 통행 장애 구간이 포함되어 있어요' : '이동 환경을 살펴보고 선택하세요'}</small></button><button className="route-detail-button" aria-label={candidate.name+' 상세 보기'} ref={element=>{if(element)detailButtons.current.set(candidate.id,element);else detailButtons.current.delete(candidate.id);}} onClick={()=>openDetails(candidate.id)}>상세 보기 <ChevronRight size={15}/></button></article>; })}
 {route && <><button className="primary full" disabled={guideBlocked||!route.steps.length} onClick={() => { if(guideBlocked)return;setNav(true); setStep(0); if (route.steps[0])
            setFocus(route.steps[0].coord); }}>{guideBlocked?'통행 장애 구간이 포함된 경로':guideVerified?'경로 안내 보기':'미검증 도보 안내 보기'} <Navigation size={18}/></button></>}

 </section>}</div>}<footer className="sidebar-footer"><Accessibility size={15}/><span>모두의 일상을 잇는 길찾기</span></footer></aside>
 <section className="map-area"><MapView routes={routes} selected={selected} evidence={evidence} start={start} end={end} onPoint={point} onEvidence={inspectPoint} focus={focus}/><div className="map-topbar">{collapsed && <button className="map-button" aria-label="검색 패널 열기" onClick={() => setCollapsed(false)}><PanelLeftOpen size={20}/></button>}<div className="map-context"><span className="live-dot"/> 나에게 맞는 길찾기</div></div>
 {pick && <div className="pick-banner"><MapPin size={17}/> 지도에서 {pick === 'start' ? '출발지' : '도착지'}를 선택하세요<button onClick={() => setPick(null)}>취소</button></div>}
 <button className="locate map-button" aria-label="내 위치로 지도 이동" onClick={() => navigator.geolocation?.getCurrentPosition(position => setFocus([position.coords.longitude, position.coords.latitude]), () => setScreen({ kind: 'error', message: '현재 위치를 찾지 못했습니다. 위치 권한을 확인해 주세요.' }))}><LocateFixed size={21}/></button>

 {nav && route && !guideBlocked && <div className="navigation-panel">{!guideVerified&&<p role="status" className="notice">접근성이 검증되지 않은 일반 도보 경로예요. 계단·단차·경사 등 통행 가능 여부는 보장되지 않아요.</p>}<div><span className="eyebrow">경로 안내 · {Math.min(step + 1, route.steps.length)}/{route.steps.length}</span><button className="icon-button" aria-label="경로 안내 닫기" onClick={() => setNav(false)}><X size={18}/></button></div><h3><Navigation size={22}/>{route.steps[step]?.text ?? '목적지에 도착합니다'}</h3><div className="nav-actions"><button disabled={!step} onClick={() => { setStep(step - 1); setFocus(route.steps[step - 1].coord); }}>이전</button><button disabled={step >= route.steps.length - 1} onClick={() => { setStep(step + 1); setFocus(route.steps[step + 1].coord); }}>다음 <ArrowRight size={16}/></button></div></div>}
 </section></main>;
}
