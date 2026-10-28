import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRoute, recommendedRoute, samplesFor, inspectionOrder, type Route, type Evidence, type Coord, type Finding } from '../lib/domain.ts';
import { requestSchema } from '../lib/requests.ts';
import { serverConfig, runWithServerEnv, type ServerConfig } from '../lib/server-config.ts';
import { createJourneyState, advanceJourneyState, reserveJourneyOperation, projectJourneyResult, journeyStateSchema, type JourneyState, type JourneyDependencies } from '../lib/journey.ts';
import {search} from '../lib/providers.ts';
import snapshot from '../data/yeongtong-campus.osm.json' with {type:'json'};
import {buildPedestrianGraph} from '../lib/osm-graph.ts';
const place = { id: 'a', name: 'a', address: 'a', coord: [127, 37] };
const route: Route = { id: 'r', name: 'r', options: [], coords: [[127, 37], [127, 37.01]], distance: 1100, seconds: 600, steps: [], samples: samplesFor([[127, 37], [127, 37.01]]), fetchedAt: '' };
function observed(sample:Route['samples'][number]):Evidence{
 const finding={status:'clear',reason:'연속된 보행 포장',pathVisible:true,routeMatch:'same-path',visibility:'visible',reviewReason:'none',evidence:['목표 통로'],limitations:[],observation:{connection:'not-applicable',surface:'continuous',uncertainty:'none',target:'sidewalk',reason:'보행 포장이 이어짐'}} as const;
 return {sampleId:sample.id,status:'clear',reason:finding.reason,checkedAt:'',finding:{...finding,evidence:[...finding.evidence],limitations:[]},source:{url:'https://map.kakao.com/?panoid=1',capturedAt:Date.now(),coord:sample.coord,distance:0}};
}
test('one clear observation cannot recommend an otherwise uninspected journey', () => {
    const evidence=observed(route.samples[0]);
    assert.equal(recommendedRoute([route], { 'r:s0': evidence }), null);
});
test('route guidance does not present the model’s unsupported wheelchair-width assertion as an observed fact',()=>{
 const item=observed(route.samples[0]);assert.ok(item.finding?.observation);
 const claim='볼라드 간격 사이로 휠체어 통행 가능한 유효 폭 확보';
 item.finding={...item.finding,reason:claim,evidence:[claim],observation:{...item.finding.observation,connection:'ramp',reason:claim}};
 const issue=evaluateRoute(route,{'r:s0':item}).issues[0];
 assert.equal(issue.status,'clear');
 assert.doesNotMatch(issue.reason,/폭|볼라드|휠체어/);
 assert.match(issue.reason,/경사로/);
});
test('bounded inspection finishes a candidate instead of leaving every candidate incomplete', () => {
    const samples=samplesFor([[127,37],[127,37.004]]);
    const candidates=['a','b','c'].map(id=>({...route,id,samples}));
    const evidence:Record<string,Evidence>={};
    for(const {route:candidate,sample} of inspectionOrder(candidates).slice(0,24)){
        evidence[candidate.id+':'+sample.id]=observed(sample);
    }
    assert.equal(recommendedRoute(candidates,evidence),'a');
});
test('recommendation requires completion and rejects any blocked or unknown sample', () => {
    const evidence:Record<string,Evidence>=Object.fromEntries(route.samples.map(sample=>['r:'+sample.id,observed(sample)]));
    assert.equal(recommendedRoute([route], evidence), 'r');
    const item=evidence['r:s0'];assert.ok(item.finding);
    item.finding={...item.finding,status:'blocked'};
    assert.equal(recommendedRoute([route], evidence), null);
    item.finding={...item.finding,status:'unknown'};
    assert.equal(recommendedRoute([route], evidence), null);
});
test('consumer requests reject keys, arbitrary models and manual analysis actions', () => {
    const valid = { action: 'journey', start: place, end: place, profile: '수동 휠체어', goal: 'arrival' };
    assert.equal(requestSchema.safeParse(valid).success, true);
    assert.equal(requestSchema.safeParse({ ...valid, goal: 'entrance' }).success, true);
    const withoutGoal = { action: valid.action, start: valid.start, end: valid.end, profile: valid.profile };
    assert.equal(requestSchema.safeParse(withoutGoal).success, false);
    assert.equal(requestSchema.safeParse({ ...valid, goal: 'sidewalk' }).success, false);
    for (const field of ['keys', 'model', 'provider', 'budget', 'apiKey'])
        assert.equal(requestSchema.safeParse({ ...valid, [field]: 'secret' }).success, false);
    assert.equal(requestSchema.safeParse({ action: 'inspect', sample: {} }).success, false);
    assert.equal(requestSchema.safeParse({ action: 'search', query: '경희대', keys: {} }).success, false);
});
test('request scoped secrets stay isolated and missing imagery cannot produce an analysis source', async () => {
    const config = { TMAP_API_KEY: 'tmap', CHATKHU_API_KEY: 'private', MAPILLARY_TOKEN: 'imagery' };
    assert.throws(() => runWithServerEnv({}, serverConfig));
    assert.equal(runWithServerEnv({ TMAP_API_KEY: 'a', CHATKHU_API_KEY: 'b' }, serverConfig).mapillary, '');
    await Promise.all(['one', 'two'].map(key => runWithServerEnv({ ...config, CHATKHU_API_KEY: key }, async () => { await Promise.resolve(); assert.equal(serverConfig().ai, key); })));
});

