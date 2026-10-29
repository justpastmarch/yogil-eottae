'use client';
import {useEffect,useRef,useState} from 'react';
import type {Coord,Place,Route,RouteAssessments} from '@/lib/domain';
import {loadNaverMaps,naverMapReloadRequired,subscribeNaverAuthFailure,type NaverMap,type NaverMaps,type NaverOverlay,type NaverMapClick} from '@/lib/naver-map-sdk';

type Props = {
  routes: Route[]; selected: string; activeId:string; assessments: RouteAssessments;
  start: Place | null; end: Place | null;
  onPoint: (point: Coord) => void; onEvidence: (id: string) => void; focus: Coord | null;
  gradeThreshold?: number; onFocus?: (coord:Coord)=>void;
};
type MapSession = {sdk:NaverMaps;map:NaverMap};

export default function MapView({routes,selected,activeId,assessments,start,end,onPoint,onEvidence,focus,gradeThreshold=8,onFocus}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const handlers = useRef({onPoint,onEvidence,onFocus});
  handlers.current = {onPoint,onEvidence,onFocus};
  const focusedMarker=useRef<string|null>(null);
  const fittedGeometry=useRef<{map:NaverMap;key:string}|null>(null);
  const clearOverlays=useRef<()=>void>(()=>{});
  const [session,setSession] = useState<MapSession | null>(null);
  const [error,setError]=useState('');
  const [retry,setRetry] = useState(0);
  const [legendOpen,setLegendOpen]=useState(false);

  useEffect(()=>{
    let disposed=false;
    let authFailed=false;
    let cleanup=()=>{};
    setError('');
    setSession(null);
    const unsubscribe=subscribeNaverAuthFailure(failure=>{
      if(disposed)return;
      authFailed=true;
      cleanup();
      setSession(null);
      setError(failure.message);
    });
    void loadNaverMaps().then(sdk=>{
      const element=container.current;
      if(disposed||authFailed||!element)return;
      const map=new sdk.Map(element,{center:new sdk.LatLng(37.245,127.071),zoom:15,zoomControl:true,zoomControlOptions:{position:sdk.Position.BOTTOM_RIGHT}});
      let listener:object|undefined;
      let observer:ResizeObserver|undefined;
      let destroyed=false;
      cleanup=()=>{
        if(destroyed)return;
        destroyed=true;
        clearOverlays.current();
        if(listener)sdk.Event.removeListener(listener);
        observer?.disconnect();
        map.destroy();
      };
      const onClick=(event:NaverMapClick)=>{
        const target=event.originalEvent?.target;
        if(target instanceof Element&&target.closest('[data-map-overlay]'))return;
        handlers.current.onPoint([event.coord.lng(),event.coord.lat()]);
      };
      listener=sdk.Event.addListener(map,'click',onClick);
      observer=new ResizeObserver(()=>map.autoResize());
      observer.observe(element);
      setSession({sdk,map});
    }).catch(failure=>{
      cleanup();
      if(!disposed)setError(failure instanceof Error?failure.message:'네이버 지도를 불러오지 못했습니다.');
    });
    return()=>{disposed=true;unsubscribe();cleanup();};
  },[retry]);

  useEffect(() => {
    if (!session) return;
    const {sdk,map} = session;
    const overlays:NaverOverlay[]=[];
    const events = new AbortController();
    const point = (coord: Coord) => new sdk.LatLng(coord[1],coord[0]);
    const overlay=(coord:Coord,content:HTMLElement,zIndex:number,yAnchor:number)=>{
      const wrapper=document.createElement('div');
      wrapper.style.width='max-content';
      content.style.transform=`translate(-50%,-${yAnchor*100}%)`;
      content.style.whiteSpace='nowrap';
      const interactive=content instanceof HTMLButtonElement;
      if(interactive){
        wrapper.dataset.mapOverlay='true';
        for(const eventName of ['mousedown','touchstart','click','dblclick'])wrapper.addEventListener(eventName,event=>event.stopPropagation(),{signal:events.signal});
      }
      wrapper.appendChild(content);
      overlays.push(new sdk.Marker({map,position:point(coord),icon:{content:wrapper,anchor:{x:0,y:0}},zIndex,clickable:interactive,draggable:false}));
    };
    for (const route of [...routes].sort((a,b) => Number(a.id === selected) - Number(b.id === selected))) {
      const active = route.id === selected;
      overlays.push(new sdk.Polyline({map,path:route.coords.map(point),strokeColor:'#8b95a3',strokeWeight:active?7:5,strokeOpacity:active?1:.6,strokeStyle:route.graphSegment?'shortdash':'solid',zIndex:active?2:1,clickable:false}));
      if (!active) continue;
      if(route.grade&&route.grade.status!=='unavailable')for(const segment of route.grade.segments){
        const steep=Math.abs(segment.gradePercent)>=gradeThreshold;
        overlays.push(new sdk.Polyline({map,path:segment.coords.map(point),strokeColor:steep?'#9f1239':'#0f766e',strokeWeight:9,strokeOpacity:.85,strokeStyle:segment.gradePercent<0?'shortdash':'solid',zIndex:3,clickable:false}));
      }
      for(const [index,sample] of route.samples.filter(item=>item.target==='crossing-entry').sort((a,b)=>a.along-b.along).entries()){
        const badge=document.createElement('button');
        badge.type='button';badge.textContent=`횡단 ${index+1}`;
        badge.className='crossing-map-label';
        badge.setAttribute('aria-label',`횡단 진입점 ${index+1}, 출발 후 ${Math.round(sample.along)}m, 지도 위치`);
        badge.addEventListener('click',event=>{event.stopPropagation();handlers.current.onFocus?.(sample.coord);},{signal:events.signal});
        overlay(sample.coord,badge,5,1.8);
      }
      for(const sample of assessments[route.id]?.decision?.issues??[]){
        const id=sample.id,status=sample.status;
        const providerRestriction=status==='blocked'&&(sample.source==='provider'||sample.source==='osm');
        const colors = {blocked:'#e53e3e',clear:'#258464',caution:'#dd6b20',unknown:'#a0aec0'};
        const sizes = {blocked:18,clear:14,caution:14,unknown:10};
        const needsAttention=status==='unknown'&&(sample.source!=='coverage'||route.samples.some(point=>point.id===sample.sampleId&&point.critical));
        const size = needsAttention?16:sizes[status];
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.dataset.evidenceId=id;
        dot.setAttribute('aria-label',`${Math.round(sample.along)}m · ${providerRestriction?(sample.source==='osm'?'보행망 지도의 계단·접근 제한 · 영상 판독 아님':'길찾기의 계단 안내 · 영상으로 확인한 장애 아님'):sample.source==='service'?'처리 실패':status==='blocked'?'영상에서 장애 확인 · 우회 필요':status==='caution'?'확인된 주의 요소':status==='clear'?'이동 통로 관찰':'추가 확인 필요'} · ${sample.reason}`);
        dot.setAttribute('aria-pressed',String(activeId===id));
        dot.style.cssText = `display:grid;place-items:center;width:${size}px;height:${size}px;padding:0;border:${status === 'blocked' ? '3px' : '2px'} solid white;border-radius:50%;background:${providerRestriction?'#a16207':colors[status]};box-shadow:${activeId===id?'0 0 0 4px #163f76, 0 2px 6px #0004':'0 2px 6px #0004'};color:white;font-weight:bold;font-size:10px;cursor:pointer;`;
        if (status === 'blocked') dot.textContent = providerRestriction?(sample.source==='osm'?'지':'계'):'!';
        dot.addEventListener('click',event => {
          event.stopPropagation();
          handlers.current.onEvidence(id);
        },{signal:events.signal});
        const priority=status==='blocked'?(providerRestriction?9:10):status==='caution'?8:needsAttention?7:status==='clear'?6:2;
        overlay(sample.coord,dot,priority,.5);
        if(focusedMarker.current===id)dot.focus({preventScroll:true});
      }
    }
    for (const [place,label,color] of [[start,'출','#176b55'],[end,'도','#343e5a']] satisfies [Place | null,string,string][]) {
      if (!place) continue;
      const pin = document.createElement('div');
      pin.textContent = label;
      pin.setAttribute('aria-label',label === '출' ? '출발지' : '도착지');
      pin.style.cssText = `display:grid;place-items:center;width:32px;height:32px;border:3px solid white;border-radius:50%;background:${color};color:white;box-shadow:0 3px 10px #0003;font-size:11px;`;
      overlay(place.coord,pin,4,1);
    }
    focusedMarker.current=null;
    let removed=false;
    const cleanup=()=>{
      if(removed)return;
      removed=true;
      const active=document.activeElement;
      focusedMarker.current=active instanceof HTMLElement?active.dataset.evidenceId??null:null;
      events.abort();
      for(const item of overlays)item.setMap(null);
      if(clearOverlays.current===cleanup)clearOverlays.current=()=>{};
    };
    clearOverlays.current=cleanup;
    return cleanup;
  },[session,routes,selected,activeId,assessments,start,end,gradeThreshold]);

  useEffect(() => {
    if (!session) return;
    const {sdk,map} = session;
    const route = routes.find(candidate => candidate.id === selected);
    const points = route?.graphSegment?[...route.coords,...[start?.coord,end?.coord].filter((coord):coord is Coord=>coord!==undefined)]:route?.coords ?? [start?.coord,end?.coord].filter((coord): coord is Coord => coord !== undefined);
    const key=JSON.stringify(points);
    if(fittedGeometry.current?.map===map&&fittedGeometry.current.key===key)return;
    fittedGeometry.current={map,key};
    if (points.length > 1) {
      map.fitBounds(points.map(coord=>new sdk.LatLng(coord[1],coord[0])),{top:60,right:60,bottom:60,left:60});
    } else {
      const coord = points[0];
      if(coord){map.setCenter(new sdk.LatLng(coord[1],coord[0]));map.setZoom(17,false);}
    }
  },[session,routes,selected,start,end]);

  useEffect(() => {
    if (focus && session) {
      session.map.setCenter(new session.sdk.LatLng(focus[1],focus[0]));
      session.map.setZoom(18,false);
    }
  },[session,focus]);

  return (
    <>
      <div className="map" ref={container} style={{width:'100%',height:'100%'}} aria-label="확대·축소하고 출발지와 도착지를 선택할 수 있는 지도"/>
      {error&&<div className="tile-error" role="alert">{error} {naverMapReloadRequired()&&<p>페이지를 새로고침하면 경로 선택이 초기화됩니다.</p>}<button type="button" onClick={()=>{if(naverMapReloadRequired())window.location.reload();else setRetry(value=>value+1);}}>{naverMapReloadRequired()?'페이지 새로고침':'다시 시도'}</button></div>}
      <aside className="map-legend-card" aria-label="통행 환경 상태 범례">
        <button type="button" className="legend-toggle" aria-expanded={legendOpen} aria-controls="map-legend-entries" onClick={()=>setLegendOpen(value=>!value)}>통행 상태 범례 {legendOpen?'접기':'보기'}</button>
        <div id="map-legend-entries" className={'legend-entries'+(legendOpen?' is-open':'')}>
        <div className="legend-row"><span className="legend-badge clear"/> 이동 통로 관찰</div>
        <div className="legend-row"><span className="legend-badge caution"/> 확인된 주의 요소</div>
        <div className="legend-row"><span className="legend-badge provider">계/지</span> 경로·보행망 지도 제한 · 영상 판독 아님</div>
        <div className="legend-row"><span className="legend-badge blocked">!</span> 영상에서 장애 확인 · 우회 필요</div>
        <div className="legend-row"><span className="legend-badge unknown"/> 미확인 또는 처리 대기</div>
        <div className="legend-row">경사 색선 · 30m 지형고도 기반 추정</div>
        <div className="legend-row"><span className="legend-badge" style={{background:'#9f1239'}}/> 절대 경사 {gradeThreshold}% 이상 · 통행 불가 판정 아님</div>
        <div className="legend-row">실선 오르막 · 점선 내리막 · 횡단 번호는 지도 위치</div>
        <div className="legend-row">회색 선은 경로 표시이며 지점 사이 통행을 확인한 뜻이 아닙니다.</div>
        </div>
      </aside>
    </>
  );
}
