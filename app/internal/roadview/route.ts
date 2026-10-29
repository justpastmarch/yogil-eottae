import {z} from 'zod';
import {publicMapConfig} from '@/lib/server-config';

export const dynamic='force-dynamic';
const coordinate=z.tuple([z.number().min(-180).max(180),z.number().min(-90).max(90)]);
const input=z.object({
    lng:z.coerce.number().min(124).max(132),lat:z.coerce.number().min(33).max(40),
    heading:z.coerce.number().min(0).lt(360),tilt:z.coerce.number().min(-45).max(45).default(7),
    zoom:z.coerce.number().int().min(0).max(2).default(0),
    maxDistance:z.coerce.number().pipe(z.union([z.literal(20),z.literal(60)])).default(20),
    target:z.string().transform((value,ctx)=>{
        try {return coordinate.parse(JSON.parse(value));}
        catch {ctx.addIssue({code:'custom',message:'Invalid target'});return z.NEVER;}
    }).optional(),
}).strict().refine(value=>!value.target||distance([value.lng,value.lat],value.target)<=60,{message:'Target too distant'});

function distance(a:readonly number[],b:readonly number[]) {
    const r=Math.PI/180,p=(b[1]-a[1])*r,l=(b[0]-a[0])*r;
    const v=Math.sin(p/2)**2+Math.cos(a[1]*r)*Math.cos(b[1]*r)*Math.sin(l/2)**2;
    return 6371000*2*Math.atan2(Math.sqrt(v),Math.sqrt(Math.max(0,1-v)));
}

export function GET(request:Request){
    const parsed=input.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if(!parsed.success)return new Response('Invalid capture position',{status:400});
    let clientId:string;
    try {clientId=publicMapConfig().clientId;}
    catch {return new Response('Capture unavailable',{status:503});}
    // Only a public SDK identifier and validated camera controls enter this script.
    const config=JSON.stringify({...parsed.data,clientId}).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
    const html=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>거리영상 렌더러</title><style>html,body{width:100%;height:100%;margin:0;overflow:hidden}#view{position:absolute!important;inset:0;width:100vw!important;height:100vh!important}#capture-state{display:none}</style></head><body><div id="view"></div><pre id="capture-state">{"status":"loading"}</pre><script>
const config=${config};
let panorama,terminal=false,aimed=false;
function state(value){document.getElementById('capture-state').textContent=JSON.stringify(value);return value}
function fail(code){terminal=true;return state({status:'error',code})}
function distance(a,b){const r=Math.PI/180,p=(b[1]-a[1])*r,l=(b[0]-a[0])*r,v=Math.sin(p/2)**2+Math.cos(a[1]*r)*Math.cos(b[1]*r)*Math.sin(l/2)**2;return 6371000*2*Math.atan2(Math.sqrt(v),Math.sqrt(Math.max(0,1-v)))}
function bearing(a,b,fallback){if(distance(a,b)<0.5)return fallback;const r=Math.PI/180;return (Math.atan2(Math.sin((b[0]-a[0])*r)*Math.cos(b[1]*r),Math.cos(a[1]*r)*Math.sin(b[1]*r)-Math.sin(a[1]*r)*Math.cos(b[1]*r)*Math.cos((b[0]-a[0])*r))*180/Math.PI+360)%360}
function month(value){if(typeof value!=='string')return null;const m=value.match(/^(20[0-9]{2})-(0[1-9]|1[0-2])(?:-(0[1-9]|[12][0-9]|3[01]) ([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9]))?$/);if(!m)return null;const now=new Date().toISOString();if(m[3]){const day=m[1]+'-'+m[2]+'-'+m[3];if(new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day||day>now.slice(0,10))return null;}return value.slice(0,7)<=now.slice(0,7)?value.slice(0,7):null}
function read(){
 if(terminal)return JSON.parse(document.getElementById('capture-state').textContent);
 if(!panorama||!aimed)return {status:'loading'};
 try{
  const location=panorama.getLocation(),pov=panorama.getPov(),panoId=panorama.getPanoId();
  const coord=[location.coord.lng(),location.coord.lat()];
  if(typeof panoId!=='string'||!panoId||location.panoId!==panoId||!coord.every(Number.isFinite)||!Number.isFinite(pov.pan)||!Number.isFinite(pov.tilt)||!Number.isFinite(pov.fov))return fail('metadata');
  if(distance([config.lng,config.lat],coord)>config.maxDistance){terminal=true;return state({status:'missing',reason:'distance'})}
  const heading=(pov.pan%360+360)%360,wanted=config.target?bearing(coord,config.target,config.heading):config.heading;
  if(Math.abs(((heading-wanted+540)%360)-180)>0.1||Math.abs(pov.tilt+config.tilt)>0.1||Math.abs(pov.fov-[90,60,40][config.zoom])>0.1)return state({status:'loading'});
  const capturedMonth=month(location.photodate);
  return state({status:'ready',panoId,coord,heading,tilt:-pov.tilt,fov:pov.fov,...(capturedMonth?{capturedMonth}:{})});
 }catch{return fail('metadata')}
}
window.__readCaptureState=read;
window.navermap_authFailure=()=>fail('auth');
window.__captureNaverReady=()=>queueMicrotask(()=>{
 if(terminal)return;
 try{
  const maps=window.naver&&window.naver.maps;if(!maps||!maps.Panorama)return fail('sdk');
  const view=document.getElementById('view');
  view.style.width=window.innerWidth+'px';view.style.height=window.innerHeight+'px';
  panorama=new maps.Panorama(view,{position:new maps.LatLng(config.lat,config.lng),pov:{pan:config.heading>180?config.heading-360:config.heading,tilt:-config.tilt,fov:[90,60,40][config.zoom]}});
  panorama.setSize({width:window.innerWidth,height:window.innerHeight});
  const frame=()=>{if(terminal)return;try{const location=panorama.getLocation();if(!location||!location.coord)return;const coord=[location.coord.lng(),location.coord.lat()];if(distance([config.lng,config.lat],coord)>config.maxDistance){terminal=true;state({status:'missing',reason:'distance'});return}const heading=config.target?bearing(coord,config.target,config.heading):config.heading;aimed=true;panorama.setPov({pan:heading>180?heading-360:heading,tilt:-config.tilt,fov:[90,60,40][config.zoom]});read()}catch{fail('lookup')}};
  maps.Event.addListener(panorama,'init',frame);
  maps.Event.addListener(panorama,'pano_changed',frame);
  maps.Event.addListener(panorama,'pov_changed',()=>{read()});
  maps.Event.addListener(panorama,'pano_status',status=>{if(status==='ERROR')fail('lookup')});
 }catch{fail('sdk')}
});
const sdk=document.createElement('script'),url=new URL('https://oapi.map.naver.com/openapi/v3/maps.js');url.searchParams.set('ncpKeyId',config.clientId);url.searchParams.set('submodules','panorama');url.searchParams.set('callback','__captureNaverReady');sdk.src=url.href;sdk.onerror=()=>fail('sdk');document.head.appendChild(sdk);
</script></body></html>`;
    return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'strict-origin-when-cross-origin'}});
}