test('Kakao routing is selected only at configuration time and public map config excludes private keys', async () => {
    const {routingConfig,publicMapConfig}=await import('../lib/server-config.ts');
    runWithServerEnv({KAKAO_REST_API_KEY:'private-rest',KAKAO_JAVASCRIPT_KEY:'a'.repeat(32),CHATKHU_API_KEY:'private-ai',TMAP_API_KEY:'other'},()=>{
        assert.deepEqual(routingConfig(),{kind:'kakao',restKey:'private-rest'});
        assert.deepEqual(publicMapConfig(),{javascriptKey:'a'.repeat(32)});
    });
    assert.deepEqual(runWithServerEnv({TMAP_API_KEY:'fallback'},routingConfig),{kind:'tmap',apiKey:'fallback'});
});

test('place search keeps real destination contact information without accepting unsafe links',async t=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json({documents:[
  {id:'123',place_name:'가게',address_name:'주소',x:'127.0',y:'37.0',phone:'02-1234-5678',place_url:'http://place.map.kakao.com/123'},
  {id:'456',place_name:'다른 가게',address_name:'주소',x:'127.1',y:'37.1',phone:'javascript:alert(1)',place_url:'https://evil.example/456'},
  {id:'789',place_name:'불일치',address_name:'주소',x:'127.2',y:'37.2',phone:'',place_url:'https://place.map.kakao.com/456'},
  {id:'101',place_name:'연락처 없는 가게',address_name:'주소',x:'127.3',y:'37.3',phone:null,place_url:null},
 ]}));
 const places=await search('가게',{kind:'kakao',restKey:'test'});
 assert.equal(places[0].phone,'02-1234-5678');
 assert.equal(places[0].placeUrl,'https://place.map.kakao.com/123');
 assert.equal(places[1].phone,undefined);
 assert.equal(places[1].placeUrl,undefined);
 assert.equal(places[2].placeUrl,undefined);
 assert.equal(places[3].phone,undefined);
 assert.equal(places[3].placeUrl,undefined);
 assert.equal(requestSchema.safeParse({action:'journey',start:place,end:{...place,placeUrl:'https://evil.example/123'},profile:'수동 휠체어',goal:'arrival'}).success,false);
});

