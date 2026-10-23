import {bearing, meters, type EvidenceSource, type Route, type Sample} from './domain.ts';
import {pointAt, routeImageContext} from './route-context.ts';
import {streetImage, type StreetImage} from './street-imagery.ts';
import type {ServerConfig} from './server-config.ts';

export function adjacentSamples(route:Route, sample:Sample):{id:string;sample:Sample}[] {
    const length=route.coords.slice(1).reduce((total,coord,index)=>total+meters(route.coords[index],coord),0);
    return [0,-12,12].flatMap((offset,index)=>{
        const along=Math.max(0,Math.min(length,sample.along+offset)),coord=pointAt(route.coords,along);
        return coord ? [{id:['center','before','after'][index],sample:{...sample,coord,along,heading:meters(coord,sample.coord)>0.5?bearing(coord,sample.coord):sample.heading}}] : [];
    }).filter((item,index,all)=>all.findIndex(other=>meters(other.sample.coord,item.sample.coord)<0.5)===index);
}
export function evidenceSource(image:StreetImage, target:Sample):EvidenceSource {
    return {...image.source,distance:Math.round(meters(target.coord,image.source.coord))};
}
export function panoramaIdentity(source:Pick<StreetImage['source'],'url'|'coord'|'capturedAt'|'capturedMonth'|'panoId'>):string {
    if(source.panoId)return 'kakao:'+source.panoId;
    const url=new URL(source.url);
    return url.searchParams.get('panoid') ? 'kakao:'+url.searchParams.get('panoid') : url.searchParams.get('pKey') ? 'mapillary:'+url.searchParams.get('pKey') : `${source.coord.join(',')}:${source.capturedMonth??source.capturedAt}`;
}
export async function captureAdjacentViews({route,sample,limit,config,signal,capture=streetImage}:{route:Route;sample:Sample;limit:number;config:ServerConfig;signal:AbortSignal;capture?:typeof streetImage}) {
    const requests=adjacentSamples(route,sample).slice(0,limit);
    const views:{id:string;image:StreetImage}[]=[];
    let next=0,attempts=0;
    const deadline=AbortSignal.any([signal,AbortSignal.timeout(25000)]);
    await Promise.all([0,1].map(async()=>{
        while(next<requests.length&&!deadline.aborted){
            const item=requests[next++]; attempts++;
            try { const image=await capture(item.sample,config,deadline,{target:sample.coord}); if(image)views.push({id:item.id,image}); }
            catch { signal.throwIfAborted(); }
        }
    }));
    signal.throwIfAborted();
    const distinct=views.filter((view,index,all)=>all.findIndex(other=>panoramaIdentity(other.image.source)===panoramaIdentity(view.image.source))===index);
    return {views:distinct,attempts,context:distinct.map(view=>'사진 ID: '+view.id+'\n'+routeImageContext({route,sample,source:view.image.source})).join('\n')};
}
