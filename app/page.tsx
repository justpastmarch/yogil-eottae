'use client';
import { useState, useRef, useEffect } from 'react';
import { ArrowUpDown, ArrowRight, ChevronRight, MapPin, Route as RouteIcon, Navigation, Accessibility, Check, Search, X, ExternalLink, LoaderCircle, LocateFixed, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import MapView from './Map';
import { summary, type Coord, type Place, type JourneyResult } from '@/lib/domain';
import { journeyResponse, searchResponse } from '@/lib/requests';
type Screen = {
    kind: 'idle';
} | {
    kind: 'loading';
    message: string;
} | {
    kind: 'result';
    journey: JourneyResult;
} | {
    kind: 'error';
    message: string;
};
const labels = { clear: '이동 공간 확인', caution: '주의 구간', blocked: '이동 장애물', unknown: '정보 부족' };
export default function Page() {
    const [screen, setScreen] = useState<Screen>({ kind: 'idle' }), [profile, setProfile] = useState('수동 휠체어');
    const [from, setFrom] = useState('수원시 영통구 영통동 992-1'), [to, setTo] = useState('경희대학교 국제캠퍼스 학생회관');
    const [start, setStart] = useState<Place | null>(null), [end, setEnd] = useState<Place | null>(null), [results, setResults] = useState<Place[]>([]), [searchFor, setSearchFor] = useState<'start' | 'end' | null>(null);
    const [selected, setSelected] = useState(''), [active, setActive] = useState(''), [focus, setFocus] = useState<Coord | null>(null), [pick, setPick] = useState<'start' | 'end' | null>(null), [collapsed, setCollapsed] = useState(false), [nav, setNav] = useState(false), [step, setStep] = useState(0);
    const request = useRef<{
        generation: number;
        controller: AbortController | null;
    }>({ generation: 0, controller: null });
    useEffect(() => () => request.current.controller?.abort(), []);
    const journey = screen.kind === 'result' ? screen.journey : null, routes = journey?.routes ?? [], evidence = journey?.evidence ?? {}, route = routes.find(r => r.id === selected), busy = screen.kind === 'loading';
    const sample = route?.samples.find(s => route.id + ':' + s.id === active), observation = evidence[active];
    function reset() { request.current.controller?.abort(); request.current.generation++; setScreen({ kind: 'idle' }); setSelected(''); setActive(''); setNav(false); setStep(0); setFocus(null); setResults([]); setSearchFor(null); }
    function begin(message: string) { request.current.controller?.abort(); const controller = new AbortController(); request.current = { generation: request.current.generation + 1, controller }; setScreen({ kind: 'loading', message }); setActive(''); setNav(false); setStep(0); return { generation: request.current.generation, controller }; }
    async function call(body: unknown, signal: AbortSignal): Promise<unknown> { const response = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }); if (!response.ok)
        throw new Error(response.status === 400 ? '출발지와 도착지를 확인해 주세요.' : '길찾기 서비스를 잠시 이용할 수 없습니다. 잠시 후 다시 시도해 주세요.'); return response.json(); }
    async function find(which: 'start' | 'end') {
        const query = which === 'start' ? from : to;
        if (query.trim().length < 2)
            return;
        const task = begin('장소를 찾고 있어요');
        setSearchFor(which);
        setResults([]);
        try {
            const data = searchResponse.parse(await call({ action: 'search', query, address: which === 'start' && /\d/.test(query) }, task.controller.signal));
            if (task.generation !== request.current.generation)
                return;
            setResults(data.places);
            setScreen(data.places.length ? { kind: 'idle' } : { kind: 'error', message: '검색 결과가 없습니다. 다른 이름으로 검색하거나 지도에서 선택해 주세요.' });
        }
        catch (error) {
            if (task.generation !== request.current.generation || task.controller.signal.aborted)
                return;
            setScreen({ kind: 'error', message: error instanceof Error ? error.message : '장소를 찾지 못했습니다.' });
        }
    }
    function choose(place: Place) { const which = searchFor; reset(); if (which === 'start') {
        setStart(place);
        setFrom(place.name);
    }
    else {
        setEnd(place);
        setTo(place.name);
    } }
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
        if (!start || !end) {
            await find(!start ? 'start' : 'end');
            return;
        }
        const task = begin('이동하기 편한 길을 찾고 있어요');
        setSelected('');
        try {
            const data = journeyResponse.parse(await call({ action: 'journey', start, end, profile }, task.controller.signal));
            if (task.generation !== request.current.generation)
                return;
            setSelected(data.recommendedId ?? data.routes[0]?.id ?? '');
            setScreen({ kind: 'result', journey: data });
        }
        catch (error) {
            if (task.generation !== request.current.generation || task.controller.signal.aborted)
                return;
            setScreen({ kind: 'error', message: error instanceof Error ? error.message : '길을 찾지 못했습니다.' });
        }
    }
    function selectRoute(id: string) { setSelected(id); setActive(''); setNav(false); setStep(0); setFocus(null); }
    return <main className="app">
 <nav className="rail" aria-label="주 메뉴"><a href="/" className="brand-icon" aria-label="길이음 홈"><RouteIcon size={26}/></a><button className="rail-item active"><Navigation size={22}/><span>길찾기</span></button><div className="rail-bottom"><Accessibility size={23}/><span>모두의 길</span></div></nav>
 <aside className={'sidebar ' + (collapsed ? 'collapsed' : '')}>
 <header className="sidebar-head"><div><h1>길이음<span className="beta">BETA</span></h1><p>나에게 맞는 길로, 일상을 잇다</p></div><button className="icon-button collapse" aria-label="검색 패널 접기" onClick={() => setCollapsed(true)}><PanelLeftClose size={20}/></button></header>
 <section className="search-section"><div className="mode-row"><span className="mode active"><Accessibility size={17}/> 편한 길찾기</span><span className="region">보행 · 이동 지원</span></div>
 <div className="locations"><div className="location-row"><span className="location-dot start"/><label className="sr-only" htmlFor="from">출발지</label><input id="from" value={from} onChange={event => { reset(); setFrom(event.target.value); setStart(null); }} onKeyDown={event => event.key === 'Enter' && find('start')}/><button aria-label="출발지 검색" onClick={() => find('start')}><Search size={18}/></button></div>
 <div className="location-row"><span className="location-dot end"/><label className="sr-only" htmlFor="to">도착지</label><input id="to" value={to} onChange={event => { reset(); setTo(event.target.value); setEnd(null); }} onKeyDown={event => event.key === 'Enter' && find('end')}/><button aria-label="도착지 검색" onClick={() => find('end')}><Search size={18}/></button></div><button className="swap" aria-label="출발지와 도착지 바꾸기" onClick={() => { reset(); setFrom(to); setTo(from); setStart(end); setEnd(start); }}><ArrowUpDown size={16}/></button></div>
 <div className="pick-row"><button onClick={() => { reset(); setPick('start'); }}>출발지 지도에서 선택</button><button onClick={() => { reset(); setPick('end'); }}>도착지 지도에서 선택</button></div>
 {searchFor && <div className="search-results"><div className="result-heading">{searchFor === 'start' ? '출발지' : '도착지'} 선택<button aria-label="검색 결과 닫기" onClick={() => { setSearchFor(null); setResults([]); }}><X size={16}/></button></div>{results.map(place => <button key={place.id} className="place-result" onClick={() => choose(place)}><MapPin size={17}/><span><b>{place.name}</b><small>{place.address}</small></span><ChevronRight size={16}/></button>)}</div>}
 <div className="profile-row"><label htmlFor="profile"><Accessibility size={17}/> 이동 수단</label><select id="profile" value={profile} onChange={event => { reset(); setProfile(event.target.value); }}>{['수동 휠체어', '전동 휠체어', '유아차', '보행 보조기'].map(value => <option key={value}>{value}</option>)}</select></div>
 <button className="primary search-button" disabled={busy} onClick={findJourney}><RouteIcon size={19}/> 경로 찾기 <ArrowRight size={18}/></button>
 <div className="location-status">{start ? <><Check size={12}/> 출발지 선택</> : <>출발지를 검색해 주세요</>}<span>·</span>{end ? <><Check size={12}/> 도착지 선택</> : <>도착지를 검색해 주세요</>}</div></section>
 {screen.kind === 'error' && <div className="notice" role="alert">{screen.message}</div>}
 {screen.kind === 'loading' && <div className="progress" role="status"><LoaderCircle size={17} className="spin"/><span>{screen.message}</span></div>}
 <div className="results-scroll">{!journey ? <section className="empty-state"><div className="eyebrow">오늘의 이동</div><h2>나에게 편한 길로,<br />목적지까지.</h2><p>출발지와 도착지를 선택하면<br />이동 환경을 고려한 경로를 찾아드려요.</p><div className="journey-graphic"><div className="graphic-line"/><span className="graphic-start"><MapPin size={22}/></span><span className="graphic-person"><Accessibility size={32}/></span><span className="graphic-end"><Check size={20}/></span></div></section> : <section className="routes-section"><div className="section-title"><h2>이동 경로 <span>{routes.length}</span></h2></div>
 {journey.status === 'limited' && <p className="subnote">{Object.keys(evidence).length === 0 ? '일반 도보 경로예요. 접근성 분석은 아직 완료되지 않았어요.' : routes.length > 1 ? '이동 환경 정보가 일부 부족해요. 후보 경로와 주요 지점을 비교해 보세요.' : '이동 환경 정보가 일부 부족해요. 주요 지점을 살펴보세요.'}</p>}
 {routes.map(candidate => { const stats = summary(candidate, evidence); return <button key={candidate.id} className={'route-card ' + (candidate.id === selected ? 'selected' : '')} onClick={() => selectRoute(candidate.id)}><div className="route-card-top"><b>{candidate.name}</b>{journey.recommendedId === candidate.id && <span className="tag green">추천</span>}{stats.blocked > 0 && <span className="tag red">장애 구간 있음</span>}</div><div className="route-distance">{Math.ceil(candidate.seconds / 60)}<small> 분</small><span>{(candidate.distance / 1000).toFixed(2)} km · 보행 기준</span></div><small>{journey.recommendedId === candidate.id ? '확인한 주요 지점에서 통행 장애가 보이지 않아요' : stats.blocked ? '계단이나 통행 장애가 관찰된 구간이 있어요' : '이동 환경을 살펴보고 선택하세요'}</small></button>; })}
 {route && <><button className="primary full" onClick={() => { setNav(true); setStep(0); if (route.steps[0])
            setFocus(route.steps[0].coord); }}>경로 안내 보기 <Navigation size={18}/></button><details><summary style={{ padding: '18px 0', cursor: 'pointer' }}>주요 지점 살펴보기</summary><div className="evidence-list">{route.samples.map((point, index) => { const id = route.id + ':' + point.id, item = evidence[id]; return <button key={id} onClick={() => { setActive(id); setFocus(point.coord); }}><span className={'evidence-dot ' + (item?.status ?? 'unknown')}/><span>{index + 1}. {Math.round(point.along)}m 지점</span><small>{item ? labels[item.status] : '정보 부족'}</small></button>; })}</div></details></>}
 </section>}</div><footer className="sidebar-footer"><Accessibility size={15}/><span>모두의 일상을 잇는 길찾기</span></footer></aside>
 <section className="map-area"><MapView routes={routes} selected={selected} evidence={evidence} start={start} end={end} onPoint={point} onEvidence={setActive} focus={focus}/><div className="map-topbar">{collapsed && <button className="map-button" aria-label="검색 패널 열기" onClick={() => setCollapsed(false)}><PanelLeftOpen size={20}/></button>}<div className="map-context"><span className="live-dot"/> 나에게 맞는 길찾기</div></div>
 {pick && <div className="pick-banner"><MapPin size={17}/> 지도에서 {pick === 'start' ? '출발지' : '도착지'}를 선택하세요<button onClick={() => setPick(null)}>취소</button></div>}
 <button className="locate map-button" aria-label="내 위치로 지도 이동" onClick={() => navigator.geolocation?.getCurrentPosition(position => setFocus([position.coords.longitude, position.coords.latitude]), () => setScreen({ kind: 'error', message: '현재 위치를 찾지 못했습니다. 위치 권한을 확인해 주세요.' }))}><LocateFixed size={21}/></button>
 {sample && <div className="evidence-panel"><div className="evidence-head"><h3>{Math.round(sample.along)}m 지점</h3><button className="icon-button" aria-label="지점 정보 닫기" onClick={() => setActive('')}><X size={20}/></button></div><div className="finding-body"><p>{observation?.reason ?? '이 구간의 이동 환경 정보가 충분하지 않습니다.'}</p>{observation?.finding && <ul>{observation.finding.evidence.map((text, index) => <li key={index}>{text}</li>)}</ul>}{observation?.source && <p>촬영 {new Date(observation.source.capturedAt).toLocaleDateString('ko-KR')} · <a href={observation.source.url} target="_blank" rel="noreferrer">거리 모습 보기 <ExternalLink size={12}/></a></p>}</div></div>}
 {nav && route && <div className="navigation-panel"><div><span className="eyebrow">경로 안내 · {Math.min(step + 1, route.steps.length)}/{route.steps.length}</span><button className="icon-button" aria-label="경로 안내 닫기" onClick={() => setNav(false)}><X size={18}/></button></div><h3><Navigation size={22}/>{route.steps[step]?.text ?? '목적지에 도착합니다'}</h3><div className="nav-actions"><button disabled={!step} onClick={() => { setStep(step - 1); setFocus(route.steps[step - 1].coord); }}>이전</button><button disabled={step >= route.steps.length - 1} onClick={() => { setStep(step + 1); setFocus(route.steps[step + 1].coord); }}>다음 <ArrowRight size={16}/></button></div></div>}
 </section></main>;
}