const walkingCoords:Coord[]=[[127,37],[127.0005,37],[127.001,37],[127.002,37]];
const walkingConfig:ServerConfig={routing:{kind:'kakao',restKey:'test'},ai:'test',model:'gemini-test',mapillary:'test',rendererToken:'test'};
function mockWalkingProvider(t:TestContext,steps:Route['steps']){
    t.mock.method(globalThis,'fetch',async(input:string|URL|Request)=>{
        const url=new URL(input instanceof Request?input.url:String(input));
        if(url.origin==='https://api.opentopodata.org')return new Response(null,{status:503});
        assert.equal(url.origin,'https://dapi.kakao.com');
        assert.equal(url.pathname,'/v2/routing/walk');
        return Response.json({status:'OK',route:{
            properties:{totalDistance:178,totalTime:180},
            legs:[{steps:steps.map((step,index)=>({
                properties:{x:step.coord[0],y:step.coord[1],guidance:step.text,distance:0,time:0},
                path:{points:index===0?walkingCoords:[walkingCoords[walkingCoords.length-1]]},
            }))}],
        }});
    });
}
function walkingJourney(goal:JourneyState['goal']='arrival',loadGraph?:Parameters<typeof createJourneyState>[3]){
    return createJourneyState({
        start:{id:'park-start',name:'공원 시작',address:'',coord:walkingCoords[0]},
        end:{id:'park-end',name:'공원 산책로 끝',address:'',coord:walkingCoords[walkingCoords.length-1]},
        profile:'수동 휠체어',goal,
    },walkingConfig,new AbortController().signal,loadGraph);
}
async function observeSample(state:JourneyState,candidate:Route,sample:Route['samples'][number],connection?:NonNullable<Finding['observation']>['connection']){
    const finding:Finding={
        status:'clear',reason:'목표 통로의 연속된 보행면을 관찰함',evidence:['목표 보행면'],limitations:[],
        pathVisible:true,routeMatch:'same-path',visibility:'visible',reviewReason:'none',
        observation:{connection:connection??(sample.target==='entrance'||sample.target==='crossing-entry'||sample.target==='crossing-exit'?'flush':'not-applicable'),surface:'continuous',uncertainty:'none',target:sample.target??'sidewalk',reason:'지정 목표와 이어지는 보행면을 관찰함'},
    };
    const deps:JourneyDependencies={
        streetImage:async point=>({image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{url:'https://map.kakao.com/?panoid='+point.id,panoId:point.id,capturedAt:Date.now(),coord:point.coord,heading:point.heading}}),
        analyzeKhuImage:async()=>({model:'gemini-test',finding,checkedAt:'2026-10-26T00:00:00Z',usage:{input:1,output:1}}),
        analyzeKhuViews:async()=>{throw Error('unexpected joint review');},
        reroute:async()=>{throw Error('unexpected reroute');},
    };
    await advanceJourneyState(state,{kind:'capture',route:candidate,sample},walkingConfig,new AbortController().signal,deps);
}
const groupedCrossingSteps:Route['steps']=[
    {text:'보행로 따라 이동',coord:walkingCoords[0]},
    {text:'2개의 횡단보도 이용',coord:walkingCoords[1]},
    {text:'보행로 계속 이동',coord:walkingCoords[2]},
    {text:'목적지 도착',coord:walkingCoords[3]},
];
test('grouped provider crossings stay unresolved even when every sampled connection is observed clear',async t=>{
    mockWalkingProvider(t,groupedCrossingSteps);
    const state=await walkingJourney(),candidate=state.candidates[0];
    assert.equal(candidate.terrain?.status,'unavailable');
    assert.ok(candidate.unresolvedCrossings);
    assert.equal(candidate.unresolvedCrossings.length,1);
    assert.equal(candidate.unresolvedCrossings[0].count,2);
    assert.ok(candidate.samples.some(sample=>sample.target==='crossing-entry'));
    for(const sample of candidate.samples)await observeSample(state,candidate,sample);
    const restored=journeyStateSchema.parse(JSON.parse(JSON.stringify(state)));
    assert.deepEqual(restored.candidates[0].unresolvedCrossings,candidate.unresolvedCrossings);
    const result=projectJourneyResult(restored),decision=result.assessments[candidate.id].decision;
    assert.ok(Object.values(result.evidence).every(item=>item.status==='clear'&&!item.review));
    assert.equal(decision.issues.filter(issue=>issue.source==='imagery').length,candidate.samples.length);
    assert.ok(decision.issues.filter(issue=>issue.source==='imagery').every(issue=>issue.status==='clear'));
    assert.equal(result.recommendedId,null);
    assert.equal(decision.kind,'hold');
    assert.equal(decision.issues.filter(issue=>issue.source==='provider'&&issue.status==='unknown').length,1);
    assert.equal(decision.issues.some(issue=>issue.status==='blocked'),false);
    assert.deepEqual(result.assessments[candidate.id].blockedPassageIds,[]);
});
test('provider underground guidance remains unresolved even after surface images are clear',async t=>{
    mockWalkingProvider(t,[{text:'보행로 이동',coord:walkingCoords[0]},{text:'지하보도 이용',coord:walkingCoords[1]},{text:'목적지 도착',coord:walkingCoords[3]}]);
    const state=await walkingJourney(),candidate=state.candidates[0];
    const operation=reserveJourneyOperation(state);
    assert.equal(operation?.kind,'replan');
    assert.equal(state.exclusions.find(exclusion=>exclusion.sampleId==='connection-step-1')?.reason,'unverified');
    for(const sample of candidate.samples)await observeSample(state,candidate,sample);
    const result=projectJourneyResult(journeyStateSchema.parse(JSON.parse(JSON.stringify(state))));
    assert.equal(result.recommendedId,null);
    const issue=result.assessments[candidate.id].decision.issues.find(point=>point.sampleId==='connection-step-1');
    assert.equal(issue?.status,'unknown');
    assert.equal(issue?.source,'provider');
});
test('a route beginning away from the selected start cannot be recommended as a complete journey',async t=>{
    mockWalkingProvider(t,[{text:'보행로 이동',coord:walkingCoords[0]},{text:'목적지 도착',coord:walkingCoords[3]}]);
    const state=await createJourneyState({start:{id:'a',name:'역',address:'',coord:[126.999,37]},end:{id:'b',name:'도착',address:'',coord:walkingCoords[3]},profile:'수동 휠체어',goal:'arrival'},walkingConfig,new AbortController().signal);
    const candidate=state.candidates[0];
    for(const sample of candidate.samples)await observeSample(state,candidate,sample);
    const restored=journeyStateSchema.parse(JSON.parse(JSON.stringify(state)));
    const result=projectJourneyResult(restored),decision=result.assessments[candidate.id].decision;
    const issue=decision.issues.find(point=>point.sampleId==='connection-origin');
    assert.equal(decision.kind,'hold');
    assert.equal(issue?.status,'unknown');
    assert.equal(issue?.source,'geometry');
    assert.match(issue?.reason??'',/출발지.*직선거리/);
    assert.equal(result.recommendedId,null);
    assert.equal(restored.exclusions.some(exclusion=>exclusion.sampleId==='connection-origin'),false);
});
test('a route ending far from the selected destination does not claim the destination was reached',async t=>{
    mockWalkingProvider(t,[{text:'보행로 이동',coord:walkingCoords[0]},{text:'목적지 도착',coord:walkingCoords[3]}]);
    const state=await createJourneyState({start:{id:'a',name:'출발',address:'',coord:walkingCoords[0]},end:{id:'b',name:'도착',address:'',coord:[127.003,37]},profile:'수동 휠체어',goal:'arrival'},walkingConfig,new AbortController().signal);
    const candidate=state.candidates[0];
    for(const sample of candidate.samples)await observeSample(state,candidate,sample);
    const decision=projectJourneyResult(state).assessments[candidate.id].decision;
    assert.equal(decision.kind,'hold');
    assert.equal(decision.issues.find(issue=>issue.sampleId==='connection-destination')?.status,'unknown');
});
test('a ten metre destination gap remains an unverified route, not an arrival',async t=>{
    mockWalkingProvider(t,[{text:'보행로 이동',coord:walkingCoords[0]},{text:'목적지 도착',coord:walkingCoords[3]}]);
    const state=await createJourneyState({start:{id:'a',name:'출발',address:'',coord:walkingCoords[0]},end:{id:'b',name:'도착',address:'',coord:[127.002112,37]},profile:'수동 휠체어',goal:'arrival'},walkingConfig,new AbortController().signal);
    const candidate=state.candidates[0];
    for(const sample of candidate.samples)await observeSample(state,candidate,sample);
    const issue=projectJourneyResult(state).assessments[candidate.id].decision.issues.find(point=>point.sampleId==='connection-destination');
    assert.equal(issue?.status,'unknown');
    assert.match(issue.reason,/직선거리.*이동 경로로 확인되지/);
    assert.equal(projectJourneyResult(state).recommendedId,null);
});

