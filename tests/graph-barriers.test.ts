import {test} from 'node:test';
import assert from 'node:assert/strict';
import {graphBarriersForRoute} from '../lib/graph-barriers.ts';
import {buildPedestrianGraph} from '../lib/osm-graph.ts';
import {meters,type Coord,type Route} from '../lib/domain.ts';
const a:Coord=[127,37],b:Coord=[127.0003,37];
function route(coords:Coord[]):Route{return {id:'provider',name:'도보',options:[],coords,distance:meters(coords[0],coords[coords.length-1]),seconds:30,steps:[],samples:[],fetchedAt:''};}
function graph(tags:Record<string,string>){return buildPedestrianGraph({osm3s:{timestamp_osm_base:'2026-01-01T00:00:00Z'},elements:[
 {type:'node',id:1,lon:a[0],lat:a[1]},{type:'node',id:2,lon:b[0],lat:b[1]},
 {type:'way',id:10,nodes:[1,2],tags},
]});}
test('a forward-only wheelchair restriction does not block reverse travel',()=>{
 const source=graph({highway:'footway','wheelchair:forward':'no'});
 assert.ok(graphBarriersForRoute(route([a,b]),source).some(barrier=>barrier.source==='osm'));
 assert.deepEqual(graphBarriersForRoute(route([b,a]),source),[]);
});
test('stairs are excluded in both travel directions without provider stair instructions',()=>{
 const source=graph({highway:'steps'});
 for(const coords of [[a,b],[b,a]])assert.ok(graphBarriersForRoute(route(coords),source).some(barrier=>barrier.source==='osm'));
});
test('a perpendicular point intersection does not claim traversal of a blocked passage',()=>{
 const source=graph({highway:'steps'});
 assert.deepEqual(graphBarriersForRoute(route([[127.00014,36.9998],[127.00016,37.0002]]),source),[]);
});
