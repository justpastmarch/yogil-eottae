'use client';
import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import {ArrowUpDown,ArrowRight,ChevronRight,MapPin,Route as RouteIcon,Navigation,Check,Search,X,LoaderCircle,LocateFixed,PanelLeftClose,PanelLeftOpen,BusFront,Footprints} from 'lucide-react';
import {ZodError} from 'zod';
import MapView from './Map';
import RouteDetails from './RouteDetails';
import TransitJourney from './TransitJourney';
import PlaceEntrance from './PlaceEntrance';
import RouteTerrain from './RouteTerrain';
import {orderByRoutePreference} from '@/lib/route-grade';
import type {Coord,Place,JourneyResult,JourneyGoal} from '@/lib/domain';
import {analysisActivity,nameRouteCandidates,routeAnalysisStatus,routeAdmissionStatus,routeSelectionReason,customerRouteIssues,routeGuideBlocked,sameJourneySnapshot,type GradeSelection} from './route-presentation';
import {journeySnapshotResponse,searchResponse,type JourneySnapshotResponse} from '@/lib/requests';
import type {CapturePreview} from '@/lib/capture-contract';
type ResultScreen = {
    kind: 'result';
    journey: JourneyResult;
    captures:CapturePreview[];
    restoredPrevious?:'failed'|'canceled';
    analysis: {phase:'running'|'ready'|'limited'|'failed'|'canceled';checked:number;total:number;message?:string};
};
type Screen = {kind:'idle'} | {kind:'loading';message:string;previous:ResultScreen|null;previousSelected:string} | ResultScreen | {kind:'error';message:string};
type LocationField = 'start' | 'end';
type LocationSearch = {field:LocationField;kind:'loading'} | {field:LocationField;kind:'results';places:Place[]} | {field:LocationField;kind:'error';message:string};
type TravelMode = 'walk' | 'transit';
type CommittedTrip = {key:string;start:Place;end:Place};
const normalizedPlaceName = (value:string) => value.replace(/\s+/g,'').toLowerCase();
export default function Page() {
    const [screen,setScreen]=useState<Screen>({kind:'idle'});
    const [travelMode,setTravelMode]=useState<TravelMode>('walk');
    const modeRef=useRef<TravelMode>('walk');
    const [committedTrip,setCommittedTrip]=useState<CommittedTrip|null>(null);
    const [destinationVerdict,setDestinationVerdict]=useState<'flat'|'ramp'|'raised'|'unknown'|null>(null);
    const profile='수동 휠체어';
    const [preference,setPreference]=useState<'gentle'|'fast'>('gentle');
    const [gradeThreshold,setGradeThreshold]=useState(8);
    const [goal,setGoal]=useState<JourneyGoal>('arrival');
    const imageryProvider='configured';
    const [from, setFrom] = useState('수원시 영통구 영통동 992-1'), [to, setTo] = useState('경희대학교 국제캠퍼스 학생회관');
    const [start, setStart] = useState<Place | null>(null), [end, setEnd] = useState<Place | null>(null);
    const [locationSearch,setLocationSearch]=useState<LocationSearch|null>(null),[focusedField,setFocusedField]=useState<LocationField|null>(null),[highlighted,setHighlighted]=useState(-1);
    const [editingSearch,setEditingSearch]=useState(false),[mapNotice,setMapNotice]=useState('');
    const locationRequest=useRef<AbortController|null>(null);
    const searchTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
    const [selected, setSelected] = useState(''), [active, setActive] = useState(''), [focus, setFocus] = useState<Coord | null>(null), [pick, setPick] = useState<'start' | 'end' | null>(null), [collapsed, setCollapsed] = useState(false), [nav, setNav] = useState<'guide'|null>(null), [step, setStep] = useState(0);
    const [detailRouteId,setDetailRouteId]=useState<string|null>(null);
    const [activeGrade,setActiveGrade]=useState<GradeSelection|null>(null);
    const [selectionSource,setSelectionSource]=useState<'default'|'preference'|'manual'>('default');
    const listScroll=useRef<HTMLDivElement>(null);
    const listPosition=useRef(0);
    const detailButtons=useRef(new Map<string,HTMLButtonElement>());
    const returnToRoute=useRef<string|null>(null);
    const stoppedNotice=useRef<HTMLDivElement>(null),focusStoppedNotice=useRef(false);
    const resultsHeading=useRef<HTMLHeadingElement>(null),focusResults=useRef(false);
    const errorNotice=useRef<HTMLDivElement>(null),focusErrorNotice=useRef(false);
    const explicitRouteSelection=useRef(false),locateButton=useRef<HTMLButtonElement>(null);
    const guideReturnFocus=useRef<HTMLElement|null>(null),guideHeading=useRef<HTMLHeadingElement>(null);
    useEffect(()=>{if(travelMode!=='walk'||detailRouteId||!returnToRoute.current)return;if(listScroll.current)listScroll.current.scrollTop=listPosition.current;detailButtons.current.get(returnToRoute.current)?.focus({preventScroll:true});returnToRoute.current=null;},[detailRouteId,travelMode]);
    const request = useRef<{
        generation: number;
        controller: AbortController | null;
        jobId: string | null;
    }>({ generation: 0, controller: null, jobId:null });
    useEffect(() => () => {stopJob();locationRequest.current?.abort();}, []);
    useEffect(()=>{if(!focusedField)return;const query=focusedField==='start'?from:to;const place=focusedField==='start'?start:end;if(place)return;searchTimer.current=setTimeout(()=>void find(focusedField,query),300);return()=>{if(searchTimer.current)clearTimeout(searchTimer.current);};},[focusedField,from,to,start,end]);
    useEffect(()=>{if(highlighted<0||locationSearch?.kind!=='results')return;const id=(locationSearch.field==='start'?'from':'to')+'-option-'+highlighted;document.getElementById(id)?.scrollIntoView({block:'nearest'});},[highlighted,locationSearch]);
    useEffect(()=>{if(travelMode==='walk'&&screen.kind==='result'&&screen.analysis.phase==='canceled'&&focusStoppedNotice.current){focusStoppedNotice.current=false;stoppedNotice.current?.focus({preventScroll:true});}},[screen,travelMode]);
    useEffect(()=>{if(travelMode!=='walk'||screen.kind!=='result')return;focusErrorNotice.current=false;if(focusResults.current){const target=resultsHeading.current??document.querySelector<HTMLElement>('.route-details h2');if(target){focusResults.current=false;target.focus({preventScroll:true});}}},[screen,travelMode]);
    useEffect(()=>{if(travelMode==='walk'&&screen.kind==='error'&&focusErrorNotice.current){focusErrorNotice.current=false;errorNotice.current?.focus({preventScroll:true});}},[screen,travelMode]);
    useEffect(()=>{
        if(travelMode!=='walk'||screen.kind!=='result'||explicitRouteSelection.current)return;
        const {journey}=screen;
        const candidate=orderByRoutePreference(journey.routes,preference).find(route=>!routeGuideBlocked(journey.assessments[route.id]));
        if(candidate)setSelected(candidate.id);
    },[screen,preference,travelMode]);
    const journey = travelMode==='walk'&&screen.kind === 'result' ? screen.journey : null, routes = journey?nameRouteCandidates(journey.routes,journey.assessments):[], evidence = journey?.evidence ?? {}, route = routes.find(r => r.id === selected), analyzing = screen.kind === 'result' && screen.analysis.phase === 'running', busy = screen.kind === 'loading' || analyzing;
    const routeFailureNotice=screen.kind==='result'&&!analyzing&&(screen.analysis.phase==='failed'||Object.values(evidence).some(item=>!!item.failure||!!item.review?.failure));
    const orderedRoutes=orderByRoutePreference(routes,preference);
    function choosePreference(value:'gentle'|'fast'){
        setPreference(value);
        const candidate=orderByRoutePreference(routes,value).find(item=>!routeGuideBlocked(journey?.assessments[item.id]));
        if(candidate)selectRoute(candidate.id,'preference');
    }
    const destinationBlockedReason=destinationVerdict==='raised'?'도착지 입구 사진에 계단·턱이 관찰됐어요. 계단 없는 다른 입구를 확인해 주세요.':undefined;
    const routeDecision=route?journey?.assessments[route.id]?.decision:undefined;
    const visibleIssues=route&&routeDecision?customerRouteIssues(route,routeDecision.issues,evidence):[];
    const guideBlocked=destinationVerdict==='raised'||!!route&&routeGuideBlocked(journey?.assessments[route.id]);
    const detailRoute=routes.find(candidate=>candidate.id===detailRouteId);
    const detailAssessment=detailRoute?journey?.assessments[detailRoute.id]:undefined;
    const guiding=nav==='guide'&&!!route&&!guideBlocked;
    const activity=screen.kind==='result'?analysisActivity({routes,evidence,captures:screen.captures,phase:screen.analysis.phase,selectedId:selected,message:screen.analysis.message}):null;
    useEffect(()=>{
        if(travelMode!=='walk')return;
        if(guiding){guideHeading.current?.focus({preventScroll:true});return;}
        const previous=guideReturnFocus.current;
        if(!previous)return;
        guideReturnFocus.current=null;
        if(previous.isConnected&&!(previous instanceof HTMLButtonElement&&previous.disabled))previous.focus({preventScroll:true});
        else (document.querySelector<HTMLElement>('.route-details h2')??resultsHeading.current)?.focus({preventScroll:true});
    },[guiding,travelMode]);
    function selectGrade(routeId:string,index:number){
        const candidate=routes.find(item=>item.id===routeId),segment=candidate?.grade?.segments[index];
        if(!segment)return;
        setActiveGrade({routeId,index});setActive('');
        setFocus(segment.coords[Math.floor(segment.coords.length/2)]);
    }
    function openDetails(id:string,pointId=''){guideReturnFocus.current=null;explicitRouteSelection.current=true;if(!detailRouteId)listPosition.current=listScroll.current?.scrollTop??0;setSelected(id);if(id!==selected){setSelectionSource('manual');setActiveGrade(null);}setDetailRouteId(id);setActive(pointId);setNav(null);setStep(0);}
    function closeDetails(){returnToRoute.current=detailRouteId;setDetailRouteId(null);setEditingSearch(false);setActive('');}
    function inspectPoint(id:string){
        for(const candidate of routes){
            const point=journey?.assessments[candidate.id]?.decision.issues.find(issue=>issue.id===id)??candidate.samples.find(sample=>candidate.id+':'+sample.id===id);
            if(point){openDetails(candidate.id,id);setFocus(point.coord);return;}
        }
    }
    function stopJob(){
        request.current.controller?.abort();const jobId=request.current.jobId;request.current.jobId=null;
        if(jobId)return fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'cancel',jobId}),keepalive:true}).then(async response=>response.ok?journeySnapshotResponse.parse(await response.json()):undefined).catch(()=>undefined);
    }
    function reset(clearTrip=true) { if(clearTrip){setCommittedTrip(null);setDestinationVerdict(null);}focusResults.current=false;focusErrorNotice.current=false;focusStoppedNotice.current=false;guideReturnFocus.current=null;returnToRoute.current=null;setActiveGrade(null);setSelectionSource('default');setDetailRouteId(null);stopJob(); request.current.generation++; setScreen({ kind: 'idle' });setMapNotice(''); setSelected(''); setActive(''); setNav(null); setStep(0); setFocus(null); closeSearch(); }
    function begin(message:string){
        const previous=screen.kind==='result'?{...screen,journey:screen.journey,analysis:{...screen.analysis,phase:screen.analysis.phase==='running'?'canceled' as const:screen.analysis.phase}}:null;
        const previousSelected=selected;
        guideReturnFocus.current=null;setActiveGrade(null);setSelectionSource('default');explicitRouteSelection.current=false;returnToRoute.current=null;setDetailRouteId(null);stopJob();const controller=new AbortController();request.current={generation:request.current.generation+1,controller,jobId:null};setScreen({kind:'loading',message,previous,previousSelected});setActive('');setNav(null);setStep(0);return {generation:request.current.generation,controller,previous,previousSelected};
    }
    function cancelLoading(){
        if(screen.kind!=='loading')return;
        if(screen.previous)focusResults.current=true;else focusErrorNotice.current=true;
        stopJob();request.current.generation++;
        if(screen.previous){explicitRouteSelection.current=true;setSelected(screen.previousSelected);setScreen({...screen.previous,restoredPrevious:'canceled',analysis:{...screen.previous.analysis,message:'새 경로 검색을 중지했습니다. 이전 결과를 표시합니다.'}});}
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
        const address=/(?:대로|로|길|동|읍|면|리)\s*\d+(?:-\d+)?(?:\s|$)/u.test(query);
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
        }catch(error){if(!controller.signal.aborted)setLocationSearch({field:which,kind:'error',message:error instanceof ZodError||error instanceof SyntaxError?'받은 정보를 표시하지 못했어요. 잠시 후 다시 시도해 주세요.':error instanceof Error?error.message:'장소를 찾지 못했어요.'});}
    }
    function choose(which:LocationField,place:Place) {
        reset();
        setEditingSearch(true);
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
        return; const which = pick; reset(); setEditingSearch(true); const name = which === 'start' ? '선택한 출발지' : '선택한 도착지', place = { id: 'map-' + Date.now(), name, address: '지도에서 선택한 위치', coord }; if (which === 'start') {
        setStart(place);
        setFrom(name);
    }
    else {
        setEnd(place);
        setTo(name);
    } setPick(null); }
    async function findJourney(resolvedTrip?:CommittedTrip) {
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
            const resolvedStart=resolvedTrip?.start??await resolve('start',start,from);if(!resolvedStart)return;
            const resolvedEnd=resolvedTrip?.end??await resolve('end',end,to);if(!resolvedEnd)return;
            if(task.generation!==request.current.generation)return;
            const trip=resolvedTrip??{key:JSON.stringify([resolvedStart.id,resolvedStart.coord,resolvedEnd.id,resolvedEnd.coord,task.generation]),start:resolvedStart,end:resolvedEnd};
            setCommittedTrip(trip);
            setEditingSearch(false);
            if(modeRef.current==='transit'){focusResults.current=false;setScreen({kind:'idle'});return;}
            setScreen({kind:'loading',message:'경로를 찾고 있어요',previous:task.previous,previousSelected:task.previousSelected});
            let snapshot=journeySnapshotResponse.parse(await call({action:'journey',start:resolvedStart,end:resolvedEnd,profile,goal,imageryProvider},task.controller.signal));
            if (task.generation !== request.current.generation) return;
            request.current.jobId=snapshot.jobId;
            setEditingSearch(false);
            setSelected(orderByRoutePreference(snapshot.journey.routes,preference).find(candidate=>!routeGuideBlocked(snapshot.journey.assessments[candidate.id]))?.id??snapshot.journey.routes[0]?.id??'');
            let displayedSnapshot:JourneySnapshotResponse|undefined;
            const display=(current:JourneySnapshotResponse)=>{
                if(task.generation!==request.current.generation||task.controller.signal.aborted)return;
                if(sameJourneySnapshot(displayedSnapshot,current))return;
                displayedSnapshot=current;
                displayedNewResult=true;
                const {journey,phase,progress,captures}=current;
                setScreen({kind:'result',journey,captures,analysis:{phase,checked:progress.checked,total:progress.total,message:progress.notice}});
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
            const message=error instanceof ZodError||error instanceof SyntaxError?'받은 정보를 표시하지 못했어요. 잠시 후 다시 시도해 주세요.':error instanceof Error?error.message:'길을 찾지 못했습니다.';
            if(task.previous){setEditingSearch(false);if(!displayedNewResult){explicitRouteSelection.current=true;setSelected(task.previousSelected);}}
            if(!task.previous)focusErrorNotice.current=true;
            setScreen(previous=>previous.kind==='result'?{...previous,journey:previous.journey,analysis:{...previous.analysis,phase:'failed',message}}:previous.kind==='loading'&&previous.previous?{...previous.previous,restoredPrevious:'failed',analysis:{...previous.previous.analysis,phase:'failed',message:'새 검색에 실패했습니다. 아래는 이전 결과입니다. '+message}}:{kind:'error',message});
            const current=await canceled;
            if(current&&task.generation===request.current.generation){const completed=current.phase==='ready'||current.phase==='limited';setScreen({kind:'result',journey:current.journey,captures:current.captures,analysis:{phase:completed?current.phase:'failed',checked:current.progress.checked,total:current.progress.total,message:completed?current.progress.notice:message}});}
        }
    }
    function changeMode(mode:TravelMode){
        if(mode===modeRef.current)return;
        const trip=committedTrip;
        reset(false);modeRef.current=mode;setTravelMode(mode);setEditingSearch(!trip);setPick(null);
        if(listScroll.current)listScroll.current.scrollTop=0;
        if(trip&&mode==='walk')void findJourney(trip);
    }
    function selectRoute(id:string,source:'manual'|'preference'='manual') { guideReturnFocus.current=null;explicitRouteSelection.current=true;setSelectionSource(source);setSelected(id);setActiveGrade(null);setActive('');setNav(null);setStep(0);setFocus(null); }
    function startGuide(){
        if (!route || guideBlocked) return;
        guideReturnFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
        explicitRouteSelection.current=true;setNav('guide');setStep(0);setFocus(route.coords[0]??null);
    }
    const activityPanel=screen.kind==='result'&&activity?<div ref={screen.analysis.phase==='canceled'?stoppedNotice:undefined} tabIndex={screen.analysis.phase==='canceled'?-1:undefined} className={'analysis-activity '+(activity.busy?'progress':'notice')} role={routeFailureNotice?'alert':'status'} aria-busy={activity.busy}>
        {activity.busy&&<LoaderCircle size={18} className="spin"/>}
        <div className="analysis-activity-copy"><strong>{screen.restoredPrevious==='failed'?'새 검색에 실패했어요. 이전 결과를 표시합니다.':screen.restoredPrevious==='canceled'?'새 검색을 중지했어요. 이전 결과를 표시합니다.':activity.title}</strong><span className="analysis-activity-detail">{activity.detail}</span></div>
        {activity.busy?<button type="button" onClick={()=>{
            const generation=request.current.generation;focusStoppedNotice.current=true;
            void stopJob()?.then(current=>{
                if(current&&generation===request.current.generation){
                    if(current.phase!=='canceled'){focusStoppedNotice.current=false;focusResults.current=true;}
                    setScreen({kind:'result',journey:current.journey,captures:current.captures,analysis:{phase:current.phase,checked:current.progress.checked,total:current.progress.total,message:current.progress.notice}});
                }
            });
            setScreen({...screen,analysis:{...screen.analysis,phase:'canceled'}});
        }}>중지</button>:routeFailureNotice&&<button type="button" onClick={()=>void findJourney()}>다시 시도</button>}
    </div>:null;
    return <main className={'app'+(guiding?' is-guiding':'')}>
 <aside className={'sidebar ' + (collapsed ? 'collapsed' : '')+(detailRoute?' show-details':'')+(committedTrip?' has-results':'')+(editingSearch?' editing-search':'')}>
 <header className="sidebar-head"><div><h1>요길어때</h1><p>나에게 맞는 길로, 일상을 잇다</p></div><button className="icon-button collapse" aria-label="검색 패널 접기" onClick={() => setCollapsed(true)}><PanelLeftClose size={20}/></button></header>
 {committedTrip&&!detailRoute&&<div className="results-controls"><button type="button" aria-label="출발지·도착지 및 조건 변경" aria-expanded={editingSearch} onClick={()=>setEditingSearch(value=>!value)}><span className="search-journey-summary">{`${from} → ${to}`}</span><span>{editingSearch?'접기':'변경'}</span></button></div>}
 <div className="travel-mode-bar" role="group" aria-label="이동 방법"><button type="button" aria-pressed={travelMode==='walk'} onClick={()=>changeMode('walk')}><Footprints size={18}/>도보</button><button type="button" aria-pressed={travelMode==='transit'} onClick={()=>changeMode('transit')}><BusFront size={18}/>대중교통</button></div>
 {!detailRoute && <section className="search-section">
 <div className="locations" onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))closeSearch();}}>{locationInput('start')}{locationInput('end')}<button className="swap" aria-label="출발지와 도착지 바꾸기" onClick={() => { reset(); setFrom(to); setTo(from); setStart(end); setEnd(start); }}><ArrowUpDown size={16}/></button></div>
 <div className="pick-row"><button onClick={() => { reset(); setPick('start'); }}>출발지 지도에서 선택</button><button onClick={() => { reset(); setPick('end'); }}>도착지 지도에서 선택</button></div>
 {travelMode==='walk'&&<details className="search-options"><summary>검색 옵션</summary>
 <div className="profile-row"><label htmlFor="goal"><MapPin size={17}/> 사진 확인 범위</label><select id="goal" value={goal} onChange={event=>{const value=event.target.value;if(value==='arrival'||value==='entrance'){reset();setGoal(value);}}}><option value="arrival">지도 도착 지점 주변</option><option value="entrance">도착 주변 출입문 연결도 살펴보기</option></select></div>
 <p className="subnote">계단을 피하는 공통 기준으로 비교합니다. 경사 수치는 지형고도 추정이며 보행면 실측값이 아닙니다.</p>
 </details>}
 {editingSearch&&journey&&activityPanel}
 <button className="primary search-button" disabled={busy} onClick={()=>void findJourney()}><RouteIcon size={19}/> 경로 찾기 <ArrowRight size={18}/></button>
 <div className="location-status">{start ? <><Check size={12}/> 출발지 선택</> : <>출발지 입력</>}<span>·</span>{end ? <><Check size={12}/> 도착지 선택</> : <>도착지 입력</>}</div></section>}
 {screen.kind === 'error' && <div ref={errorNotice} tabIndex={-1} className="notice" role="alert">{screen.message} <button type="button" onClick={()=>void findJourney()}>다시 찾기</button></div>}
 {mapNotice&&<div className="notice" role="alert">{mapNotice}<button type="button" aria-label="위치 안내 닫기" onClick={()=>{setMapNotice('');locateButton.current?.focus({preventScroll:true});}}><X size={16}/></button></div>}
 {screen.kind==='loading'&&<div className="progress" role="status"><LoaderCircle size={17} className="spin"/><span>{screen.message}</span><button type="button" onClick={cancelLoading}>검색 중지</button></div>}
 {detailRoute&&detailAssessment&&screen.kind==='result'&&<RouteDetails key={detailRoute.id} route={detailRoute} goal={screen.journey.goal} phase={screen.analysis.phase} activity={activityPanel} evidence={evidence} captures={screen.captures} activeId={active} assessment={detailAssessment} destinationBlockedReason={destinationBlockedReason} gradeThreshold={gradeThreshold} activeGradeIndex={activeGrade?.routeId===detailRoute.id?activeGrade.index:null} onGradeSegment={index=>selectGrade(detailRoute.id,index)} onBack={closeDetails} onStart={startGuide} onLocate={(id,coord)=>{setActive(id);setFocus(coord);}}/>}<div className="results-scroll" ref={listScroll} hidden={!!detailRoute}>{committedTrip&&<PlaceEntrance key={JSON.stringify([committedTrip.end.id,committedTrip.end.name,committedTrip.end.coord])} place={committedTrip.end} onLocate={setFocus} onVerdict={setDestinationVerdict}/>} {travelMode==='transit'&&committedTrip?<TransitJourney key={committedTrip.key} start={committedTrip.start} end={committedTrip.end}/>:!journey?<><section className="empty-state"><div className="eyebrow">오늘의 이동</div><h2>나에게 맞는 길을<br/>사진과 함께 살펴보세요.</h2><p>출발지와 도착지를 선택해 이동 시간과 거리, 계단과 노면을 비교하세요.</p></section></>:<section className="routes-section"><div className="section-title"><h2 ref={resultsHeading} tabIndex={-1}>이동 경로 <span>{routes.length}</span></h2></div>

 <section className="route-preference" aria-label="경로 비교 기준"><div className="preference-buttons"><button type="button" aria-pressed={preference==='gentle'} onClick={()=>choosePreference('gentle')}>완만한 경사 순</button><button type="button" aria-pressed={preference==='fast'} onClick={()=>choosePreference('fast')}>빠른 시간 순</button></div></section>
 {screen.kind==='result'&&orderedRoutes.map(candidate=>{
     const assessment=journey.assessments[candidate.id];if(!assessment)return null;
     const status=routeAnalysisStatus({route:candidate,decision:assessment.decision,evidence,phase:screen.analysis.phase});
     const admission=routeAdmissionStatus(assessment);
     const selectedCandidate=candidate.id===selected;
     const selectionReason=(selectedCandidate&&selectionSource==='default'?`기본 선택 · ${preference==='gentle'&&candidate.grade?.status==='available'?'지형 경사 추정값 순':'예상 시간 순'}. `:'')+routeSelectionReason(candidate,routes,preference,selectedCandidate&&selectionSource==='manual');
     return <article key={candidate.id} data-route-id={candidate.id} className={'route-card '+(selectedCandidate?'selected':'')}>
         <button className="route-select" aria-label={candidate.name+' 선택'} aria-describedby={'route-status-'+candidate.id+' route-reason-'+candidate.id} aria-pressed={selectedCandidate} onClick={()=>selectRoute(candidate.id)}>
             <div className="route-card-top"><b>{candidate.name}</b><span id={'route-status-'+candidate.id} className="route-status" data-kind={destinationBlockedReason?'blocked':admission.kind} data-analysis-kind={status.kind}>{destinationBlockedReason?'입구에 계단·턱':admission.label}</span></div>
             <div className="route-distance">{candidate.graphSegment?<small>일부 구간</small>:<>{Math.ceil(candidate.seconds/60)}<small> 분</small></>}<span>{(candidate.distance/1000).toFixed(2)} km · 보행 기준</span></div>
             <p className="route-status-detail">{status.label}</p>
             <p className="route-selection-reason" id={'route-reason-'+candidate.id} title={selectionReason}>{selectionReason}</p>
             {candidate.grade&&candidate.grade.status!=='unavailable'&&<p className="route-metrics">{candidate.grade.status==='partial'?'확인된 구간 ':''}지형 경사 최대 약 {candidate.grade.maxAbsPercent.toFixed(1)}%</p>}
         </button>
         <button className="route-detail-button" aria-label={candidate.name+' 상세 보기'} ref={element=>{if(element)detailButtons.current.set(candidate.id,element);else detailButtons.current.delete(candidate.id);}} onClick={()=>openDetails(candidate.id)}>경로·사진 살펴보기 <ChevronRight size={15}/></button>
     </article>;
 })}
 {!detailRoute&&!editingSearch&&activityPanel}
 {route&&routeDecision&&!!visibleIssues.length&&<button type="button" className="route-review-summary" onClick={()=>openDetails(route.id)}><span>이 경로에서 살펴볼 지점 <b>{visibleIssues.length}곳</b></span><ChevronRight size={17}/></button>}
 {route&&<details className="route-map-details"><summary>경사·횡단 상세</summary><RouteTerrain route={route} threshold={gradeThreshold} activeSegmentIndex={activeGrade?.routeId===route.id?activeGrade.index:null} onSelectSegment={index=>selectGrade(route.id,index)} onPoint={(id,coord)=>{inspectPoint(id);setFocus(coord);}}/><details className="map-display-options"><summary>경사 통계 설정</summary><label>경사 통계 기준 <select aria-label="경사 통계 기준" value={gradeThreshold} onChange={event=>setGradeThreshold(Number(event.target.value))}>{[5,8,12].map(value=><option key={value} value={value}>{value}% 이상</option>)}</select></label><p className="subnote">통계 기준은 구간 수·길이 집계에만 적용해요. 경사 색상은 10%·20% 고정 기준입니다.</p></details></details>}

 </section>}</div>
 {!detailRoute&&route&&routeDecision&&<section className="selected-route-actions" aria-label="선택 경로 안내"><button className="primary full" data-admission={journey?.assessments[route.id]?.admission?.kind} disabled={guideBlocked} onClick={startGuide}>{destinationVerdict==='raised'?'이 입구로는 안내할 수 없어요':guideBlocked?routeAdmissionStatus(route?journey?.assessments[route.id]:undefined).label:'길안내 시작'} <Navigation size={18}/></button></section>}
 {guiding&&route&&<section className="guidance-summary" aria-label="안내 중인 경로"><p className="eyebrow">선택한 경로</p><h2>{route.name}</h2><p>도보 {Math.ceil(route.seconds/60)}분 · {(route.distance/1000).toFixed(2)}km</p><button type="button" onClick={()=>setNav(null)}>경로 검토로 돌아가기</button></section>}
 <footer className="sidebar-footer source-attribution"><span>지도·사진 © NAVER · 장소·길찾기 © Kakao<br/><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap 기여자 · ODbL</a> · <a href="https://www.opentopodata.org/datasets/srtm/" target="_blank" rel="noreferrer">SRTM 지형자료</a></span></footer></aside>
 <section className="map-area"><MapView showWalkLegend={travelMode==='walk'} routes={routes} selected={selected} activeId={active} assessments={journey?.assessments??{}} evidence={evidence} start={start} end={end} onPoint={point} onEvidence={inspectPoint} focus={focus} activeGrade={activeGrade} onGradeSegment={selectGrade}/>{collapsed&&<div className="map-topbar"><button className="map-button" aria-label="검색 패널 열기" onClick={()=>setCollapsed(false)}><PanelLeftOpen size={20}/></button></div>}
 {pick && <div className="pick-banner"><MapPin size={17}/> 지도에서 {pick === 'start' ? '출발지' : '도착지'}를 선택하세요<button onClick={() => setPick(null)}>취소</button></div>}
 <button ref={locateButton} className="locate map-button" aria-label="내 위치로 지도 이동" onClick={()=>{if(!navigator.geolocation){setMapNotice('이 기기에서는 현재 위치를 사용할 수 없습니다.');return;}setMapNotice('');navigator.geolocation.getCurrentPosition(position=>setFocus([position.coords.longitude,position.coords.latitude]),()=>setMapNotice('현재 위치를 찾지 못했습니다. 위치 권한을 확인해 주세요.'));}}><LocateFixed size={21}/></button>

 {guiding&&route&&<div className="navigation-panel"><div><span className="eyebrow">단계별 길안내{route.steps.length>0&&<> · {Math.min(step+1,route.steps.length)}/{route.steps.length}</>}</span><button className="icon-button guide-end" aria-label="경로 안내 닫기" onClick={()=>setNav(null)}>안내 종료 <X size={18}/></button></div><h3 ref={guideHeading} tabIndex={-1}><Navigation size={22}/>{route.steps[step]?.text??'지도에 표시된 경로를 따라 이동하세요'}</h3>{route.steps[step+1]&&<p className="nav-next"><b>다음</b> {route.steps[step+1].text}</p>}<p className="nav-note">단계를 직접 넘기는 안내예요. 현재 위치는 자동으로 추적하지 않아요.</p><button className="nav-locate" type="button" onClick={()=>setFocus(route.steps[step]?.coord??route.coords[0]??null)}><MapPin size={15}/> 안내 지점 보기</button>{route.steps.length>0&&<div className="nav-actions"><button disabled={!step} onClick={()=>{setStep(step-1);setFocus(route.steps[step-1].coord);}}>이전</button><button disabled={step>=route.steps.length-1} onClick={()=>{setStep(step+1);setFocus(route.steps[step+1].coord);}}>다음 <ArrowRight size={16}/></button></div>}<button type="button" className="guide-review" onClick={()=>setNav(null)}>경로 검토로 돌아가기</button></div>}
 </section></main>;
}