test('a mapped crossing omitted from provider text requires both separately observed connections',async t=>{
    mockWalkingProvider(t,[{text:'보행로 이동',coord:walkingCoords[0]},{text:'목적지 도착',coord:walkingCoords[3]}]);
    const graph=buildPedestrianGraph({osm3s:{timestamp_osm_base:'2026-01-01T00:00:00Z'},elements:[
        {type:'node',id:1,lon:127.0006,lat:37},{type:'node',id:2,lon:127.0008,lat:37},
        {type:'way',id:10,nodes:[1,2],tags:{highway:'footway',footway:'crossing'}},
    ]});
    const state=await createJourneyState({start:{id:'a',name:'출발',address:'',coord:walkingCoords[0]},end:{id:'b',name:'도착',address:'',coord:walkingCoords[3]},profile:'수동 휠체어',goal:'arrival'},walkingConfig,new AbortController().signal,async()=>({kind:'available',graph}));
    const candidate=state.candidates[0],targets=candidate.samples.filter(sample=>sample.target==='crossing-entry'||sample.target==='crossing-exit');
    assert.deepEqual(targets.map(sample=>sample.target),['crossing-entry','crossing-exit']);
    assert.ok(targets.every(sample=>sample.critical));
    assert.deepEqual(candidate.crossingSources?.map(source=>source.wayIds),[[10]]);
    for(const sample of candidate.samples.filter(sample=>sample.target!=='crossing-exit'))await observeSample(state,candidate,sample);
    assert.equal(projectJourneyResult(state).recommendedId,null);
    await observeSample(state,candidate,targets[1]);
    assert.equal(projectJourneyResult(state).recommendedId,candidate.id);
});
test('mapped provider crossings are not duplicated by independent discovery',async t=>{
    const entry:Coord=[127.0006,37],exit:Coord=[127.0008,37];
    const graph=buildPedestrianGraph({osm3s:{timestamp_osm_base:'2026-01-01T00:00:00Z'},elements:[
        {type:'node',id:1,lon:entry[0],lat:entry[1]},{type:'node',id:2,lon:exit[0],lat:exit[1]},
        {type:'way',id:10,nodes:[1,2],tags:{highway:'footway',footway:'crossing'}},
    ]});
    const start={id:'a',name:'출발',address:'',coord:walkingCoords[0]},end={id:'b',name:'도착',address:'',coord:walkingCoords[3]};
    mockWalkingProvider(t,[{text:'보행로 이동',coord:walkingCoords[0]},{text:'횡단보도 이용',coord:entry},{text:'보행로 이동',coord:exit}]);
    const state=await createJourneyState({start,end,profile:'수동 휠체어',goal:'arrival'},walkingConfig,new AbortController().signal,async()=>({kind:'available',graph}));
    const candidate=state.candidates[0];
    assert.deepEqual(candidate.samples.filter(sample=>sample.target==='crossing-entry'||sample.target==='crossing-exit').map(sample=>sample.target),['crossing-entry','crossing-exit']);
    assert.deepEqual(candidate.crossingSources?.map(source=>source.wayIds),[[10]]);
    assert.deepEqual(candidate.unresolvedCrossings,[]);
});
test('a mapped single crossing resolves missing provider exit geometry without duplicating targets',async t=>{
    const entry:Coord=[127.0006,37],exit:Coord=[127.0008,37];
    mockWalkingProvider(t,[{text:'보행로 이동',coord:walkingCoords[0]},{text:'횡단보도 이용',coord:entry},{text:'목적지 도착',coord:walkingCoords[3]}]);
    const graph=buildPedestrianGraph({osm3s:{timestamp_osm_base:'2026-01-01T00:00:00Z'},elements:[
        {type:'node',id:1,lon:entry[0],lat:entry[1]},{type:'node',id:2,lon:exit[0],lat:exit[1]},
        {type:'way',id:10,nodes:[1,2],tags:{highway:'footway',footway:'crossing'}},
    ]});
    const state=await createJourneyState({start:{id:'a',name:'출발',address:'',coord:walkingCoords[0]},end:{id:'b',name:'도착',address:'',coord:walkingCoords[3]},profile:'수동 휠체어',goal:'arrival'},walkingConfig,new AbortController().signal,async()=>({kind:'available',graph}));
    const candidate=state.candidates[0],targets=candidate.samples.filter(sample=>sample.target==='crossing-entry'||sample.target==='crossing-exit');
    assert.deepEqual(targets.map(sample=>sample.target),['crossing-entry','crossing-exit']);
    assert.deepEqual(candidate.unresolvedCrossings,[]);
    for(const sample of candidate.samples)await observeSample(state,candidate,sample);
    assert.equal(projectJourneyResult(state).recommendedId,candidate.id);
});
test('independent map discovery does not erase unresolved grouped provider guidance',async t=>{
    const entry:Coord=[127.0006,37],exit:Coord=[127.0008,37];
    mockWalkingProvider(t,[{text:'보행로 이동',coord:walkingCoords[0]},{text:'2개의 횡단보도 이용',coord:entry},{text:'보행로 이동',coord:exit}]);
    const graph=buildPedestrianGraph({osm3s:{timestamp_osm_base:'2026-01-01T00:00:00Z'},elements:[
        {type:'node',id:1,lon:entry[0],lat:entry[1]},{type:'node',id:2,lon:exit[0],lat:exit[1]},
        {type:'way',id:10,nodes:[1,2],tags:{highway:'footway',footway:'crossing'}},
    ]});
    const state=await createJourneyState({start:{id:'a',name:'출발',address:'',coord:walkingCoords[0]},end:{id:'b',name:'도착',address:'',coord:walkingCoords[3]},profile:'수동 휠체어',goal:'arrival'},walkingConfig,new AbortController().signal,async()=>({kind:'available',graph}));
    const candidate=state.candidates[0];
    assert.equal(candidate.unresolvedCrossings?.length,1);
    assert.equal(candidate.unresolvedCrossings?.[0].count,2);
    assert.equal(candidate.samples.filter(sample=>sample.target==='crossing-entry').length,1);
    for(const sample of candidate.samples)await observeSample(state,candidate,sample);
    assert.equal(projectJourneyResult(state).recommendedId,null);
});
test('a parallel offset crossing without safely matched endpoints remains unresolved',async t=>{
    mockWalkingProvider(t,[{text:'보행로 이동',coord:walkingCoords[0]},{text:'목적지 도착',coord:walkingCoords[3]}]);
    const graph=buildPedestrianGraph({osm3s:{timestamp_osm_base:'2026-01-01T00:00:00Z'},elements:[
        {type:'node',id:1,lon:127.0006,lat:37.00002},{type:'node',id:2,lon:127.0008,lat:37.00002},
        {type:'way',id:10,nodes:[1,2],tags:{highway:'footway',footway:'crossing'}},
    ]});
    const state=await createJourneyState({start:{id:'a',name:'출발',address:'',coord:walkingCoords[0]},end:{id:'b',name:'도착',address:'',coord:walkingCoords[3]},profile:'수동 휠체어',goal:'arrival'},walkingConfig,new AbortController().signal,async()=>({kind:'available',graph}));
    const candidate=state.candidates[0];
    assert.equal(candidate.samples.some(sample=>sample.target==='crossing-entry'||sample.target==='crossing-exit'),false);
    assert.equal(candidate.unresolvedCrossings?.length,1);
    assert.equal(candidate.unresolvedCrossings?.[0].source,'osm');
    assert.equal(journeyStateSchema.parse(JSON.parse(JSON.stringify(state))).candidates[0].unresolvedCrossings?.[0].source,'osm');
    for(const sample of candidate.samples)await observeSample(state,candidate,sample);
    assert.equal(projectJourneyResult(state).recommendedId,null);
    assert.equal(projectJourneyResult(state).assessments[candidate.id].decision.kind,'hold');
});
test('an outdoor arrival can complete without a building connection, but an explicit entrance cannot',async t=>{
    mockWalkingProvider(t,[{text:'보행로 따라 이동',coord:walkingCoords[0]},{text:'목적지 도착',coord:walkingCoords[3]}]);
    const graph=buildPedestrianGraph({osm3s:{timestamp_osm_base:'2026-01-01T00:00:00Z'},elements:[{type:'node',id:1,lon:walkingCoords[0][0],lat:walkingCoords[0][1]},{type:'node',id:2,lon:walkingCoords[3][0],lat:walkingCoords[3][1]},{type:'way',id:1,nodes:[1,2],tags:{highway:'footway'}}]});
    for(const goal of ['arrival','entrance'] as const){
        const state=await walkingJourney(goal,async()=>({kind:'available',graph})),candidate=state.candidates[0],endpoint=candidate.samples[candidate.samples.length-1];
        assert.equal(endpoint.target,goal);
        assert.equal(endpoint.critical,true);
        for(const sample of candidate.samples)await observeSample(state,candidate,sample,'not-applicable');
        const result=projectJourneyResult(state);
        assert.equal(result.goal,goal);
        if(goal==='arrival'){
            assert.equal(result.recommendedId,candidate.id);
            assert.equal(result.assessments[candidate.id].decision.kind,'recommended');
        }else{
            assert.equal(result.recommendedId,null);
            assert.equal(result.assessments[candidate.id].decision.kind,'hold');
            assert.equal(state.evidence[candidate.id+':'+endpoint.id].review?.state,'pending');
            await observeSample(state,candidate,endpoint,'flush');
            assert.equal(projectJourneyResult(state).recommendedId,candidate.id);
        }
    }
});
for(const geometry of ['missing','off-route','backwards','too-far'] as const)test(`a crossing with ${geometry} end geometry stays unresolved rather than cleared by sampled sidewalk`,async t=>{
    const steps:Route['steps']=[{text:'보행로 따라 이동',coord:walkingCoords[0]},{text:'횡단보도 이용',coord:walkingCoords[1]}];
    if(geometry!=='missing')steps.push({text:'보행로 계속 이동',coord:geometry==='off-route'?[127.001,37.002]:geometry==='backwards'?walkingCoords[0]:walkingCoords[3]});
    mockWalkingProvider(t,steps);
    const state=await walkingJourney(),candidate=state.candidates[0];
    assert.ok(candidate.unresolvedCrossings);
    assert.equal(candidate.unresolvedCrossings.length,1);
    assert.equal(candidate.unresolvedCrossings[0].count,1);
    assert.equal(candidate.samples.some(sample=>sample.target==='crossing-exit'),false);
    for(const sample of candidate.samples)await observeSample(state,candidate,sample);
    const result=projectJourneyResult(state),decision=result.assessments[candidate.id].decision;
    assert.equal(result.recommendedId,null);
    assert.equal(decision.kind,'hold');
    assert.ok(decision.issues.some(issue=>issue.source==='provider'&&issue.status==='unknown'));
    assert.equal(decision.issues.some(issue=>issue.status==='blocked'),false);
});
test('a grouped unknown connection waits for critical observations, then requests only an information-gap bypass',async t=>{
    mockWalkingProvider(t,groupedCrossingSteps);
    const state=await walkingJourney(),candidate=state.candidates[0];
    const critical=candidate.samples.filter(sample=>sample.critical);
    assert.ok(critical.length>1);
    for(let index=0;index<critical.length;index++){
        assert.deepEqual(state.exclusions,[]);
        assert.deepEqual(state.pendingReplans,[]);
        const operation=reserveJourneyOperation(state);
        assert.ok(operation?.kind==='capture');
        assert.equal(operation.sample.critical,true);
        await observeSample(state,operation.route,operation.sample);
        assert.deepEqual(state.exclusions,[]);
        assert.deepEqual(state.pendingReplans,[]);
        assert.equal(projectJourneyResult(state).recommendedId,null);
    }
    assert.ok(critical.every(sample=>state.evidence[candidate.id+':'+sample.id]?.stage==='processed'));
    const operation=reserveJourneyOperation(state);
    assert.equal(operation?.kind,'replan');
    assert.equal(state.exclusions.length,1);
    assert.equal(state.exclusions[0].reason,'unverified');
    assert.equal(state.exclusions[0].sampleId,candidate.unresolvedCrossings?.[0].id);
    assert.ok(state.pendingReplans.length>0);
    const result=projectJourneyResult(state),assessment=result.assessments[candidate.id];
    assert.equal(result.recommendedId,null);
    assert.equal(assessment.decision.kind,'hold');
    assert.deepEqual(assessment.blockedPassageIds,[]);
    assert.equal(assessment.decision.issues.some(issue=>issue.status==='blocked'),false);
    assert.equal(state.exclusions.some(passage=>passage.reason==='obstacle'),false);
    state.pendingReplans=[];state.replans=4;
    const next=reserveJourneyOperation(state);
    assert.ok(next?.kind==='capture','an unresolved crossing must not stop inspection of other route points');
    assert.notEqual(next.sample.id,candidate.unresolvedCrossings?.[0].id);
    await observeSample(state,next.route,next.sample);
    assert.equal(state.evidence[candidate.id+':'+next.sample.id].stage,'processed');
    assert.equal(projectJourneyResult(state).recommendedId,null,'an unresolved crossing still prevents a full recommendation');
});
test('a following destination instruction does not establish a crossing exit',async t=>{
 mockWalkingProvider(t,[{text:'출발',coord:walkingCoords[0]},{text:'횡단보도 이용',coord:walkingCoords[2]},{text:'목적지 도착',coord:walkingCoords[3]}]);
 const state=await walkingJourney(),candidate=state.candidates[0];
 assert.ok(candidate.samples.some(sample=>sample.target==='arrival'));
 assert.equal(candidate.samples.some(sample=>sample.target==='crossing-exit'),false);
 for(const sample of candidate.samples)await observeSample(state,candidate,sample);
 const decision=projectJourneyResult(state).assessments[candidate.id].decision;
 assert.equal(decision.kind,'hold');
 assert.ok(decision.issues.some(issue=>issue.source==='provider'&&issue.status==='unknown'));
});

