import {bearing,projectOnRoute,type Coord,type Route,type RouteBarrier} from './domain.ts';
import type {PedestrianGraph} from './osm-graph.ts';

export function graphBarriersForRoute(route:Route,graph:PedestrianGraph):RouteBarrier[]{
 const barriers:RouteBarrier[]=[],seen=new Set<string>();
 for(const edge of graph.edges){
  if(edge.access!=='blocked'&&edge.kind!=='steps')continue;
  const key=`${edge.wayId}:${edge.from}:${edge.to}`;
  if(seen.has(key))continue;seen.add(key);
  const from=graph.nodes[edge.from],to=graph.nodes[edge.to];
  if(!from||!to||edge.length<1)continue;
  const a=projectOnRoute(route.coords,from.coord),b=projectOnRoute(route.coords,to.coord);
  if(!a||!b||a.distance>8||b.distance>8||b.along-a.along<Math.min(6,edge.length*.6))continue;
  const directionError=Math.abs(bearing(a.coord,b.coord)-bearing(from.coord,to.coord))%180;
  if(Math.min(directionError,180-directionError)>25)continue;
  const midpoint:Coord=[(from.coord[0]+to.coord[0])/2,(from.coord[1]+to.coord[1])/2];
  const middle=projectOnRoute(route.coords,midpoint);
  if(!middle||middle.distance>8)continue;
  const anotherPath=graph.edges.some(other=>{
   if(other.access==='blocked'||other.kind==='steps')return false;
   const x=graph.nodes[other.from],y=graph.nodes[other.to];
   if(!x||!y)return false;
   const projection=projectOnRoute([x.coord,y.coord],middle.coord);
   if(!projection||projection.distance>=middle.distance)return false;
   const angle=Math.abs(((bearing(x.coord,y.coord)-bearing(from.coord,to.coord)+540)%360)-180);
   return angle<=25;
  });
  if(anotherPath)continue;
  barriers.push({sampleId:'osm-blocked-'+key,coord:middle.coord,along:middle.along,source:'osm',reason:edge.kind==='steps'?`OpenStreetMap 보행망에 이 통로가 계단으로 표시돼 있습니다. 지도 선형 ${edge.wayId}의 정보이며 영상 판독 결과는 아닙니다.`:`OpenStreetMap 보행망에 이 통로의 보행·휠체어 접근 제한이 표시돼 있습니다. 지도 선형 ${edge.wayId}의 정보이며 영상 판독 결과는 아닙니다.`});
 }
 return barriers;
}
