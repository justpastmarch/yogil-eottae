'use client';
import {useEffect,useRef,useState} from 'react';
import type {Coord,Evidence,Place,Route,RouteAssessments} from '@/lib/domain';
import {loadNaverMaps,naverMapReloadRequired,subscribeNaverAuthFailure,type NaverMap,type NaverMaps,type NaverOverlay,type NaverMapClick} from '@/lib/naver-map-sdk';
import {GRADE_BANDS,UNKNOWN_GRADE,gradeBand} from './grade-colors.ts';
import {customerRouteIssues,routeIssueTitle,type GradeSelection} from './route-presentation';

type Props = {
  routes: Route[]; selected: string; activeId:string; assessments: RouteAssessments; evidence:Record<string,Evidence>;
  start: Place | null; end: Place | null;
  onPoint: (point: Coord) => void; onEvidence: (id: string) => void; focus: Coord | null;
  activeGrade:GradeSelection|null; onGradeSegment:(routeId:string,index:number)=>void;
  showWalkLegend?:boolean;
};
type MapSession = {sdk:NaverMaps;map:NaverMap};
type PopupState={routeId:string;fetchedAt:string;open:Set<string>;scroll:Map<string,number>};

export default function MapView({routes,selected,activeId,assessments,evidence,start,end,onPoint,onEvidence,focus,activeGrade,onGradeSegment,showWalkLegend=true}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const popupHost=useRef<HTMLDivElement>(null);
  const handlers = useRef({onPoint,onEvidence,onGradeSegment});
  handlers.current = {onPoint,onEvidence,onGradeSegment};
  const focusedMarker=useRef<string|null>(null);
  const fittedGeometry=useRef<{map:NaverMap;key:string}|null>(null);
  const clearOverlays=useRef<()=>void>(()=>{});
  const redrawCrossings=useRef<()=>void>(()=>{});
  const popupState=useRef<PopupState|null>(null);
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
      const map=new sdk.Map(element,{center:new sdk.LatLng(37.245,127.071),zoom:15,zoomControl:true,zoomControlOptions:{position:sdk.Position.RIGHT_TOP,style:element.clientHeight<500?sdk.ZoomControlStyle.SMALL:sdk.ZoomControlStyle.LARGE}});
      let controlLayout='';
      const updateControls=()=>{
        const next=element.clientHeight<160?'hidden':element.clientHeight<500?'compact':'full';
        if(next===controlLayout)return;
        controlLayout=next;
        element.dataset.zoomLayout=next;
        map.setOptions({zoomControl:next!=='hidden',zoomControlOptions:{position:sdk.Position.RIGHT_TOP,style:next==='full'?sdk.ZoomControlStyle.LARGE:sdk.ZoomControlStyle.SMALL}});
      };
      updateControls();
      let listener:object|undefined;
      let observer:ResizeObserver|undefined;
      let destroyed=false;
      cleanup=()=>{
        if(destroyed)return;
        destroyed=true;
        clearOverlays.current();
        if(listener)sdk.Event.removeListener(listener);
        observer?.disconnect();
        delete element.dataset.zoomLayout;
        map.destroy();
      };
      const onClick=(event:NaverMapClick)=>{
        const target=event.originalEvent?.target;
        if(target instanceof Element&&target.closest('[data-map-overlay]'))return;
        handlers.current.onPoint([event.coord.lng(),event.coord.lat()]);
      };
      listener=sdk.Event.addListener(map,'click',onClick);
      observer=new ResizeObserver(()=>{map.autoResize();updateControls();redrawCrossings.current();});
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
    const listeners:object[]=[];
    const events = new AbortController();
    const buttons=new Map<string,HTMLElement>();
    let crossingOverlays:NaverOverlay[]=[];
    let crossingEvents=new AbortController();
    const point = (coord: Coord) => new sdk.LatLng(coord[1],coord[0]);
    const overlay=(coord:Coord,content:HTMLElement,zIndex:number,yAnchor:number,target:NaverOverlay[]=overlays,signal:AbortSignal=events.signal)=>{
      const wrapper=document.createElement('div');
      wrapper.style.width='max-content';
      content.style.transform=`translate(-50%,-${yAnchor*100}%)`;
      const interactive=content.matches('button,details')||!!content.querySelector('button');
      wrapper.style.pointerEvents=interactive?'auto':'none';
      if(interactive){
        wrapper.dataset.mapOverlay='true';
        for(const eventName of ['mousedown','touchstart','click','dblclick','pointerdown','wheel'])wrapper.addEventListener(eventName,event=>event.stopPropagation(),{signal});
      }
      wrapper.appendChild(content);
      target.push(new sdk.Marker({map,position:point(coord),icon:{content:wrapper,anchor:{x:0,y:0}},zIndex,clickable:interactive,draggable:false}));
    };
    for (const route of [...routes].sort((a,b) => Number(a.id === selected) - Number(b.id === selected))) {
      const active = route.id === selected;
      overlays.push(new sdk.Polyline({map,path:route.coords.map(point),strokeColor:UNKNOWN_GRADE.color,strokeWeight:active?7:5,strokeOpacity:active?1:.6,strokeStyle:route.graphSegment?'shortdash':'solid',zIndex:active?3:1,clickable:false}));
      if (!active) continue;
      if(route.grade&&route.grade.status!=='unavailable')for(const [index,segment] of route.grade.segments.entries()){
        const chosen=activeGrade?.routeId===route.id&&activeGrade.index===index;
        if(chosen)overlays.push(new sdk.Polyline({map,path:segment.coords.map(point),strokeColor:'#213b34',strokeWeight:13,strokeOpacity:1,strokeStyle:route.graphSegment?'shortdash':'solid',zIndex:3,clickable:false}));
        const line=new sdk.Polyline({map,path:segment.coords.map(point),strokeColor:gradeBand(segment.gradePercent).color,strokeWeight:7,strokeOpacity:1,strokeStyle:route.graphSegment?'shortdash':'solid',zIndex:4,clickable:true});
        overlays.push(line);
        listeners.push(sdk.Event.addListener(line,'click',event=>{
          event.originalEvent?.stopPropagation();
          handlers.current.onGradeSegment(route.id,index);
        }));
      }
      for(const sample of customerRouteIssues(route,assessments[route.id]?.decision.issues??[],evidence)){
        const id=sample.id,status=sample.status;
        const finding=evidence[id]?.finding;
        const observedStairs=sample.source==='imagery'&&status==='blocked'&&(finding?.observation?.connection==='stairs'||finding?.features?.stairs.state==='present');
        const structuralUnknown=status==='unknown'&&route.unverifiedConnections?.some(connection=>connection.id===sample.sampleId);
        const providerRestriction=status==='blocked'&&(sample.source==='provider'||sample.source==='osm');
        const colors = {blocked:'#e53e3e',clear:'#64748b',caution:'#dd6b20',unknown:'#a0aec0'};
        const sizes = {blocked:18,clear:14,caution:14,unknown:10};
        const needsAttention=status==='unknown'&&(sample.source!=='coverage'||route.samples.some(point=>point.id===sample.sampleId&&point.critical));
        const size = observedStairs?28:needsAttention?16:sizes[status];
        const dot = document.createElement('button');
        dot.type = 'button';dot.className='map-evidence-hit';
        dot.dataset.evidenceId=id;dot.dataset.mapFocusKey=id;
        dot.setAttribute('aria-label',`${Math.round(sample.along)}m · ${observedStairs?'계단 관찰 · 지점 근거 보기':routeIssueTitle(route,sample)}`);
        dot.setAttribute('aria-pressed',String(activeId===id));
        const visual=document.createElement('span');
        visual.className='map-evidence-dot';
        visual.style.cssText=`width:${size}px;height:${size}px;border-width:${status==='blocked'?3:2}px;background:${structuralUnknown?'#ea580c':providerRestriction?'#a16207':colors[status]};`;
        if(observedStairs){
          visual.classList.add('map-stairs-icon');
          const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
          svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width','20');svg.setAttribute('height','20');svg.setAttribute('aria-hidden','true');
          const path=document.createElementNS('http://www.w3.org/2000/svg','path');
          path.setAttribute('d','M3 20h5v-5h5v-5h5V5h3');path.setAttribute('fill','none');path.setAttribute('stroke','currentColor');path.setAttribute('stroke-width','2.5');path.setAttribute('stroke-linejoin','round');
          svg.appendChild(path);visual.appendChild(svg);
        }else if(status==='blocked')visual.textContent=providerRestriction?(sample.source==='osm'?'지':'계'):'!';
        dot.appendChild(visual);
        dot.addEventListener('click',event=>{event.stopPropagation();handlers.current.onEvidence(id);},{signal:events.signal});
        const priority=status==='blocked'?(providerRestriction?19:20):status==='caution'?18:needsAttention?17:status==='clear'?16:12;
        overlay(sample.coord,dot,priority,.5);
        buttons.set(id,dot);
      }
    }
    const selectedRoute=routes.find(route=>route.id===selected);
    const clusterState=popupState.current??(popupState.current={routeId:'',fetchedAt:'',open:new Set<string>(),scroll:new Map<string,number>()});
    if(clusterState.routeId!==(selectedRoute?.id??'')||clusterState.fetchedAt!==(selectedRoute?.fetchedAt??'')){
      clusterState.open.clear();clusterState.scroll.clear();clusterState.routeId=selectedRoute?.id??'';clusterState.fetchedAt=selectedRoute?.fetchedAt??'';
    }
    const crossings=selectedRoute?.samples.filter(sample=>sample.target==='crossing-entry').sort((a,b)=>a.along-b.along)??[];
    const crossingIcon=()=>{
      const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
      svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width','18');svg.setAttribute('height','18');
      svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false');
      const stripes=document.createElementNS('http://www.w3.org/2000/svg','path');
      stripes.setAttribute('d','M4 5h16M4 19h16M6 9v6m6-6v6m6-6v6');
      stripes.setAttribute('fill','none');stripes.setAttribute('stroke','currentColor');stripes.setAttribute('stroke-width','3');
      svg.appendChild(stripes);
      const icon=document.createElement('span');icon.className='crossing-map-icon';icon.appendChild(svg);
      return icon;
    };
    const drawCrossings=()=>{
      const active=document.activeElement;
      const restoreKey=active instanceof HTMLElement&&active.dataset.mapFocusKey?active.dataset.mapFocusKey:focusedMarker.current;
      crossingEvents.abort();
      crossingEvents=new AbortController();
      popupHost.current?.replaceChildren();
      for(const item of crossingOverlays)item.setMap(null);
      crossingOverlays=[];
      const crossingButtons=new Map<string,HTMLElement>();
      const projection=map.getProjection();
      const groups:{items:{sample:Route['samples'][number];index:number;x:number;y:number}[]}[]=[];
      for(const [index,sample] of crossings.entries()){
        const offset=projection.fromCoordToOffset(point(sample.coord));
        const item={sample,index,x:offset.x,y:offset.y};
        const nearby=groups.filter(group=>group.items.some(existing=>Math.abs(existing.x-item.x)<100&&Math.abs(existing.y-item.y)<56));
        const group=nearby[0];
        if(!group)groups.push({items:[item]});
        else{
          group.items.push(item);
          for(const other of nearby.slice(1)){
            group.items.push(...other.items);
            groups.splice(groups.indexOf(other),1);
          }
        }
      }
      for(const group of groups){
        const first=group.items[0];
        if(!first||!selectedRoute)continue;
        group.items.sort((a,b)=>a.index-b.index);
        const makeButton=(item:typeof first,onActivate?:()=>void)=>{
          const id=`${selectedRoute.id}:${item.sample.id}`;
          const badge=document.createElement('button');
          badge.type='button';badge.className='crossing-map-label';
          badge.textContent=`횡단 ${item.index+1}`;
          badge.dataset.evidenceId=id;badge.dataset.mapFocusKey=id;
          badge.setAttribute('aria-label',`횡단 진입점 ${item.index+1}, 출발 후 ${Math.round(item.sample.along)}m, 지점 근거 보기`);
          badge.setAttribute('aria-pressed',String(activeId===id));
          badge.addEventListener('click',event=>{event.stopPropagation();onActivate?.();handlers.current.onEvidence(id);},{signal:crossingEvents.signal});
          crossingButtons.set(id,badge);
          return badge;
        };
        if(group.items.length===1){
          const marker=makeButton(first);
          marker.classList.add('crossing-map-marker');marker.replaceChildren(crossingIcon());
          overlay(first.sample.coord,marker,25,.5,crossingOverlays,crossingEvents.signal);
          continue;
        }
        const host=popupHost.current;
        if(!host)continue;
        const ids=group.items.map(item=>`${selectedRoute.id}:${item.sample.id}`);
        const key=ids.join('|');
        const cluster=document.createElement('details');
        cluster.className='crossing-map-cluster';cluster.dataset.crossingCount=String(ids.length);
        cluster.open=clusterState.open.has(key)||!!restoreKey&&!restoreKey.startsWith('cluster:')&&ids.includes(restoreKey);
        const summary=document.createElement('summary');
        summary.appendChild(crossingIcon());
        summary.dataset.mapFocusKey=`cluster:${ids[0]}`;
        summary.setAttribute('aria-label',`가까운 횡단 진입점 ${ids.length}곳, 펼쳐서 지점 선택`);
        crossingButtons.set(`cluster:${ids[0]}`,summary);
        const choices=document.createElement('div');choices.className='crossing-cluster-choices';
        choices.id=`crossing-options-${ids[0]}`;
        choices.setAttribute('role','group');choices.setAttribute('aria-label','횡단 지점 선택');
        summary.setAttribute('aria-controls',choices.id);
        function closeCluster(){cluster.open=false;clusterState.open.delete(key);choices.style.display='none';}
        for(const item of group.items){
          const button=makeButton(item,()=>{closeCluster();summary.focus({preventScroll:true});});
          button.textContent=`횡단 ${item.index+1} · ${Math.round(item.sample.along)}m`;
          choices.appendChild(button);
        }
        cluster.appendChild(summary);
        host.appendChild(choices);
        choices.addEventListener('scroll',()=>{if(cluster.open)clusterState.scroll.set(key,choices.scrollTop);},{signal:crossingEvents.signal});
        cluster.addEventListener('toggle',()=>{
          choices.style.display=cluster.open?'grid':'none';
          if(cluster.open){clusterState.open.add(key);fitChoices();choices.scrollTop=clusterState.scroll.get(key)??0;}
          else clusterState.open.delete(key);
        },{signal:crossingEvents.signal});
        document.addEventListener('pointerdown',event=>{
          if(cluster.open&&event.target instanceof Element&&!cluster.contains(event.target)&&!choices.contains(event.target))closeCluster();
        },{signal:crossingEvents.signal,capture:true});
        choices.addEventListener('keydown',event=>{
          if(event.key==='Escape'){event.preventDefault();closeCluster();summary.focus({preventScroll:true});}
        },{signal:crossingEvents.signal});
        overlay(first.sample.coord,cluster,26,.5,crossingOverlays,crossingEvents.signal);
        function fitChoices(){
          const bounds=container.current?.getBoundingClientRect(),anchor=summary.getBoundingClientRect();
          if(!bounds||!bounds.height||!anchor.height)return;
          const width=Math.min(190,bounds.width-16),topLimit=bounds.height<132?8:bounds.top+8,bottomLimit=bounds.bottom-24;
          const above=anchor.top-topLimit-5,below=bottomLimit-anchor.bottom-5,available=Math.max(above,below);
          choices.style.width=`${width}px`;
          choices.style.left=`${Math.max(bounds.left+8,Math.min(anchor.left+(anchor.width-width)/2,bounds.right-width-8))-bounds.left}px`;
          choices.style.maxHeight=`${Math.min(240,Math.max(60,available>=60?available:bottomLimit-topLimit))}px`;
          const height=Math.min(choices.scrollHeight,parseFloat(choices.style.maxHeight));
          choices.style.top=`${Math.max(topLimit,Math.min(above>below?anchor.top-height-5:anchor.bottom+5,bottomLimit-height))-bounds.top}px`;
        }
        choices.style.display=cluster.open?'grid':'none';
        fitChoices();
        if(cluster.open)choices.scrollTop=clusterState.scroll.get(key)??0;
      }
      if(restoreKey){
        const target=crossingButtons.get(restoreKey)??(restoreKey.startsWith('cluster:')?crossingButtons.get(restoreKey.slice(8)):undefined)??buttons.get(restoreKey);
        target?.focus({preventScroll:true});
      }
      focusedMarker.current=null;
    };
    redrawCrossings.current=drawCrossings;
    listeners.push(sdk.Event.addListener(map,'idle',drawCrossings));
    const walkCoords=selectedRoute&&!selectedRoute.graphSegment?selectedRoute.coords:undefined;
    for (const [place,endpoint,color] of [[start,'start','#16a34a'],[end,'end','#ef4444']] satisfies [Place | null,'start'|'end',string][]) {
      if (!place) continue;
      const pin = document.createElement('div');
      pin.className='endpoint-map-pin';
      pin.dataset.endpoint=endpoint;
      pin.setAttribute('role','img');
      pin.setAttribute('aria-label',endpoint === 'start' ? (walkCoords?'도보 출발점':'출발지') : (walkCoords?'도보 도착점':'도착지'));
      const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
      svg.setAttribute('width','32');svg.setAttribute('height','42');svg.setAttribute('viewBox','0 0 32 42');
      svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false');
      const body=document.createElementNS('http://www.w3.org/2000/svg','path');
      body.setAttribute('d','M16 41C13 36 1 26 1 16a15 15 0 0 1 30 0c0 10-12 20-15 25Z');
      body.setAttribute('fill',color);body.setAttribute('stroke','white');body.setAttribute('stroke-width','2');body.setAttribute('stroke-linejoin','round');
      const center=document.createElementNS('http://www.w3.org/2000/svg','circle');
      center.setAttribute('cx','16');center.setAttribute('cy','16');center.setAttribute('r','5');center.setAttribute('fill','white');
      svg.appendChild(body);svg.appendChild(center);
      pin.appendChild(svg);
      overlay((endpoint==='start'?walkCoords?.[0]:walkCoords?.[walkCoords.length-1])??place.coord,pin,30,1);
    }
    drawCrossings();
    let removed=false;
    const cleanup=()=>{
      if(removed)return;
      removed=true;
      const active=document.activeElement;
      focusedMarker.current=active instanceof HTMLElement?active.dataset.mapFocusKey??null:null;
      redrawCrossings.current=()=>{};
      events.abort();crossingEvents.abort();
      popupHost.current?.replaceChildren();
      for(const listener of listeners)sdk.Event.removeListener(listener);
      for(const item of [...overlays,...crossingOverlays])item.setMap(null);
      if(clearOverlays.current===cleanup)clearOverlays.current=()=>{};
    };
    clearOverlays.current=cleanup;
    return cleanup;
  },[session,routes,selected,activeId,activeGrade,assessments,evidence,start,end]);

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
      <div className="map-popover-host" ref={popupHost}/>
      {error&&<div className="tile-error" role="alert">{error} {naverMapReloadRequired()&&<p>페이지를 새로고침하면 경로 선택이 초기화됩니다.</p>}<button type="button" onClick={()=>{if(naverMapReloadRequired())window.location.reload();else setRetry(value=>value+1);}}>{naverMapReloadRequired()?'페이지 새로고침':'다시 시도'}</button></div>}
      {showWalkLegend&&<aside className="map-legend-card" aria-label="통행 환경 상태 범례">
        <button type="button" className="legend-toggle" aria-expanded={legendOpen} aria-controls="map-legend-entries" onClick={()=>setLegendOpen(value=>!value)}>통행 상태 범례 {legendOpen?'접기':'보기'}</button>
        <div id="map-legend-entries" className={'legend-entries'+(legendOpen?' is-open':'')}>
        {GRADE_BANDS.map(band=><div className="legend-row" key={band.className}><span className={`legend-grade-line ${band.className}`} style={{background:band.color}}/> 경사 {band.label}</div>)}
        <div className="legend-row"><span className={`legend-grade-line ${UNKNOWN_GRADE.className}`} style={{background:UNKNOWN_GRADE.color}}/> {UNKNOWN_GRADE.label} · 일반 경로·빈 구간</div>
        <div className="legend-row"><span className="legend-badge caution"/> 고르지 않은 노면</div>
        <div className="legend-row"><span className="legend-badge provider">계/지</span> 지도에 계단·출입 제한</div>
        <div className="legend-row"><span className="legend-badge blocked">!</span> 사진에 계단·턱</div>
        <div className="legend-row"><span className="legend-badge unknown"/> 사진·연결 미확인</div>
        <div className="legend-row"><span className="legend-active-grade-line"/> 선택한 경사 구간</div>
        <div className="legend-row">경사 색상은 오르막·내리막 절댓값 · 10%·20% 고정 기준</div>
        <div className="legend-row">지형자료 추정 · 통행 가능 판정이 아닙니다</div>
        </div>
      </aside>}
    </>
  );
}