test('route-specific graph data identifies crossings outside the bundled region without asserting accessibility',async t=>{
    const original:Coord[]=[[127.07562034,37.24787123],[127.07560235,37.24781289],[127.07586059,37.24782826],[127.07587785,37.24780426],[127.07592363,37.24778565],[127.07597188,37.24741675]];
    const coords:Coord[]=original.map(([x,y])=>[x+1,y]);
    const base=buildPedestrianGraph(snapshot);
    const graph={...base,nodes:Object.fromEntries(Object.entries(base.nodes).map(([id,node])=>[id,{...node,coord:[node.coord[0]+1,node.coord[1]] as Coord}]))};
    t.mock.method(globalThis,'fetch',async(input:string|URL|Request)=>{
        const url=new URL(input instanceof Request?input.url:String(input));
        if(url.origin==='https://api.opentopodata.org')return new Response(null,{status:503});
        assert.equal(url.origin,'https://dapi.kakao.com');
        return Response.json({status:'OK',route:{properties:{totalDistance:80,totalTime:100},legs:[{steps:[
            {properties:{x:coords[0][0],y:coords[0][1],guidance:'출발',distance:0,time:0},path:{points:coords}},
            {properties:{x:coords[1][0],y:coords[1][1],guidance:'2개의 횡단보도 이용',distance:0,time:0},path:{points:[coords[5]]}},
            {properties:{x:coords[5][0],y:coords[5][1],guidance:'도착',distance:0,time:0},path:{points:[coords[5]]}},
        ]}]}});
    });
    const input={start:{id:'a',name:'a',address:'',coord:coords[0]},end:{id:'b',name:'b',address:'',coord:coords[5]},profile:'수동 휠체어',goal:'arrival' as const};
    const state=await createJourneyState(input,walkingConfig,new AbortController().signal,async()=>({kind:'available',graph}));
    const candidate=state.candidates[0];
    assert.deepEqual(candidate.graphCoverage,{status:'available',snapshotAt:graph.snapshotAt});
    assert.equal(candidate.unresolvedCrossings?.length,0);
    assert.equal(candidate.crossingSources?.[0].snapshotAt,graph.snapshotAt);
    assert.equal(candidate.samples.filter(sample=>sample.target==='crossing-entry'||sample.target==='crossing-exit').length,4);
    const restored=journeyStateSchema.parse(JSON.parse(JSON.stringify(state)));
    assert.deepEqual(restored.candidates[0].graphCoverage,candidate.graphCoverage);
    assert.equal(projectJourneyResult(restored).recommendedId,null);
    assert.equal(JSON.stringify(restored).includes('"nodes"'),false);
});

