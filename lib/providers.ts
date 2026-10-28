import { z } from 'zod';
import { meters, samplesFor, placeSchema, type Coord, type Place, type Route } from './domain.ts';
import { routeIsDistinct } from './detours.ts';
import type { RoutingConfig } from './server-config.ts';
import * as tmap from './tmap-providers.ts';
export { ServiceError } from './tmap-providers.ts';
import { ServiceError } from './tmap-providers.ts';
const coordinate = z.tuple([z.coerce.number().min(124).max(132), z.coerce.number().min(33).max(40)]);
const location = z.object({ x:z.coerce.number().min(124).max(132), y:z.coerce.number().min(33).max(40) });
const places = z.object({documents:z.array(location.extend({id:z.string(),place_name:z.string(),address_name:z.string(),road_address_name:z.string().optional(),phone:z.unknown().optional(),place_url:z.unknown().optional()}))});
const addresses = z.object({documents:z.array(location.extend({address_name:z.string(),road_address:z.object({address_name:z.string()}).nullable().optional()}))});
const step = z.object({properties:location.extend({guidance:z.string(),distance:z.number().nonnegative(),time:z.number().nonnegative()}),path:z.object({points:z.array(coordinate).min(1)})});
const walking = z.discriminatedUnion('status',[
    z.object({status:z.literal('OK'),route:z.object({properties:z.object({totalDistance:z.number().positive(),totalTime:z.number().positive()}),legs:z.array(z.object({steps:z.array(step).min(1)})).min(1)})}),
    z.object({status:z.enum(['SAME_POINT','START_LINK_NOT_FOUND','END_LINK_NOT_FOUND','TOO_MANY_SEARCH_LINK','TOO_FAR_AWAY','ROUTE_RESULT_NOT_FOUND'])}),
]);
async function kakao(path:string, params:URLSearchParams, restKey:string, signal?:AbortSignal):Promise<unknown> {
    const response=await fetch('https://dapi.kakao.com/v2/'+path+'?'+params,{headers:{Authorization:'KakaoAK '+restKey},cache:'no-store',redirect:'manual',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
    if(!response.ok) throw new ServiceError('지도 서비스를 잠시 이용할 수 없습니다.',503);
    return response.json();
}
export async function search(query:string, config:RoutingConfig, signal?:AbortSignal):Promise<Place[]> {
    if(config.kind==='tmap') return tmap.search(query,{tmap:config.apiKey},signal);
    const result=places.parse(await kakao('local/search/keyword.json',new URLSearchParams({query,size:'8'}),config.restKey,signal));
    return result.documents.map(p=>{
        const phone=placeSchema.shape.phone.safeParse(typeof p.phone==='string'?p.phone.trim()||undefined:undefined);
        const placeUrl=typeof p.place_url==='string'?p.place_url.replace(/^http:\/\//,'https://'):undefined;
        const validUrl=placeSchema.shape.placeUrl.safeParse(placeUrl);
        return {id:p.id,name:p.place_name,address:p.road_address_name||p.address_name,coord:[p.x,p.y],...(phone.success&&phone.data?{phone:phone.data}:{}),...(validUrl.success&&validUrl.data?.endsWith('/'+p.id)?{placeUrl:validUrl.data}:{})};
    });
}
export async function geocode(query:string, config:RoutingConfig, signal?:AbortSignal):Promise<Place[]> {
    if(config.kind==='tmap') return tmap.geocode(query,{tmap:config.apiKey},signal);
    const result=addresses.parse(await kakao('local/search/address.json',new URLSearchParams({query,size:'8'}),config.restKey,signal));
    return result.documents.map((p,i)=>({id:'address-'+i,name:p.address_name,address:p.road_address?.address_name||p.address_name,coord:[p.x,p.y]}));
}
const modeLabels = { BROAD_FIRST: '넓은 길', SHORTEST: '최단 경로', ACCESSIBLE: '편안한 길' };
type KakaoMode = keyof typeof modeLabels;
async function walkRoute(start:Place,end:Place,restKey:string,mode:KakaoMode,via:Coord[],signal?:AbortSignal):Promise<Route> {
    signal?.throwIfAborted();
    if(meters(start.coord,end.coord)>15000) throw new ServiceError('직선거리 15km 이내에서 이용해 주세요.');
    const params=new URLSearchParams({start_x:String(start.coord[0]),start_y:String(start.coord[1]),end_x:String(end.coord[0]),end_y:String(end.coord[1]),input_coord:'WGS84',output_coord:'WGS84',s_name:start.name,e_name:end.name,route_mode:mode});
    if(via.length) {
        params.set('via_x',via.map(coord=>coord[0]).join(','));
        params.set('via_y',via.map(coord=>coord[1]).join(','));
    }
    const result=walking.parse(await kakao('routing/walk',params,restKey,signal));
    if(result.status!=='OK') throw new ServiceError('이 위치를 연결하는 도보 경로를 찾지 못했습니다. 출발지와 도착지를 조정해 주세요.');
    const rawSteps=result.route.legs.flatMap(leg=>leg.steps);
    const coords=rawSteps.flatMap(s=>s.path.points).filter((c,i,a)=>i===0||meters(a[i-1],c)>.1);
    if(coords.length<2||result.route.properties.totalDistance>20000) throw new ServiceError('분석할 수 있는 도보 경로 범위를 벗어났습니다.');
    const steps=rawSteps.map(s=>({text:s.properties.guidance,coord:coordinate.parse([s.properties.x,s.properties.y])}));
    const id='kakao-'+mode.toLowerCase()+(via.length?'-via-'+via.map(coord=>coord.join(',')).join(';'):'');
    return {id,name:via.length?'우회 경로':modeLabels[mode],options:[modeLabels[mode]],coords,distance:result.route.properties.totalDistance,seconds:result.route.properties.totalTime,steps,samples:samplesFor(coords,steps.filter(s=>/횡단|계단|육교|지하|진입/.test(s.text)).map(s=>s.coord)),fetchedAt:new Date().toISOString()};
}
export async function routes(start:Place,end:Place,config:RoutingConfig,signal?:AbortSignal):Promise<{routes:Route[];warnings:string[]}> {
    if(config.kind==='tmap') return tmap.routes(start,end,{tmap:config.apiKey},signal);
    const modes:KakaoMode[]=['BROAD_FIRST','SHORTEST','ACCESSIBLE'];
    const outcomes=await Promise.allSettled(modes.map(mode=>walkRoute(start,end,config.restKey,mode,[],signal)));
    signal?.throwIfAborted();
    const accepted:Route[]=[], warnings:string[]=[];
    for(const outcome of outcomes) {
        if(outcome.status==='rejected') {
            warnings.push(outcome.reason instanceof Error?outcome.reason.message:'경로 조회 실패');
            continue;
        }
        const route=outcome.value;
        const same=accepted.find(existing=>!routeIsDistinct(route,[existing]));
        if(same) same.options.push(...route.options);
        else accepted.push(route);
    }
    if(!accepted.length) throw new ServiceError('길찾기 서비스를 잠시 이용할 수 없습니다.',503);
    return {routes:accepted,warnings};
}
export async function reroute(start:Place,end:Place,config:RoutingConfig,via:Coord[],signal?:AbortSignal):Promise<Route> {
    if(config.kind==='tmap') throw new ServiceError('이 지도 서비스는 경유지 우회 경로를 지원하지 않습니다.',503);
    const parsed=z.array(coordinate).min(1).max(5).safeParse(via);
    if(!parsed.success) throw new ServiceError('우회 경유지는 1개 이상 5개 이하로 지정해 주세요.');
    return walkRoute(start,end,config.restKey,'ACCESSIBLE',parsed.data,signal);
}
