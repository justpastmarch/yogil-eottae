import {bearing,meters,projectOnRoute,type Coord,type Route} from './domain.ts';
import type {GraphEdge,PedestrianGraph} from './osm-graph.ts';
import {findPedestrianPath} from './pedestrian-routing.ts';

export type CrossingTarget={nodeId:string;coord:Coord;along:number;heading:number;target:'crossing-entry'|'crossing-exit'};
export type CrossingMatch={targets:CrossingTarget[];wayIds:number[];snapshotAt:string};

const GROUND='@[0,0,"",""]';
const MAX_OFFSET=6;

function projectUnique(coords:Coord[],point:Coord,minimum:number,maximum:number){
 let total=0;
 const matches:{along:number;distance:number}[]=[];
 for(let i=1;i<coords.length;i++){
  const length=meters(coords[i-1],coords[i]);
  const match=projectOnRoute([coords[i-1],coords[i]],point);
  if(match){const along=total+match.along;if(along>=minimum&&along<=maximum&&match.distance<=MAX_OFFSET)matches.push({along,distance:match.distance});}
  total+=length;
 }
 matches.sort((a,b)=>a.distance-b.distance||a.along-b.along);
 const best=matches[0];
 if(!best||matches.some(match=>match.distance<=best.distance+1.5&&Math.abs(match.along-best.along)>8))return null;
 return best;
}

export function matchGroupedCrossings(route:Route,startAlong:number,endAlong:number,count:number,network:PedestrianGraph):CrossingMatch|null{
 if(count<1||count>5||endAlong<=startAlong||endAlong-startAlong>150)return null;
 const grouped=new Map<number,GraphEdge[]>();
 for(const edge of network.edges){
  if(edge.kind!=='crossing')continue;
  const group=grouped.get(edge.wayId)??[];group.push(edge);grouped.set(edge.wayId,group);
 }
 const ways:{id:number;entry:string;exit:string;start:number;end:number}[]=[];
 for(const [id,edges] of grouped){
  if(edges.some(edge=>!edge.from.endsWith(GROUND)||!edge.to.endsWith(GROUND)))continue;
  const neighbors=new Map<string,Set<string>>();
  for(const edge of edges){
   const from=neighbors.get(edge.from)??new Set<string>();from.add(edge.to);neighbors.set(edge.from,from);
   const to=neighbors.get(edge.to)??new Set<string>();to.add(edge.from);neighbors.set(edge.to,to);
  }
  const ends=[...neighbors].filter(([,n])=>n.size===1).map(([node])=>node);
  if(ends.length!==2||[...neighbors.values()].some(n=>n.size>2))continue;
  const first=network.nodes[ends[0]],last=network.nodes[ends[1]];
  if(!first||!last)continue;
  const a=projectUnique(route.coords,first.coord,startAlong-10,endAlong+10),b=projectUnique(route.coords,last.coord,startAlong-10,endAlong+10);
  if(!a||!b||Math.abs(a.along-b.along)<6)continue;
  ways.push(a.along<b.along?{id,entry:first.id,exit:last.id,start:a.along,end:b.along}:{id,entry:last.id,exit:first.id,start:b.along,end:a.along});
 }
 ways.sort((a,b)=>a.start-b.start||a.id-b.id);
 const firstWay=ways[0],lastWay=ways.at(-1);
 if(ways.length!==count||!firstWay||!lastWay||Math.abs(firstWay.start-startAlong)>8||Math.abs(lastWay.end-endAlong)>8)return null;
 if(ways.some((way,index)=>index>0&&way.start<ways[index-1].end-3))return null;
 const followsRoute=(edge:GraphEdge)=>{
  if(edge.kind==='shared-road')return false;
  const from=network.nodes[edge.from],to=network.nodes[edge.to];
  if(!from||!to)return false;
  let furthest=startAlong-10;
  const segments=Math.max(1,Math.ceil(edge.length/3));
  for(let index=0;index<=segments;index++){
   const fraction=index/segments;
   const coord:Coord=[from.coord[0]+(to.coord[0]-from.coord[0])*fraction,from.coord[1]+(to.coord[1]-from.coord[1])*fraction];
   const point=projectUnique(route.coords,coord,startAlong-10,endAlong+10);
   if(!point||point.along<furthest-3)return false;
   furthest=Math.max(furthest,point.along);
  }
  return true;
 };
 const path=findPedestrianPath({...network,edges:network.edges.filter(followsRoute)},firstWay.entry,lastWay.exit,new Set());
 if(!path||path.distance>(endAlong-startAlong)*1.5||path.distance<endAlong-startAlong-2*MAX_OFFSET)return null;
 const pathWays=path.edges.filter(edge=>edge.kind==='crossing').map(edge=>edge.wayId).filter((id,index,array)=>index===0||id!==array[index-1]);
 if(pathWays.length!==count||pathWays.some((id,index)=>id!==ways[index].id))return null;
 for(const way of ways){
  const first=path.edges.findIndex(edge=>edge.wayId===way.id),last=path.edges.findLastIndex(edge=>edge.wayId===way.id);
  if(first<0||path.edges[first].from!==way.entry||path.edges[last].to!==way.exit||path.edges.slice(first,last+1).some(edge=>edge.wayId!==way.id))return null;
 }
 let previous=startAlong-10;
 for(const edge of path.edges){
  const from=network.nodes[edge.from],to=network.nodes[edge.to];
  if(!from||!to)return null;
  const segments=Math.max(1,Math.ceil(edge.length/3));
  for(let index=0;index<=segments;index++){
   const fraction=index/segments;
   const coord:Coord=[from.coord[0]+(to.coord[0]-from.coord[0])*fraction,from.coord[1]+(to.coord[1]-from.coord[1])*fraction];
   const point=projectUnique(route.coords,coord,startAlong-10,endAlong+10);
   if(!point||point.along<previous-3)return null;
   previous=Math.max(previous,point.along);
  }
 }
 const targets:CrossingTarget[]=[];
 for(const way of ways){
  const entry=network.nodes[way.entry],exit=network.nodes[way.exit];
  if(!entry||!exit)return null;
  const heading=bearing(entry.coord,exit.coord);
  targets.push({nodeId:entry.id,coord:entry.coord,along:way.start,heading,target:'crossing-entry'},{nodeId:exit.id,coord:exit.coord,along:way.end,heading,target:'crossing-exit'});
 }
 return {targets,wayIds:ways.map(way=>way.id),snapshotAt:network.snapshotAt};
}

