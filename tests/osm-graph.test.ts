import {test} from 'node:test';
import assert from 'node:assert/strict';
import snapshot from '../data/yeongtong-campus.osm.json' with {type:'json'};
import {buildPedestrianGraph} from '../lib/osm-graph.ts';
import {findPedestrianPath} from '../lib/pedestrian-routing.ts';
import {discoverRouteCrossings,matchGroupedCrossings} from '../lib/osm-crossings.ts';
import {projectOnRoute,type Coord,type Route} from '../lib/domain.ts';

const coords:Coord[]=[[127.07562034,37.24787123],[127.07560235,37.24781289],[127.07586059,37.24782826],[127.07587785,37.24780426],[127.07592363,37.24778565],[127.07597188,37.24741675]];
const route:Route={id:'intersection',name:'intersection',options:[],coords,distance:80,seconds:0,steps:[],samples:[],fetchedAt:''};
const start=projectOnRoute(coords,coords[1])!.along,end=projectOnRoute(coords,coords[5])!.along;
const graph=buildPedestrianGraph(snapshot);

test('a mapped grouped crossing is split into distinct observation targets, not a verdict',()=>{
 const match=matchGroupedCrossings(route,start,end,2,graph);
 assert.ok(match);
 assert.deepEqual(match.wayIds,[1235791981,1235791985]);
 assert.deepEqual(match.targets.map(target=>target.target),['crossing-entry','crossing-exit','crossing-entry','crossing-exit']);
 assert.equal(new Set(match.targets.map(target=>target.nodeId)).size,4);
 assert.equal(match.snapshotAt,snapshot.osm3s.timestamp_osm_base);
});
test('a single crossing requires mapped endpoints rather than the next maneuver',()=>{
 const grouped=matchGroupedCrossings(route,start,end,2,graph);
 assert.ok(grouped);
 const [entry,exit]=grouped.targets;
 const single=matchGroupedCrossings(route,entry.along,exit.along,1,graph);
 assert.ok(single);
 assert.deepEqual(single.wayIds,[1235791981]);
 assert.deepEqual(single.targets.map(target=>target.target),['crossing-entry','crossing-exit']);
 assert.equal(matchGroupedCrossings(route,entry.along,end,1,graph),null);
});
test('ambiguous or disconnected crossing topology stays unresolved',()=>{
 const first=graph.edges.filter(edge=>edge.wayId===1235791981);
 const ambiguous={...graph,edges:[...graph.edges,...first.map(edge=>({...edge,id:'duplicate:'+edge.id,wayId:999999999}))]};
 assert.equal(matchGroupedCrossings(route,start,end,2,ambiguous),null);
 const disconnected={...graph,edges:graph.edges.filter(edge=>edge.wayId!==1225577602)};
 assert.equal(matchGroupedCrossings(route,start,end,2,disconnected),null);
});
test('discovery ignores perpendicular branches but keeps nearby parallel crossings unresolved',()=>{
 const data={osm3s:{timestamp_osm_base:'2026-01-01T00:00:00Z'},elements:[
  {type:'node',id:1,lon:127.0002,lat:37},{type:'node',id:2,lon:127.0004,lat:37},
  {type:'node',id:3,lon:127.0006,lat:36.9999},{type:'node',id:4,lon:127.0006,lat:37.0001},
  {type:'node',id:5,lon:127.0007,lat:37.00002},{type:'node',id:6,lon:127.0009,lat:37.00002},
  {type:'node',id:7,lon:127.0008,lat:36.9999},{type:'node',id:8,lon:127.0008,lat:37.0001},
  {type:'way',id:10,nodes:[1,2],tags:{highway:'footway',footway:'crossing'}},
  {type:'way',id:11,nodes:[3,4],tags:{highway:'footway',footway:'crossing'}},
  {type:'way',id:12,nodes:[5,6],tags:{highway:'footway',footway:'crossing'}},
  {type:'way',id:13,nodes:[7,8],tags:{highway:'footway',footway:'crossing',layer:'1',bridge:'yes'}},
 ]};
 const straight:Route={...route,coords:[[127,37],[127.001,37]]};
 const found=discoverRouteCrossings(straight,buildPedestrianGraph(data));
 assert.deepEqual(found.matches.map(match=>match.wayIds),[[10]]);
 assert.deepEqual(found.unresolved.map(item=>item.wayId),[12]);
});
test('overlapping mapped crossings are ambiguous and cannot become observed targets',()=>{
 const data={osm3s:{timestamp_osm_base:'2026-01-01T00:00:00Z'},elements:[
  {type:'node',id:1,lon:127.0002,lat:37},{type:'node',id:2,lon:127.0004,lat:37},
  {type:'way',id:10,nodes:[1,2],tags:{highway:'footway',footway:'crossing'}},
  {type:'way',id:11,nodes:[1,2],tags:{highway:'footway',footway:'crossing'}},
 ]};
 const found=discoverRouteCrossings({...route,coords:[[127,37],[127.001,37]]},buildPedestrianGraph(data));
 assert.deepEqual(found.matches,[]);
 assert.deepEqual(found.unresolved.map(item=>item.wayId),[10,11]);
});
test('an excluded real graph edge requires a topologically connected alternative',()=>{
 const entry=Object.keys(graph.nodes).find(id=>id.startsWith('11472650579@'))!;
 const exit=Object.keys(graph.nodes).find(id=>id.startsWith('11472650627@'))!;
 const original=findPedestrianPath(graph,entry,exit,new Set());
 const excluded=new Set(graph.edges.filter(edge=>edge.wayId===1235791981).map(edge=>edge.id));
 const alternative=findPedestrianPath(graph,entry,exit,excluded);
 assert.ok(original&&alternative);
 assert.ok(alternative.distance>original.distance);
 assert.ok(alternative.edges.every(edge=>!excluded.has(edge.id)));
});
test('coincident but unconnected ways are never joined and explicit tunnel portals connect',()=>{
 const node=(id:number,lon:number)=>({type:'node',id,lat:37,lon});
 const data={osm3s:{timestamp_osm_base:'2026-01-01T00:00:00Z'},elements:[node(1,127),node(2,127.0001),node(3,127.0001),node(4,127.0002),node(5,127.0003),
  {type:'way',id:1,nodes:[1,2],tags:{highway:'footway'}},
  {type:'way',id:2,nodes:[3,4],tags:{highway:'footway'}},
  {type:'way',id:3,nodes:[2,5],tags:{highway:'footway',tunnel:'yes',layer:'-1'}}]};
 const g=buildPedestrianGraph(data),key=(id:number)=>Object.keys(g.nodes).find(value=>value.startsWith(id+'@'))!;
 assert.equal(findPedestrianPath(g,key(1),key(4),new Set()),null);
 assert.ok(findPedestrianPath(g,key(1),key(5),new Set()));
});
test('directional restrictions and steps are not traversed',()=>{
 const node=(id:number,lon:number)=>({type:'node',id,lat:37,lon});
 const data={osm3s:{timestamp_osm_base:'2026-01-01T00:00:00Z'},elements:[node(1,127),node(2,127.0001),node(3,127.0002),
  {type:'way',id:1,nodes:[1,2],tags:{highway:'footway',access:'private',foot:'yes','wheelchair:forward':'no'}},
  {type:'way',id:2,nodes:[2,3],tags:{highway:'steps'}}]};
 const g=buildPedestrianGraph(data),key=(id:number)=>Object.keys(g.nodes).find(value=>value.startsWith(id+'@'))!;
 assert.equal(findPedestrianPath(g,key(1),key(2),new Set()),null);
 assert.ok(findPedestrianPath(g,key(2),key(1),new Set()));
 assert.equal(findPedestrianPath(g,key(2),key(3),new Set()),null);
});
test('a road marked for use of a separate sidepath is not a walkable path',()=>{
 const data={osm3s:{timestamp_osm_base:'2026-01-01T00:00:00Z'},elements:[
  {type:'node',id:1,lat:37,lon:127},{type:'node',id:2,lat:37,lon:127.0001},
  {type:'way',id:1,nodes:[1,2],tags:{highway:'residential',foot:'use_sidepath'}},
 ]};
 const g=buildPedestrianGraph(data),key=(id:number)=>Object.keys(g.nodes).find(value=>value.startsWith(id+'@'))!;
 assert.equal(findPedestrianPath(g,key(1),key(2),new Set()),null);
});
test('a crossing with an inaccessible endpoint cannot masquerade as a complete shorter crossing',()=>{
 const data={osm3s:{timestamp_osm_base:'2026-01-01T00:00:00Z'},elements:[
  {type:'node',id:1,lat:37,lon:127},
  {type:'node',id:2,lat:37,lon:127.0001},
  {type:'node',id:3,lat:37,lon:127.0002,tags:{access:'no'}},
  {type:'way',id:1,nodes:[1,2,3],tags:{highway:'footway',footway:'crossing'}},
 ]};
 assert.equal(buildPedestrianGraph(data).edges.filter(edge=>edge.wayId===1).length,0);
});
