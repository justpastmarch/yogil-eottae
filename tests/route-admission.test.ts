import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import {JOURNEY_VERSION,journeyStateSchema,projectJourneyResult,reserveJourneyOperation,advanceJourneyState} from '../lib/journey.ts';

import {journeyResponse} from '../lib/requests.ts';
import {assessRouteAdmission,evaluateRoute,type Evidence,type Finding,type Route} from '../lib/domain.ts';
import {routeAdmissionStatus,routeAnalysisStatus,routeGuideBlocked,customerRouteIssues} from '../app/route-presentation.ts';

const frozen=z.object({goal:journeyResponse.shape.goal,routes:journeyResponse.shape.routes,evidence:journeyResponse.shape.evidence,profile:journeyStateSchema.shape.profile}).parse(JSON.parse(await readFile(new URL('./fixtures/route-admission-real-cases.json',import.meta.url),'utf8')));
function actualState(){
    const first=frozen.routes[0];
    return journeyStateSchema.parse({version:JOURNEY_VERSION,provider:'kakao',goal:frozen.goal,profile:frozen.profile,start:{id:'start',name:'출발',address:'',coord:first.coords[0]},end:{id:'end',name:'도착',address:'',coord:first.coords.at(-1)},candidates:frozen.routes,evidence:frozen.evidence,exclusions:[],pendingReplans:[],lookups:60,analyses:37,replans:0,phase:'running'});
}
test('actual wide and crossing-via routes admit ordinary guidance while strict visual verification stays incomplete',()=>{
    const state=actualState(),before=structuredClone(state.evidence),result=projectJourneyResult(state);
    assert.equal(result.assessments[state.candidates[0].id].admission?.kind,'available');
    assert.equal(result.assessments[state.candidates[2].id].admission?.kind,'available');
    assert.equal(result.recommendedId,null);
    assert.deepEqual(state.evidence,before);
});
test('actual shortest route with observed stairs remains blocked',()=>{
    const state=actualState(),result=projectJourneyResult(state);
    assert.equal(result.assessments[state.candidates[1].id].admission?.kind,'blocked');
});

