import {bearing,meters,projectOnRoute,type Coord,type Route,type Sample} from './domain.ts';
import {pointAt} from './route-context.ts';
import type {PedestrianGraph} from './osm-graph.ts';

type Connection=NonNullable<Route['unverifiedConnections']>[number];
export function mappedUnderpassEntry(route:Route,connection:Connection,graph?:PedestrianGraph):Sample|null{
    if(connection.kind!=='underpass'||!graph)return null;
    const hint=projectOnRoute(route.coords,connection.coord);
    if(!hint||hint.distance>20)return null;
    const candidates:Sample[]=[];
    for(const node of Object.values(graph.nodes)){
        if(!node.id.endsWith('@portal')||meters(node.coord,connection.coord)>20)continue;
        const position=projectOnRoute(route.coords,node.coord);
        if(!position||position.distance>8)continue;
        const tunnelWays=new Set(graph.edges.filter(edge=>edge.structure==='tunnel'&&edge.kind!=='shared-road'&&(edge.from===node.id||edge.to===node.id)).map(edge=>edge.wayId));
        if(tunnelWays.size!==1)continue;
        const outgoing=graph.edges.some(edge=>{
            if(edge.from!==node.id||edge.structure!=='tunnel'||edge.kind==='shared-road')return false;
            const next=graph.nodes[edge.to];if(!next)return false;
            const midpoint:Coord=[(node.coord[0]+next.coord[0])/2,(node.coord[1]+next.coord[1])/2];
            const after=projectOnRoute(route.coords,midpoint);
            const angle=Math.abs(((bearing(node.coord,next.coord)-position.heading+540)%360)-180);
            return !!after&&after.distance<=8&&after.along>position.along+1&&angle<=25;
        });
        if(!outgoing)continue;
        const approach=graph.edges.some(edge=>{
            if(edge.to!==node.id||edge.structure==='tunnel'||edge.kind==='shared-road')return false;
            const previous=graph.nodes[edge.from];if(!previous)return false;
            const before=projectOnRoute(route.coords,previous.coord);
            if(!before||before.distance>8||before.along>=position.along-1)return false;
            const angle=Math.abs(((bearing(previous.coord,node.coord)-before.heading+540)%360)-180);
            return angle<=25;
        });
        if(!approach)continue;
        const wayId=[...tunnelWays][0];
        candidates.push({id:'underpass-entry-'+connection.id,coord:node.coord,along:position.along,heading:position.heading,critical:true,target:'underpass-entry',acquisition:{kind:'underpass-entry',connectionId:connection.id,wayId,nodeId:node.id,snapshotAt:graph.snapshotAt}});
    }
    return candidates.length===1?candidates[0]:null;
}
export function underpassApproachSamples(route:Route,sample:Sample,offsets:number[]):{id:string;sample:Sample}[]{
    if(sample.acquisition?.kind!=='underpass-entry')return [];
    const hint=route.unverifiedConnections?.find(connection=>connection.id===sample.acquisition?.connectionId);
    if(!hint)return [];
    const entryAlong=Math.min(sample.along,hint.along);
    return offsets.flatMap((offset,index)=>{
        const along=entryAlong-offset,coord=along>=0?pointAt(route.coords,along):undefined;
        return coord&&meters(coord,sample.coord)<=60?[{id:'approach-'+index,sample:{...sample,coord,along,heading:bearing(coord,sample.coord)}}]:[];
    }).filter((item,index,all)=>all.findIndex(other=>meters(other.sample.coord,item.sample.coord)<.5)===index);
}
export function underpassCameraMatches(route:Route,sample:Sample,camera:Coord):boolean{
    if(sample.acquisition?.kind!=='underpass-entry')return true;
    const hint=route.unverifiedConnections?.find(connection=>connection.id===sample.acquisition?.connectionId);
    const actual=projectOnRoute(route.coords,camera);
    return !!hint&&!!actual&&actual.distance<=20&&actual.along<=Math.min(sample.along,hint.along)-2;
}
