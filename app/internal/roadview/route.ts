import {z} from 'zod';
import {publicMapConfig} from '@/lib/server-config';
export const dynamic='force-dynamic';
const input=z.object({lng:z.coerce.number().min(124).max(132),lat:z.coerce.number().min(33).max(40),heading:z.coerce.number().min(0).max(360)});
export function GET(request:Request){
    const parsed=input.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if(!parsed.success) return new Response('Invalid capture position',{status:400});
    let javascriptKey:string;
    try { javascriptKey=publicMapConfig().javascriptKey; }
    catch { return new Response('Capture unavailable',{status:503}); }
    const {lng,lat,heading}=parsed.data;
    const html=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>거리영상 렌더러</title><style>html,body,#view{width:100%;height:100%;margin:0;overflow:hidden}#capture-state{display:none}</style></head><body><div id="view"></div><pre id="capture-state">{"status":"loading"}</pre><script>
function state(value){document.getElementById('capture-state').textContent=JSON.stringify(value)}
function init(){try{kakao.maps.load(function(){try{
const position=new kakao.maps.LatLng(${lat},${lng});
const view=new kakao.maps.Roadview(document.getElementById('view'));
const client=new kakao.maps.RoadviewClient();
kakao.maps.event.addListener(view,'init',function(){try{view.setViewpoint({pan:${heading},tilt:-7,zoom:0});const point=view.getPosition();const direction=view.getViewpoint();state({status:'ready',panoId:String(view.getPanoId()),coord:[point.getLng(),point.getLat()],heading:direction.pan})}catch{state({status:'error'})}});
client.getNearestPanoId(position,30,function(id){if(id===null||id===undefined){state({status:'missing'});return}view.setPanoId(id,position)});
}catch{state({status:'error'})}})}catch{state({status:'error'})}}
</script><script src="https://dapi.kakao.com/v2/maps/sdk.js?appkey=${javascriptKey}&amp;autoload=false" onload="init()" onerror="state({status:'error'})"></script></body></html>`;
    return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'strict-origin-when-cross-origin'}});
}