// A perpendicular crossing touching the route at one point is not a traversal.
// Nearby aligned crossings remain unresolved unless their full geometry matches.
function intersection(a:Coord,b:Coord,c:Coord,d:Coord):Coord|null{
 const cross=(x:number,y:number,u:number,v:number)=>x*v-y*u;
 const rx=b[0]-a[0],ry=b[1]-a[1],sx=d[0]-c[0],sy=d[1]-c[1];
 const denominator=cross(rx,ry,sx,sy),qx=c[0]-a[0],qy=c[1]-a[1];
 if(Math.abs(denominator)<1e-16){
  if(Math.abs(cross(qx,qy,rx,ry))>1e-16)return null;
  const length=rx*rx+ry*ry;
  if(!length)return null;
  const t0=(qx*rx+qy*ry)/length,t1=((d[0]-a[0])*rx+(d[1]-a[1])*ry)/length;
  const lo=Math.max(0,Math.min(t0,t1)),hi=Math.min(1,Math.max(t0,t1));
  if(lo>hi)return null;
  const t=(lo+hi)/2;
  return [a[0]+t*rx,a[1]+t*ry];
 }
 const t=cross(qx,qy,sx,sy)/denominator,u=cross(qx,qy,rx,ry)/denominator;
 return t>=0&&t<=1&&u>=0&&u<=1?[a[0]+t*rx,a[1]+t*ry]:null;
}

