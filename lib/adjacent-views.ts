import {bearing,meters,type EvidenceSource,type Route,type Sample} from './domain.ts';
import {pointAt,routeImageContext} from './route-context.ts';
import {streetImage,ImageryServiceError,type StreetImage} from './street-imagery.ts';
import type {ServerConfig} from './server-config.ts';

export function adjacentSamples(route:Route,sample:Sample):{id:string;sample:Sample}[]{
    const length=route.coords.slice(1).reduce((total,coord,index)=>total+meters(route.coords[index],coord),0);
    return [0,-12,12].flatMap((offset,index)=>{
        const along=Math.max(0,Math.min(length,sample.along+offset)),coord=pointAt(route.coords,along);
        return coord?[{id:['center','before','after'][index],sample:{...sample,coord,along,heading:meters(coord,sample.coord)>0.5?bearing(coord,sample.coord):sample.heading}}]:[];
    }).filter((item,index,all)=>all.findIndex(other=>meters(other.sample.coord,item.sample.coord)<0.5)===index);
}
export function evidenceSource(image:StreetImage,target:Sample):EvidenceSource{return {...image.source,distance:Math.round(meters(target.coord,image.source.coord))};}
export function pointsAwayFromTarget(source:Pick<StreetImage['source'],'coord'|'heading'>,target:Sample):boolean{
    if(meters(source.coord,target.coord)<=2)return false;
    const difference=Math.abs(((source.heading-bearing(source.coord,target.coord)+540)%360)-180);
    return difference>80;
}
type PanoramaSource=Pick<StreetImage['source'],'url'|'coord'|'capturedAt'|'capturedMonth'|'panoId'>;
function providerPanoramaIdentity(source:PanoramaSource):string|undefined{
    const url=new URL(source.url);
    if(source.panoId)return (url.hostname==='www.google.com'?'google:':'kakao:')+source.panoId;
    if(url.hostname==='kartaview.org'&&/^\/details\/\d+\/\d+\/?$/.test(url.pathname))return 'kartaview:'+url.pathname;
    const kakao=url.searchParams.get('panoid'),mapillary=url.searchParams.get('pKey');
    return kakao?'kakao:'+kakao:mapillary?'mapillary:'+mapillary:undefined;
}
export function panoramaIdentity(source:PanoramaSource):string{
    return providerPanoramaIdentity(source)??`${new URL(source.url).hostname}:${source.coord.join(',')}:${source.capturedMonth??source.capturedAt}`;
}
export function hasIndependentPanorama(a:PanoramaSource,b:PanoramaSource):boolean{
    const first=providerPanoramaIdentity(a),second=providerPanoramaIdentity(b);
    return first!==undefined&&second!==undefined&&first!==second&&meters(a.coord,b.coord)>=1;
}
export function viewIdentity(source:StreetImage['source']):string{return `${panoramaIdentity(source)}:${Math.round(source.heading)}:${source.tilt??7}:${source.zoom??0}`;}
export async function captureAdjacentViews({route,sample,limit,config,signal,reason='occlusion',initialSource,capture=streetImage,onView}:{route:Route;sample:Sample;limit:number;config:ServerConfig;signal:AbortSignal;reason?:'framing'|'occlusion'|'corridor-uncertain';initialSource?:EvidenceSource;capture?:typeof streetImage;onView?:(view:{id:string;image:StreetImage})=>Promise<void>}){
    const targetHeading=initialSource&&meters(initialSource.coord,sample.coord)>0.5?bearing(initialSource.coord,sample.coord):initialSource?.heading??sample.heading;
    const opposed=Math.abs(((sample.heading-targetHeading+540)%360)-180)>100;
    const framingSample=initialSource?{...sample,coord:initialSource.coord}:sample;
    const positions=reason==='framing'?(opposed?[{id:'look-forward',sample:{...framingSample,heading:sample.heading}},{id:'look-left',sample:{...framingSample,heading:(targetHeading+300)%360}},{id:'look-down',sample:{...framingSample,heading:targetHeading}}]:[-60,60,0].map((offset,index)=>({id:['look-left','look-right','look-down'][index],sample:{...framingSample,heading:(targetHeading+offset+360)%360}}))):adjacentSamples(route,sample);
    const requests=positions.slice(0,Math.min(3,limit));
    const views:{id:string;image:StreetImage}[]=[];
    let next=0,attempts=0;
    let outage:ImageryServiceError|undefined;
    let persistenceFailure:{error:unknown}|undefined;
    const persistenceController=new AbortController();
    const deadline=AbortSignal.any([signal,persistenceController.signal,AbortSignal.timeout(110000)]);
    await Promise.all([0,1].map(async()=>{
        while(next<requests.length&&!deadline.aborted){
            const item=requests[next++];attempts++;
            try {
                const options=reason==='framing'?{tilt:25,zoom:item.id==='look-down'?1:0}:{target:sample.coord,tilt:15,zoom:0};
                const image=await capture(item.sample,config,deadline,options);
                if(image){
                    try{await onView?.({id:item.id,image});}catch(error){persistenceFailure??={error};persistenceController.abort();return;}
                    views.push({id:item.id,image});
                }
            } catch(error){signal.throwIfAborted();if(persistenceController.signal.aborted)return;if(error instanceof ImageryServiceError)outage=error;}
        }
    }));
    signal.throwIfAborted();
    if(persistenceFailure)throw persistenceFailure.error;
    if(!views.length&&deadline.aborted)throw new ImageryServiceError(503);
    if(!views.length&&outage)throw outage;
    const distinct=views.filter((view,index,all)=>all.findIndex(other=>viewIdentity(other.image.source)===viewIdentity(view.image.source))===index);
    return {views:distinct,attempts,context:distinct.map(view=>'사진 ID: '+view.id+'\n'+routeImageContext({route,sample,source:view.image.source})).join('\n')};
}