test('unavailable graph retains the provider route and an unresolved crossing',async t=>{
    mockWalkingProvider(t,groupedCrossingSteps);
    const input={start:{id:'a',name:'a',address:'',coord:walkingCoords[0]},end:{id:'b',name:'b',address:'',coord:walkingCoords[3]},profile:'수동 휠체어',goal:'arrival' as const};
    const state=await createJourneyState(input,walkingConfig,new AbortController().signal,async()=>({kind:'unavailable',reason:'network'}));
    const candidate=state.candidates[0];
    assert.deepEqual(candidate.graphCoverage,{status:'unavailable',reason:'network'});
    assert.equal(candidate.unresolvedCrossings?.length,1);
    assert.deepEqual(journeyStateSchema.parse(JSON.parse(JSON.stringify(state))).candidates[0].graphCoverage,candidate.graphCoverage);
    assert.equal(projectJourneyResult(state).assessments[candidate.id].decision.kind,'hold');
    assert.deepEqual(state.exclusions,[]);
});

test('reroutes load their own graph and retain unavailable coverage through persistence',async t=>{
    mockWalkingProvider(t,groupedCrossingSteps);
    const state=await walkingJourney();
    const baseline=state.candidates[0];
    const coords:Coord[]=[walkingCoords[0],[127.001,37.0002],walkingCoords[3]];
    const candidate:Route={...baseline,id:'reroute',coords,samples:samplesFor(coords),steps:[],distance:190};
    let requested:Route|undefined;
    const deps:JourneyDependencies={
        streetImage:async()=>{throw Error('unexpected capture');},
        analyzeKhuImage:async()=>{throw Error('unexpected analysis');},
        analyzeKhuViews:async()=>{throw Error('unexpected review');},
        reroute:async()=>candidate,
        loadPedestrianGraph:async route=>{requested=route;return {kind:'unavailable',reason:'no-data'};},
    };
    await advanceJourneyState(state,{kind:'replan',via:[[127.001,37.0002]]},walkingConfig,new AbortController().signal,deps);
    assert.equal(requested?.id,'reroute');
    assert.deepEqual(state.candidates[0].graphCoverage,{status:'unavailable',reason:'no-data'});
    assert.deepEqual(journeyStateSchema.parse(JSON.parse(JSON.stringify(state))).candidates[0].graphCoverage,state.candidates[0].graphCoverage);
});

test('cancellation during graph acquisition aborts journey creation',async t=>{
    mockWalkingProvider(t,groupedCrossingSteps);
    const controller=new AbortController();
    const input={start:{id:'a',name:'a',address:'',coord:walkingCoords[0]},end:{id:'b',name:'b',address:'',coord:walkingCoords[3]},profile:'수동 휠체어',goal:'arrival' as const};
    await assert.rejects(createJourneyState(input,walkingConfig,controller.signal,async()=>{
        controller.abort();
        return {kind:'unavailable',reason:'network'};
    }),{name:'AbortError'});
});