export function discoverRouteCrossings(route:Route,network:PedestrianGraph):{matches:CrossingMatch[];unresolved:{wayId:number;coord:Coord;along:number}[]}{
 const grouped=new Map<number,GraphEdge[]>();
 for(const edge of network.edges){
  if(edge.kind!=='crossing'||!edge.from.endsWith(GROUND)||!edge.to.endsWith(GROUND))continue;
  const edges=grouped.get(edge.wayId)??[];edges.push(edge);grouped.set(edge.wayId,edges);
 }
 const matches:CrossingMatch[]=[],unresolved:{wayId:number;coord:Coord;along:number}[]=[];
 const total=route.coords.slice(1).reduce((sum,coord,index)=>sum+meters(route.coords[index],coord),0);
 for(const [wayId,edges] of grouped){
  const neighbors=new Map<string,Set<string>>();
  let touch:Coord|null=null;
  const aligned:{coord:Coord;along:number}[]=[];
  for(const edge of edges){
   const from=network.nodes[edge.from],to=network.nodes[edge.to];
   if(!from||!to)continue;
   const a=neighbors.get(edge.from)??new Set<string>();a.add(edge.to);neighbors.set(edge.from,a);
   const b=neighbors.get(edge.to)??new Set<string>();b.add(edge.from);neighbors.set(edge.to,b);
   for(let i=1;i<route.coords.length&&!touch;i++)touch=intersection(route.coords[i-1],route.coords[i],from.coord,to.coord);
   const segments=Math.max(1,Math.ceil(edge.length/2));
   const edgeHeading=bearing(from.coord,to.coord);
   for(let index=0;index<=segments;index++){
    const t=index/segments,point:Coord=[from.coord[0]+(to.coord[0]-from.coord[0])*t,from.coord[1]+(to.coord[1]-from.coord[1])*t];
    const projection=projectOnRoute(route.coords,point);
    if(!projection||projection.distance>MAX_OFFSET)continue;
    const difference=Math.abs(((edgeHeading-projection.heading+540)%360)-180);
    if(Math.min(difference,180-difference)<=25)aligned.push({coord:projection.coord,along:projection.along});
   }
  }
  const ends=[...neighbors].filter(([,adjacent])=>adjacent.size===1).map(([id])=>network.nodes[id]);
  if(touch&&ends.length===2&&ends[0]&&ends[1]&&![...neighbors.values()].some(adjacent=>adjacent.size>2)){
   const a=projectUnique(route.coords,ends[0].coord,0,total),b=projectUnique(route.coords,ends[1].coord,0,total);
   if(a&&b&&a.distance<=1&&b.distance<=1&&Math.abs(a.along-b.along)>=6){
    const start=Math.min(a.along,b.along),end=Math.max(a.along,b.along);
    const matched=matchGroupedCrossings(route,start,end,1,network);
    if(matched&&matched.wayIds[0]===wayId){
     // Every part of the mapped way must follow the same traversal, not just
     // its endpoints. Tight tolerance avoids attaching adjacent parallel ways.
     const follows=edges.every(edge=>{
      const from=network.nodes[edge.from],to=network.nodes[edge.to];
      if(!from||!to)return false;
      const steps=Math.max(1,Math.ceil(edge.length/3));
      return Array.from({length:steps+1},(_,index)=>{
       const t=index/steps,point:Coord=[from.coord[0]+(to.coord[0]-from.coord[0])*t,from.coord[1]+(to.coord[1]-from.coord[1])*t];
       const projection=projectUnique(route.coords,point,start-1,end+1);
       return !!projection&&projection.distance<=1;
      }).every(Boolean);
     });
     if(follows){matches.push(matched);continue;}
    }
   }
  }
  if(aligned.length>1){
   aligned.sort((a,b)=>a.along-b.along);
   if(aligned[aligned.length-1].along-aligned[0].along>=2)unresolved.push({wayId,coord:aligned[0].coord,along:aligned[0].along});
  }
 }
 return {matches,unresolved};
}
