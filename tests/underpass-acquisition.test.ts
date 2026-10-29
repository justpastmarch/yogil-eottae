import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mappedUnderpassEntry,underpassApproachSamples,underpassCameraMatches} from '../lib/underpass-acquisition.ts';
import {buildPedestrianGraph} from '../lib/osm-graph.ts';
import {captureAdjacentViews,pointsAwayFromTarget} from '../lib/adjacent-views.ts';
import {evaluateRoute,projectOnRoute,type Coord,type Route,type Sample,type Finding,type Evidence} from '../lib/domain.ts';
import {routeImageContext} from '../lib/route-context.ts';
import {JOURNEY_VERSION,journeyStateSchema,advanceJourneyState,projectJourneyResult,type JourneyState,type JourneyDependencies} from '../lib/journey.ts';
import type {ServerConfig} from '../lib/server-config.ts';

const coords:Coord[]=[[127.07766409,37.2477674],[127.07803586,37.24776716],[127.07867899,37.24777511],[127.07867893,37.24780213],[127.07897268,37.24780531],[127.07916611,37.24776072],[127.07918838,37.24750109],[127.07877697,37.24748672],[127.07877723,37.24751951]];
const mouth:Coord=[127.0787272,37.2478213];
const hint={id:'connection-step-1',kind:'underpass',coord:coords[2],along:projectOnRoute(coords,coords[2])?.along??0,reason:'지하보도 이용 안내'} satisfies NonNullable<Route['unverifiedConnections']>[number];
const original:Sample={id:'s2',coord:hint.coord,along:hint.along,heading:89,critical:true,target:'sidewalk'};
const route:Route={id:'test-route',name:'이름과 무관한 후보',coords,distance:206,seconds:200,steps:[{text:'보도 이동',coord:coords[0]},{text:'지하보도 이용',coord:hint.coord},{text:'보도 이동',coord:coords[8]}],samples:[original],unverifiedConnections:[hint],options:[],fetchedAt:''};
function graphData(){return {osm3s:{timestamp_osm_base:'2026-10-26T21:24:46Z'},elements:[
    {type:'node',id:1,lon:127.0784,lat:37.24782},{type:'node',id:2,lon:mouth[0],lat:mouth[1]},
    {type:'node',id:3,lon:127.0787365,lat:37.247432},{type:'node',id:4,lon:127.0785,lat:37.24743},
    {type:'node',id:5,lon:127.0792201,lat:37.2474849},{type:'node',id:6,lon:127.0792173,lat:37.2478254},
    {type:'way',id:10,nodes:[1,2],tags:{highway:'footway',footway:'sidewalk'}},
    {type:'way',id:20,nodes:[3,5,6,2],tags:{highway:'footway',tunnel:'yes',layer:'-1'}},
    {type:'way',id:30,nodes:[3,4],tags:{highway:'footway',footway:'sidewalk'}},
]};}
const graph=buildPedestrianGraph(graphData());
const config:ServerConfig={routing:{kind:'kakao',restKey:'test'},ai:'test',model:'gemini-test',mapillary:'',rendererToken:'test'};
function entry(){const selected=mappedUnderpassEntry(route,hint,graph);assert.ok(selected);return selected;}
function state(sample:Sample):JourneyState{
    return {version:JOURNEY_VERSION,provider:'kakao',goal:'arrival',start:{id:'start',name:'start',address:'',coord:coords[0]},end:{id:'end',name:'end',address:'',coord:coords[8]},profile:'수동 휠체어',candidates:[{...route,samples:[original,sample]}],evidence:{},exclusions:[],pendingReplans:[],lookups:0,analyses:0,replans:0,phase:'running'};
}
function finding(target:NonNullable<Finding['observation']>['target']='underpass-entry',connection:NonNullable<Finding['observation']>['connection']='flush'):Finding{
    return {status:'clear',reason:'지정한 입구 연결부 관찰',evidence:[],limitations:[],pathVisible:true,routeMatch:'same-path',visibility:'visible',reviewReason:'none',observation:{target,connection,surface:'continuous',uncertainty:'none',reason:'지정된 첫 연결부의 노면이 보임'}};
}
test('only the uniquely route-linked tunnel portal becomes a separate exact acquisition target',()=>{
    const before=structuredClone(route),selected=entry();
    assert.deepEqual(selected.coord,mouth);
    assert.equal(selected.target,'underpass-entry');
    assert.equal(selected.acquisition?.nodeId,'2@portal');
    assert.equal(selected.acquisition?.wayId,20);
    assert.notEqual(selected.id,original.id);
    assert.deepEqual(route,before);
});
test('no graph, disconnected graph, and competing nearby portals preserve the original provider hint fallback',()=>{
    assert.equal(mappedUnderpassEntry(route,hint),null);
    assert.equal(mappedUnderpassEntry(route,hint,{...graph,edges:graph.edges.filter(edge=>edge.wayId!==10)}),null);
    const ambiguous=graphData();
    ambiguous.elements.push({type:'node',id:7,lon:127.07876,lat:37.247822});
    ambiguous.elements.push({type:'way',id:11,nodes:[1,7],tags:{highway:'footway',footway:'sidewalk'}},{type:'way',id:21,nodes:[7,6,5,3],tags:{highway:'footway',tunnel:'yes',layer:'-1'}});
    assert.equal(mappedUnderpassEntry(route,hint,buildPedestrianGraph(ambiguous)),null);
    assert.deepEqual(route.samples,[original]);
});
test('matching preserves metadata through persisted state and distinguishes entry observations from sidewalk or whole-facility claims',()=>{
    const selected=entry(),restored=journeyStateSchema.parse(JSON.parse(JSON.stringify(state(selected))));
    assert.deepEqual(restored.candidates[0].samples[1],selected);
    const record=(value:Finding):Evidence=>({sampleId:selected.id,stage:'processed',status:value.status,reason:value.reason,finding:value,source:{url:'https://map.kakao.com/?panoid=test',capturedAt:null,coord:selected.coord,distance:0},checkedAt:''});
    for(const wrong of [finding('sidewalk'),finding('underpass-entry','not-applicable')]){
        const decision=evaluateRoute(restored.candidates[0],{[route.id+':'+selected.id]:record(wrong)});
        assert.equal(decision.issues.find(issue=>issue.sampleId===selected.id)?.status,'unknown');
    }
    restored.evidence[route.id+':'+selected.id]=record(finding());
    const result=projectJourneyResult(restored);
    assert.equal(result.assessments[route.id].decision.issues.find(issue=>issue.sampleId===selected.id)?.status,'clear');
    assert.equal(result.assessments[route.id].decision.issues.find(issue=>issue.sampleId===original.id)?.status,'unknown');
    assert.equal(result.assessments[route.id].admission.kind,'requires-check');
    assert.deepEqual(restored.candidates[0].unverifiedConnections,[hint]);
    assert.equal(result.recommendedId,null);
});
for(const reason of ['framing','occlusion'] as const)test(`${reason} recovery uses three upstream oblique cameras aimed at the exact entry`,async()=>{
    const sample=entry(),requested:Sample[]=[];
    const result=await captureAdjacentViews({route,sample,initialSource:{url:'https://map.kakao.com/?panoid=old',capturedAt:null,coord:coords[2],heading:89,distance:7},limit:3,reason,config,signal:new AbortController().signal,capture:async(point,_config,_signal,options)=>{
        requested.push(point);assert.deepEqual(options?.target,mouth);assert.ok(point.along<hint.along);
        return {image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{url:'https://map.kakao.com/?panoid='+point.along,panoId:String(point.along),coord:point.coord,heading:point.heading,capturedAt:null}};
    }});
    assert.equal(requested.length,3);assert.equal(result.views.length,3);
    assert.ok(requested.every(point=>point.along<=hint.along-24));
    assert.match(result.context,/underpass-entry/);assert.match(result.context,/connection-step-1/);
    assert.match(result.context,/지하보도 전체/);
});
test('a returned camera snapped across the portal is rejected despite a valid upstream request',async()=>{
    const sample=entry();
    assert.equal(underpassCameraMatches(route,sample,coords[4]),false);
    const result=await captureAdjacentViews({route,sample,limit:3,config,signal:new AbortController().signal,capture:async point=>({image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{url:'https://map.kakao.com/?panoid=wrong',panoId:'wrong',coord:coords[4],heading:point.heading,capturedAt:null}})});
    assert.equal(result.attempts,3);assert.equal(result.views.length,0);
});
test('initial acquisition is upstream and an entry-facing photo cannot be reused as an unrelated sample',async()=>{
    const sample=entry(),s=state(sample),calls:Sample[]=[];
    const deps:JourneyDependencies={streetImage:async(point,_config,_signal,options)=>{
        calls.push(point);assert.deepEqual(options?.target,sample.coord);
        assert.ok(point.along<hint.along);
        return {image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{url:'https://map.kakao.com/?panoid=entry',panoId:'entry',coord:point.coord,heading:point.heading,capturedAt:null}};
    },analyzeKhuImage:async()=>({model:'gemini-test',finding:finding(),checkedAt:'',usage:{input:0,output:0}}),analyzeKhuViews:async()=>{throw Error('unexpected review');},reroute:async()=>{throw Error('unexpected reroute');}};
    await advanceJourneyState(s,{kind:'capture',route:s.candidates[0],sample},config,new AbortController().signal,deps);
    assert.equal(calls.length,1);assert.ok(s.evidence[route.id+':'+sample.id]);assert.equal(s.evidence[route.id+':'+original.id],undefined);
    assert.equal(projectJourneyResult(s).assessments[route.id].admission.kind,'requires-check');
    const camera=underpassApproachSamples(route,sample,[12])[0].sample;
    const context=routeImageContext({route,sample,source:{url:'https://map.kakao.com/?panoid=x',coord:camera.coord,heading:camera.heading,capturedAt:null}});
    assert.match(context,/providerHint/);assert.match(context,/지도 노드는 촬영 목표 후보/);
    assert.equal(pointsAwayFromTarget({coord:camera.coord,heading:(camera.heading+180)%360},sample),true);
});


test('a perpendicular or backward tunnel branch cannot become the route entry target',()=>{
    const outgoing=graph.edges.find(edge=>edge.structure==='tunnel'&&edge.from==='2@portal');assert.ok(outgoing);
    for(const next of [[mouth[0],mouth[1]+.0002],[mouth[0]-.0002,mouth[1]]] satisfies Coord[]){
        const different=structuredClone(graph);different.nodes[outgoing.to].coord=next;
        assert.equal(mappedUnderpassEntry(route,hint,different),null);
    }
});
