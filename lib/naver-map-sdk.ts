import {z} from 'zod';

export interface NaverLatLng {lat():number;lng():number}
type NaverZoomOptions={position:number;style:number};
export interface NaverMap {
  setCenter(point:NaverLatLng):void;
  setZoom(zoom:number,useEffect?:boolean):void;
  setOptions(options:{zoomControl:boolean;zoomControlOptions:NaverZoomOptions}):void;
  fitBounds(points:NaverLatLng[],margins:{top:number;right:number;bottom:number;left:number}):void;
  getProjection():{fromCoordToOffset(point:NaverLatLng):{x:number;y:number}};
  autoResize():void;
  destroy():void;
}
export interface NaverOverlay {setMap(map:NaverMap|null):void}
export interface NaverMapClick {coord:NaverLatLng;originalEvent?:Event}
export interface NaverPov {pan:number;tilt:number;fov:number}
export interface NaverPanorama {
  getPanoId():string;
  getPov():NaverPov;
  getLocation():{panoId:string;coord:NaverLatLng;photodate:string};
  setPov(pov:NaverPov):void;
  setSize(size:{width:number;height:number}):void;
  setVisible(visible:boolean):void;
}
export interface NaverMaps {
  Map:new(container:HTMLElement,options:{center:NaverLatLng;zoom:number;zoomControl:boolean;zoomControlOptions:NaverZoomOptions})=>NaverMap;
  LatLng:new(latitude:number,longitude:number)=>NaverLatLng;
  Polyline:new(options:{map:NaverMap;path:NaverLatLng[];strokeWeight:number;strokeColor:string;strokeOpacity:number;strokeStyle:'solid'|'shortdash';zIndex:number;clickable:boolean})=>NaverOverlay;
  Marker:new(options:{map:NaverMap;position:NaverLatLng;icon:{content:HTMLElement;anchor:{x:number;y:number}};zIndex:number;clickable:boolean;draggable:false})=>NaverOverlay;
  Panorama:new(container:HTMLElement,options:({panoId:string;position?:never}|{position:NaverLatLng;panoId?:never})&{pov:NaverPov})=>NaverPanorama;
  Position:{RIGHT_TOP:number};
  ZoomControlStyle:{LARGE:number;SMALL:number};
  Event:{
    addListener(target:NaverMap|NaverOverlay,type:'click',callback:(event:NaverMapClick)=>void):object;
    addListener(target:NaverMap,type:'idle',callback:()=>void):object;
    addListener(target:NaverPanorama,type:'init'|'pano_changed'|'pov_changed',callback:()=>void):object;
    addListener(target:NaverPanorama,type:'pano_status',callback:(status:string)=>void):object;
    removeListener(listener:object):void;
  };
}
declare global {
  interface Window {
    naver?:{maps?:NaverMaps};
    navermap_authFailure?:()=>void;
    [callback:`__gileumNaverReady${number}`]:(()=>void)|undefined;
  }
}

const mapConfigSchema=z.object({clientId:z.string().min(1).max(256).regex(/^[a-zA-Z0-9_-]+$/)});
const configurationError=z.object({error:z.string().min(1).max(300)});
const authListeners=new Set<(error:Error)=>void>();
let pending:Promise<NaverMaps>|undefined;
let ownedScript:HTMLScriptElement|undefined;
let rejectLoading:((error:Error)=>void)|undefined;
let sequence=0;
let scriptStarted=false;

export function naverMapReloadRequired():boolean {return scriptStarted;}

export function subscribeNaverAuthFailure(listener:(error:Error)=>void):()=>void {
  authListeners.add(listener);
  return ()=>{authListeners.delete(listener);};
}

export function loadNaverMaps():Promise<NaverMaps>{
  if(pending)return pending;
  // The SDK's unparameterized auth callback cannot distinguish an obsolete script from a retry.
  if(scriptStarted)return Promise.reject(new Error('네이버 지도 연결을 다시 시도하려면 페이지를 새로고침해 주세요.'));
  window.navermap_authFailure=()=>{
    const error=new Error('네이버 지도 인증에 실패했습니다. Client ID, Dynamic Map 사용 설정과 등록 도메인을 확인해 주세요.');
    pending=undefined;
    ownedScript?.remove();
    ownedScript=undefined;
    rejectLoading?.(error);
    for(const listener of authListeners)listener(error);
  };
  const {promise:attempt,resolve,reject}=Promise.withResolvers<NaverMaps>();
  pending=attempt;
  const controller=new AbortController();
  const callback:`__gileumNaverReady${number}`=`__gileumNaverReady${++sequence}`;
  let script:HTMLScriptElement|undefined;
  let settled=false;
  const finish=(result:{kind:'ready';maps:NaverMaps}|{kind:'failed';error:Error})=>{
    if(settled)return;
    settled=true;
    clearTimeout(timer);
    controller.abort();
    if(script){script.onload=null;script.onerror=null;}
    // A removed script can still call back late; never route that callback into a newer attempt.
    if(script)window[callback]=()=>{};
    else delete window[callback];
    if(rejectLoading===fail)rejectLoading=undefined;
    if(result.kind==='ready')resolve(result.maps);
    else {
      script?.remove();
      if(ownedScript===script)ownedScript=undefined;
      reject(result.error);
    }
  };
  const fail=(error:Error)=>finish({kind:'failed',error});
  rejectLoading=fail;
  const timer=setTimeout(()=>fail(new Error('네이버 지도 응답 시간이 초과되었습니다. 연결을 확인한 뒤 다시 시도해 주세요.')),15000);
  // Naver calls the ready callback before the executing script finishes registering constructors.
  window[callback]=()=>queueMicrotask(()=>{
    if(settled)return;
    const maps=window.naver?.maps;
    if(!maps||typeof maps.Map!=='function'||typeof maps.LatLng!=='function'||typeof maps.Polyline!=='function'||typeof maps.Marker!=='function'||typeof maps.Panorama!=='function'||typeof maps.Event?.addListener!=='function'||typeof maps.Event?.removeListener!=='function'||typeof maps.Position?.RIGHT_TOP!=='number'||typeof maps.ZoomControlStyle?.LARGE!=='number'||typeof maps.ZoomControlStyle?.SMALL!=='number'){
      fail(new Error('네이버 지도 SDK를 초기화하지 못했습니다.'));
      return;
    }
    finish({kind:'ready',maps});
  });
  void fetch('/api/map-config',{signal:controller.signal,cache:'no-store'})
    .then(async response=>{
      const data:unknown=await response.json();
      if(!response.ok){
        const detail=configurationError.safeParse(data);
        throw new Error(detail.success?detail.data.error:'네이버 지도 설정을 불러오지 못했습니다.');
      }
      return mapConfigSchema.parse(data);
    })
    .then(({clientId})=>{
      if(settled)return;
      script=document.createElement('script');
      const url=new URL('https://oapi.map.naver.com/openapi/v3/maps.js');
      url.searchParams.set('ncpKeyId',clientId);
      url.searchParams.set('callback',callback);
      url.searchParams.set('submodules','panorama');
      script.src=url.href;
      script.async=true;
      script.onerror=()=>fail(new Error('네이버 지도에 연결하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.'));
      ownedScript=script;
      scriptStarted=true;
      document.head.appendChild(script);
    })
    .catch(error=>fail(error instanceof Error&&error.name!=='ZodError'?error:new Error('네이버 지도 설정을 읽지 못했습니다.')));
  void attempt.catch(()=>{if(pending===attempt)pending=undefined;});
  return attempt;
}
