'use client';
import {useEffect,useRef,useState} from 'react';
import type {Coord,Evidence,Place,Route} from '@/lib/domain';
import {loadKakaoMaps,type KakaoMap,type KakaoMaps,type KakaoOverlay} from '@/lib/kakao-map-sdk';

type Props = {
  routes: Route[]; selected: string; evidence: Record<string,Evidence>;
  start: Place | null; end: Place | null;
  onPoint: (point: Coord) => void; onEvidence: (id: string) => void; focus: Coord | null;
};
type MapSession = {sdk: KakaoMaps; map: KakaoMap};

export default function MapView({routes,selected,evidence,start,end,onPoint,onEvidence,focus}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const handlers = useRef({onPoint,onEvidence});
  handlers.current = {onPoint,onEvidence};
  const [session,setSession] = useState<MapSession | null>(null);
  const [failed,setFailed] = useState(false);
  const [retry,setRetry] = useState(0);

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    setFailed(false);
    setSession(null);
    loadKakaoMaps().then(sdk => {
      const element = container.current;
      if (disposed || !element) return;
      const map = new sdk.Map(element,{center: new sdk.LatLng(37.245,127.071),level:5});
      map.addControl(new sdk.ZoomControl(),sdk.ControlPosition.BOTTOMRIGHT);
      const onClick = (event: {latLng: {getLng():number; getLat():number}}) => handlers.current.onPoint([event.latLng.getLng(),event.latLng.getLat()]);
      sdk.event.addListener(map,'click',onClick);
      const observer = new ResizeObserver(() => { map.relayout(); });
      observer.observe(element);
      cleanup = () => {
        observer.disconnect();
        sdk.event.removeListener(map,'click',onClick);
        element.replaceChildren();
      };
      setSession({sdk,map});
    }).catch(() => { if (!disposed) setFailed(true); });
    return () => { disposed = true; cleanup(); };
  },[retry]);

  useEffect(() => {
    if (!session) return;
    const {sdk,map} = session;
    const overlays: KakaoOverlay[] = [];
    const events = new AbortController();
    const point = (coord: Coord) => new sdk.LatLng(coord[1],coord[0]);
    const overlay = (coord: Coord,content: HTMLElement,zIndex: number,yAnchor: number) => {
      overlays.push(new sdk.CustomOverlay({map,position:point(coord),content,zIndex,yAnchor}));
    };
    for (const route of [...routes].sort((a,b) => Number(a.id === selected) - Number(b.id === selected))) {
      const active = route.id === selected;
      overlays.push(new sdk.Polyline({map,path:route.coords.map(point),strokeColor:active ? '#176b55' : '#8192b1',strokeWeight:active ? 7 : 5,strokeOpacity:active ? 1 : .6}));
      if (!active) continue;
      for (const sample of route.samples) {
        const id = route.id + ':' + sample.id;
        const status = evidence[id]?.status ?? 'unknown';
        const colors = {blocked:'#cb514d',clear:'#258464',caution:'#d89c3f',unknown:'#87918e'};
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.setAttribute('aria-label','이 구간의 이동 환경 보기');
        dot.style.cssText = `display:block;width:12px;height:12px;padding:0;border:2px solid white;border-radius:50%;background:${colors[status]};box-shadow:0 1px 4px #0003;`;
        dot.addEventListener('mousedown',() => sdk.event.preventMap(),{signal:events.signal});
        dot.addEventListener('touchstart',() => sdk.event.preventMap(),{signal:events.signal,passive:true});
        dot.addEventListener('click',event => {
          event.stopPropagation();
          sdk.event.preventMap();
          handlers.current.onEvidence(id);
        },{signal:events.signal});
        overlay(sample.coord,dot,3,.5);
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
    return () => { events.abort(); for (const item of overlays) item.setMap(null); };
  },[session,routes,selected,evidence,start,end]);

  useEffect(() => {
    if (!session) return;
    const {sdk,map} = session;
    const route = routes.find(candidate => candidate.id === selected);
    const points = route?.coords ?? [start?.coord,end?.coord].filter((coord): coord is Coord => coord !== undefined);
    if (points.length > 1) {
      const bounds = new sdk.LatLngBounds();
      for (const coord of points) bounds.extend(new sdk.LatLng(coord[1],coord[0]));
      map.setBounds(bounds,60,60,60,60);
    } else {
      const coord = points[0];
      if (coord) { map.setCenter(new sdk.LatLng(coord[1],coord[0])); map.setLevel(3); }
    }
  },[session,routes,selected,start,end]);

  useEffect(() => {
    if (focus && session) {
      session.map.setCenter(new session.sdk.LatLng(focus[1],focus[0]));
      session.map.setLevel(2);
    }
  },[session,focus]);

  return <><div className="map" ref={container} aria-label="확대·축소하고 출발지와 도착지를 선택할 수 있는 지도"/>{failed && <div className="tile-error" role="alert">지도를 불러오지 못했습니다. <button type="button" onClick={() => setRetry(value => value + 1)}>다시 시도</button></div>}</>;
}