function assessment(route:Route,evidence:Record<string,Evidence>={},blockedPassageIds:string[]=[],maxSlope?:number){
    const decision=evaluateRoute(route,evidence,blockedPassageIds,maxSlope);
    return {decision,blockedPassageIds,admission:assessRouteAdmission({route,decision,blockedPassageIds,maxSlope})};
}
function translate(value:unknown):unknown{
    if(Array.isArray(value)){
        if(value.length===2&&value.every(item=>typeof item==='number')&&value[0]>124&&value[0]<132&&value[1]>33&&value[1]<40)return [value[0]+.01,value[1]+.01];
        return value.map(translate);
    }
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,translate(item)]));
    return value;
}
test('renaming routes and consistently moving their coordinates preserves admission without any route allowlist',()=>{
    const state=journeyStateSchema.parse(translate(actualState())),ids=new Map<string,string>();
    state.candidates.forEach((route,index)=>{ids.set(route.id,'candidate-'+index);route.id='candidate-'+index;route.name='이름을 바꾼 후보 '+index;});
    state.evidence=Object.fromEntries(Object.entries(state.evidence).map(([key,item])=>{
        const previous=key.slice(0,-item.sampleId.length-1);
        return [(ids.get(previous)??previous)+':'+item.sampleId,item];
    }));
    const result=projectJourneyResult(state);
    assert.deepEqual(state.candidates.map(route=>result.assessments[route.id].admission.kind),['available','blocked','available']);
    assert.equal(result.recommendedId,null);
});
test('a nearby observed crossing never clears the separate unresolved provider hint',()=>{
    const state=actualState(),route=state.candidates[2],assessed=projectJourneyResult(state).assessments[route.id];
    const hint=route.unresolvedCrossings?.[0];assert.ok(hint);
    assert.equal(assessed.admission.kind,'available');
    assert.equal(assessed.decision.issues.find(issue=>issue.sampleId===hint.id)?.status,'unknown');
    assert.ok(assessed.decision.issues.some(issue=>issue.status==='clear'&&route.samples.some(sample=>sample.id===issue.sampleId&&(sample.target==='crossing-entry'||sample.target==='crossing-exit'))));
    assert.ok(!customerRouteIssues(route,assessed.decision.issues,state.evidence).some(issue=>issue.sampleId===hint.id));
});
for(const source of ['provider','osm'] as const)test(`${source} stairs or restrictions remain authoritative admission blockers`,()=>{
    const route=structuredClone(frozen.routes[0]);
    route.barriers=[{sampleId:'restricted',coord:route.coords[0],along:0,reason:'계단 또는 접근 제한',source}];
    const result=assessment(route);
    assert.equal(result.admission.kind,'blocked');
    assert.equal(routeGuideBlocked(result),true);
    assert.equal(routeAdmissionStatus(result).kind,'blocked');
});
test('disconnected fragments and shared blocked passages cannot be admitted',()=>{
    const route=structuredClone(frozen.routes[0]);
    const shared=assessment(route,{},['shared-obstacle']);
    assert.equal(shared.admission.kind,'blocked');
    assert.equal(routeGuideBlocked(shared),true);
    route.graphSegment={provider:'openstreetmap',snapshotAt:'2026-10-26T21:24:46Z',startGapMeters:10,endGapMeters:20,sharedRoadMeters:100};
    const fragment=assessment(route);
    assert.deepEqual(fragment.admission,{kind:'blocked',cause:'disconnected',reason:'출발지와 도착지까지 이어지는 전체 이동 경로가 아닙니다.'});
    assert.equal(routeGuideBlocked(fragment),true);
    const empty=assessment({...route,graphSegment:undefined,coords:[]});
    assert.equal(empty.admission.kind,'blocked');
});
for(const kind of ['underpass','elevator','station'] as const)test(`unresolved ${kind} access requires a structural check instead of an ordinary photo warning`,()=>{
    const route=structuredClone(frozen.routes[0]);
    route.unverifiedConnections=[{id:'structure',kind,coord:route.coords[0],along:0,reason:'시설 내부 연결을 확인해야 합니다.'}];
    const result=assessment(route);
    assert.equal(result.admission.kind,'requires-check');
    assert.equal(routeAdmissionStatus(result).label,'시설 연결 확인 필요');
    assert.equal(routeGuideBlocked(result),true);
    assert.equal(result.decision.issues.find(issue=>issue.sampleId==='structure')?.status,'unknown');
});
test('an explicit numeric slope constraint remains unmet by terrain estimates',()=>{
    const route=structuredClone(frozen.routes[0]),result=assessment(route,{},[],8);
    assert.equal(result.admission.kind,'requires-check');
    assert.equal(routeAdmissionStatus(result).label,'요청한 경사 기준 미확인');
    assert.equal(routeGuideBlocked(result),true);
    assert.match(result.admission.reason,/8%/);
});
test('unavailable corroborating pedestrian graph data leaves a full provider route available',()=>{
    const route={...frozen.routes[0],graphCoverage:{status:'unavailable',reason:'network'} satisfies NonNullable<Route['graphCoverage']>};
    assert.equal(assessment(route).admission.kind,'available');
    assert.equal(assessment(route).decision.kind,'hold');
});
for(const stage of ['missing','pending','occluded','service-error'] as const)test(`ordinary ${stage} photographs remain distinct from available route admission`,()=>{
    const route=frozen.routes[0],sample=route.samples[0],evidence:Record<string,Evidence>={};
    const finding:Finding={status:'unknown',reason:'연결부가 가려져 있습니다.',pathVisible:false,routeMatch:'same-path',visibility:'occluded',reviewReason:'occlusion',evidence:[],limitations:[],observation:{connection:'unobservable',surface:'unobservable',uncertainty:'occlusion',target:sample.target??'sidewalk',reason:'같은 연결부의 가림'}};
    if(stage!=='missing')evidence[route.id+':'+sample.id]={sampleId:sample.id,stage:stage==='pending'?'reserved':'processed',status:'unknown',reason:finding.reason,checkedAt:'',...(stage==='occluded'?{finding,source:{url:'https://map.naver.com/',capturedAt:null,coord:sample.coord,distance:0}}:{}),...(stage==='service-error'?{failure:'service'}:{})};
    const before=structuredClone(evidence),result=assessment(route,evidence),photo=routeAnalysisStatus({route,decision:result.decision,evidence,phase:'running'});
    assert.equal(result.admission.kind,'available');
    assert.equal(routeAdmissionStatus(result).label,'길안내 가능');
    assert.equal(routeGuideBlocked(result),false);
    assert.notEqual(photo.kind,'recommended');
    if(stage==='pending')assert.equal(photo.kind,'analyzing');
    if(stage==='service-error')assert.equal(photo.kind,'error');
    if(stage==='occluded')assert.equal(photo.label,'사진 일부 미확인');
    assert.deepEqual(evidence,before);
});
test('fresh projection supplies admission for old persisted state while missing live metadata fails closed',()=>{
    const state=actualState(),result=journeyResponse.parse(projectJourneyResult(state)),route=state.candidates[0],stale=structuredClone(result.assessments[route.id]);
    Reflect.deleteProperty(stale,'admission');
    assert.equal(routeGuideBlocked(stale),true);
    assert.equal(routeAdmissionStatus(stale).kind,'pending');
    assert.equal(routeGuideBlocked(undefined),true);
    assert.equal(journeyResponse.safeParse({...result,assessments:{[route.id]:stale}}).success,false);
    assert.equal(result.assessments[route.id].admission.kind,'available');
    assert.equal(state.version,JOURNEY_VERSION);
});
test('available admission does not end uncapped capture or review scheduling',async()=>{
    const state=actualState(),route=state.candidates[0];
    state.candidates=[route];state.evidence={};state.lookups=60;state.analyses=48;
    assert.equal(projectJourneyResult(state).assessments[route.id].admission.kind,'available');
    const operation=reserveJourneyOperation(state);assert.ok(operation?.kind==='capture');
    const target=operation.sample;
    const finding:Finding={status:'unknown',reason:'연결부가 가려져 있습니다.',pathVisible:false,routeMatch:'same-path',visibility:'occluded',reviewReason:'occlusion',evidence:[],limitations:[],observation:{connection:'unobservable',surface:'unobservable',uncertainty:'occlusion',target:target.target??'sidewalk',reason:'가림 관찰'}};
    await advanceJourneyState(state,operation,{routing:{kind:'kakao',restKey:'test'},ai:'test',model:'gemini-test',mapillary:'',rendererToken:'test'},new AbortController().signal,{
        streetImage:async sample=>({image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{url:'https://map.kakao.com/?panoid=fixture',panoId:'fixture',capturedAt:null,coord:sample.coord,heading:sample.heading}}),
        analyzeKhuImage:async()=>({model:'gemini-test',finding,checkedAt:'',usage:{input:0,output:0}}),
        analyzeKhuViews:async()=>{throw new Error('not reached');},reroute:async()=>{throw new Error('not reached');},
    });
    const review=reserveJourneyOperation(state);assert.ok(review?.kind==='review');
    assert.equal(state.phase,'running');assert.ok(state.lookups>60&&state.analyses>48);
    assert.equal(projectJourneyResult(state).assessments[route.id].admission.kind,'available');
    assert.equal(projectJourneyResult(state).recommendedId,null);
});
