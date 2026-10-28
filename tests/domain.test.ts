import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluateRoute,hasOnlyProviderBarriers,meters,projectOnRoute,recommendedRoute,samplesFor,summary,rankRoutes,validateFinding,type Route,type Evidence,type Finding} from '../lib/domain.ts';
const a:[number,number]=[127,37],b:[number,number]=[127,37.01];
const route:Route={id:'r',name:'r',options:[],coords:[a,b],distance:1112,seconds:0,steps:[],samples:samplesFor([a,b]),fetchedAt:''};
function observedFinding(overrides:Partial<Finding>={}):Finding {
    return {status:'clear',reason:'The intended connection and continuous surface are visible.',pathVisible:true,routeMatch:'same-path',visibility:'visible',reviewReason:'none',evidence:['The connection is directly visible.'],limitations:[],observation:{connection:'flush',surface:'continuous',uncertainty:'none',target:'sidewalk',reason:'The target joins the same walking surface.'},...overrides};
}
function observedEvidence(candidate:Route=route,finding:Finding=observedFinding()):Record<string,Evidence> {
    return Object.fromEntries(candidate.samples.map(sample=>[candidate.id+':'+sample.id,{
        sampleId:sample.id,stage:'processed',status:finding.status,reason:finding.reason,finding,
        source:{url:'https://map.kakao.com/?panoid='+sample.id,panoId:sample.id,capturedAt:Date.now(),coord:sample.coord,heading:sample.heading,distance:0},checkedAt:'',
    } satisfies Evidence]));
}
test('long segments get interpolated inspection points, including arrival',()=>{assert.ok(route.samples.length>20);assert.deepEqual(route.samples.at(-1)?.coord,b);for(let i=1;i<route.samples.length;i++)assert.ok(meters(route.samples[i-1].coord,route.samples[i].coord)<=51);});
test('empty coverage never becomes a clear route',()=>{const s=summary(route,{});assert.equal(s.unknown,s.total);assert.equal(s.clear,0);});
test('invisible path overrides a model clear verdict',()=>{assert.equal(validateFinding({status:'clear',reason:'r',pathVisible:false,evidence:[],limitations:[]}).status,'unknown');});
test('reject malformed model output',()=>{assert.throws(()=>validateFinding({status:'clear',reason:'ok'}));});
test('a blocked route ranks behind a nonblocked route even if shorter',()=>{const r2={...route,id:'r2',distance:2000};const e:Evidence={sampleId:route.samples[0].id,status:'blocked',reason:'stairs',checkedAt:''};assert.equal(rankRoutes([route,r2],{'r:s0':e})[0].id,'r2');});
test('critical points between samples are retained',()=>{const point:[number,number]=[127,37.000225];const s=samplesFor([a,b],[point]);assert.ok(s.some(v=>v.critical&&meters(v.coord,point)<1));});
test('critical steps project onto their actual segment with the correct distance and heading',()=>{
    const corner:[number,number]=[127,37.001], end:[number,number]=[127.001,37.001];
    const step:[number,number]=[127.0004,37.00105];
    const projection=projectOnRoute([a,corner,end],step);
    assert.ok(projection);
    assert.ok(Math.abs(projection.along-(meters(a,corner)+meters(corner,[step[0],corner[1]])))<0.1);
    assert.ok(Math.abs(projection.heading-90)<0.1);
    assert.ok(projection.distance>5&&projection.distance<6);
    assert.equal(projection.segmentIndex,1);
    const samples=samplesFor([a,corner,end],[step]);
    const critical=samples.find(s=>s.critical&&meters(s.coord,projection.coord)<0.1);
    assert.ok(critical);
    assert.equal(critical.along,projection.along);
    assert.equal(critical.heading,projection.heading);
});
test('remote critical coordinates cannot move the inspection off the route',()=>{
    const samples=samplesFor([a,b],[[127.01,37.005]]);
    assert.deepEqual(samples,samplesFor([a,b]));
    assert.equal(projectOnRoute([],a),null);
    assert.equal(projectOnRoute([a,a],b),null);
    assert.throws(()=>samplesFor([a,b],[],0),RangeError);
});
test('only visible same-path findings retain a clear or blocked verdict',()=>{
    for(const status of ['clear','blocked','caution']) {
        const raw={status,reason:'observed',evidence:[],limitations:[],pathVisible:true};
        assert.equal(validateFinding(raw).routeMatch,'uncertain');
        assert.equal(validateFinding(raw).status,'unknown');
        for(const routeMatch of ['uncertain','different-path']) assert.equal(validateFinding({...raw,routeMatch}).status,'unknown');
        assert.equal(validateFinding({...raw,routeMatch:'same-path'}).status,status);
        assert.equal(validateFinding({...raw,routeMatch:'same-path',pathVisible:false}).status,'unknown');
        assert.throws(()=>validateFinding({...raw,routeMatch:'guessed'}));
    }
});
test('a blocked finding for a different connection remains unknown',()=>{
 const sample={...route.samples[0],target:'crossing-entry' as const},candidate={...route,samples:[sample]};
 const finding=observedFinding({status:'blocked',reason:'다른 횡단보도의 계단',observation:{connection:'stairs',surface:'continuous',uncertainty:'none',target:'crossing-exit',reason:'반대편 계단'}});
 const decision=evaluateRoute(candidate,observedEvidence(candidate,finding));
 assert.equal(decision.kind,'hold');
 assert.equal(decision.issues[0].status,'unknown');
 assert.equal(decision.issues.some(issue=>issue.status==='blocked'),false);
});
test('capture age or missing date alone does not discard a visible observation',()=>{
 for(const capturedAt of [Date.now()-400*86400000,null]){
  const sample=route.samples[0],candidate={...route,samples:[sample]};
  const evidence=observedEvidence(candidate),item=evidence[candidate.id+':'+sample.id];
  assert.ok(item.source);item.source.capturedAt=capturedAt;
  assert.equal(evaluateRoute(candidate,evidence).issues[0].status,'clear');
 }
});
test('unavailable pedestrian map cannot become a recommended route from photos alone',()=>{
 const candidate:Route={...route,graphCoverage:{status:'unavailable',reason:'network'}};
 const decision=evaluateRoute(candidate,observedEvidence(candidate));
 assert.equal(decision.kind,'hold');
 assert.equal(decision.issues.some(issue=>issue.status==='blocked'),false);
 assert.equal(recommendedRoute([candidate],observedEvidence(candidate)),null);
});
test('an unobserved ordinary stretch becomes an explicit conditional candidate after critical points are observed',()=>{
 const first={...route.samples[0],critical:true},second={...route.samples[1],critical:false};
 const candidate={...route,samples:[first,second]},evidence=observedEvidence({...candidate,samples:[first]});
 const decision=evaluateRoute(candidate,evidence);
 assert.equal(decision.kind,'conditional');
 assert.equal(decision.issues.find(issue=>issue.sampleId===second.id)?.status,'unknown');
 assert.equal(recommendedRoute([candidate],evidence),null);
});
test('an unobserved critical crossing cannot become a conditional route',()=>{
 const first={...route.samples[0],critical:true,target:'crossing-entry' as const},second={...route.samples[1],critical:false};
 const candidate={...route,samples:[first,second]},evidence=observedEvidence({...candidate,samples:[second]});
 assert.equal(evaluateRoute(candidate,evidence).kind,'hold');
});
test('street imagery cannot resolve an independently unverified underpass',()=>{
 const candidate:Route={...route,unverifiedConnections:[{id:'underpass',kind:'underpass',coord:route.samples[0].coord,along:0,reason:'지하보도 연결 미확인'}]};
 const decision=evaluateRoute(candidate,observedEvidence(candidate));
 assert.equal(decision.kind,'hold');
 assert.equal(decision.issues.find(issue=>issue.sampleId==='underpass')?.status,'unknown');
});
test('a partial map segment never becomes an accessible route even with clear observations',()=>{
 const candidate:Route={...route,graphSegment:{provider:'openstreetmap',snapshotAt:'2026-10-27T07:31:56Z',startGapMeters:14,endGapMeters:56,sharedRoadMeters:859}};
 const evidence=observedEvidence(candidate);
 assert.equal(evaluateRoute(candidate,evidence).kind,'hold');
 assert.equal(recommendedRoute([candidate],evidence),null);
});
test('shared blocked passages prevent recommendation despite complete observable coverage',()=>{
    const evidence=observedEvidence();
    assert.equal(recommendedRoute([route],evidence,{r:{blockedPassageIds:[]}}),'r');
    assert.equal(recommendedRoute([route],evidence,{r:{blockedPassageIds:['other-route:stairs']}}),null);
    assert.equal(recommendedRoute([route],evidence,{}),null);
});

test('structured features belong only to an observable same path',()=>{
    const features={stairs:{state:'present',reason:'사진에 계단이 보임'},incline:{state:'not-observed',reason:'사진에 경사가 보이지 않음'}};
    const raw={status:'blocked',reason:'observed',evidence:[],limitations:[],pathVisible:true,routeMatch:'same-path',features};
    assert.deepEqual(validateFinding(raw).features,features);
    for(const change of [{routeMatch:'different-path'},{routeMatch:'uncertain'},{pathVisible:false}]){
        const result=validateFinding({...raw,...change});
        assert.equal(result.status,'unknown');
        assert.equal(result.features?.stairs.state,'unobservable');
        assert.equal(result.features?.incline.state,'unobservable');
    }
    assert.throws(()=>validateFinding({...raw,features:{...features,stairs:{state:'present',reason:'x'.repeat(1001)}}}));
});
test('old findings remain readable without inventing structured observations',()=>{
    const result=validateFinding({status:'clear',reason:'계단 없음, 경사 없음',evidence:[],limitations:[],pathVisible:true,routeMatch:'same-path'});
    assert.equal(result.features,undefined);
});
test('reserved evidence does not count as checked or clear coverage',()=>{
    const evidence:Record<string,Evidence>=Object.fromEntries(route.samples.map(sample=>['r:'+sample.id,{sampleId:sample.id,stage:'reserved',status:'clear',reason:'pending',checkedAt:''}]));
    assert.equal(summary(route,evidence).checked,0);
    assert.equal(summary(route,evidence).clear,0);
    assert.equal(summary(route,evidence).unknown,route.samples.length);
    assert.equal(recommendedRoute([route],evidence),null);
});

test('an ordinary visible ramp may be recommended even when an incline feature is present',()=>{
    const finding=validateFinding(observedFinding({
        observation:{connection:'ramp',surface:'continuous',uncertainty:'none',target:'sidewalk',reason:'Both ramp ends visibly join the intended surface.'},
        features:{stairs:{state:'not-observed',reason:'No stairs observed.'},incline:{state:'present',reason:'A connecting ramp is visible.'}},
    }));
    assert.equal(finding.status,'clear');
    const evidence=observedEvidence(route,finding);
    assert.equal(evaluateRoute(route,evidence).kind,'recommended');
    assert.equal(recommendedRoute([route],evidence),'r');
});
test('visible stairs or a raised connection require a detour despite a model clear label',()=>{
    for(const connection of ['stairs','raised'] as const){
        const finding=observedFinding({observation:{connection,surface:'continuous',uncertainty:'none',target:'sidewalk',reason:'A physical obstacle is directly visible.'}});
        const decision=evaluateRoute(route,observedEvidence(route,finding));
        assert.equal(decision.kind,'detour');
        assert.ok(decision.issues.every(issue=>issue.status==='blocked'&&issue.source==='imagery'));
        assert.equal(recommendedRoute([route],observedEvidence(route,finding)),null);
    }
    const stairs=validateFinding(observedFinding({features:{stairs:{state:'present',reason:'Visible stairs.'},incline:{state:'not-observed',reason:'No incline observed.'}}}));
    assert.equal(stairs.status,'blocked');
});
test('unresolved crossing and entrance connections remain on hold rather than conditional',()=>{
    for(const target of ['crossing-entry','crossing-exit','entrance'] as const){
        const candidate:Route={...route,samples:[{...route.samples[0],critical:true,target}]};
        for(const uncertainty of ['framing','occlusion','corridor'] as const){
            const finding=observedFinding({status:'caution',observation:{connection:'unobservable',surface:'continuous',uncertainty,target,reason:'The required connection cannot be seen.'}});
            const decision=evaluateRoute(candidate,observedEvidence(candidate,finding));
            assert.equal(decision.kind,'hold');
            assert.equal(decision.issues[0].status,'unknown');
            assert.equal(recommendedRoute([candidate],observedEvidence(candidate,finding)),null);
        }
    }
});
test('clear evidence must observe the required target instead of a neighboring surface',()=>{
    for(const target of ['crossing-entry','crossing-exit','entrance'] as const){
        const candidate:Route={...route,samples:[{...route.samples[0],target,critical:true}]};
        const wrongTarget=observedEvidence(candidate);
        assert.equal(evaluateRoute(candidate,wrongTarget).kind,'hold');
        const matching=observedFinding({observation:{connection:'ramp',surface:'continuous',uncertainty:'none',target,reason:'The intended target connection is directly visible.'}});
        assert.equal(evaluateRoute(candidate,observedEvidence(candidate,matching)).kind,'recommended');
    }
});
test('mandatory crossing and entrance connections cannot be dismissed as not applicable',()=>{
    for(const target of ['crossing-entry','crossing-exit','entrance'] as const){
        const candidate:Route={...route,samples:[{...route.samples[0],target,critical:true}]};
        const finding=observedFinding({observation:{connection:'not-applicable',surface:'continuous',uncertainty:'none',target,reason:'Nearby paving is visible but no target connection is established.'}});
        const evidence=observedEvidence(candidate,finding);
        assert.equal(evaluateRoute(candidate,evidence).kind,'hold');
        assert.equal(evaluateRoute(candidate,evidence).issues[0].status,'unknown');
        assert.equal(recommendedRoute([candidate],evidence),null);
    }
});
test('an outdoor arrival without a separate connection may recommend but building entry cannot',()=>{
    for(const target of ['arrival','entrance'] as const){
        const candidate:Route={...route,samples:[{...route.samples[route.samples.length-1],target,critical:true}]};
        const finding=observedFinding({observation:{connection:'not-applicable',surface:'continuous',uncertainty:'none',target,reason:'The destination is on the visible continuous outdoor walkway; no building threshold was observed.'}});
        const evidence=observedEvidence(candidate,finding);
        const decision=evaluateRoute(candidate,evidence);
        assert.equal(decision.kind,target==='arrival'?'recommended':'hold');
        assert.equal(decision.issues[0].status,target==='arrival'?'clear':'unknown');
        assert.equal(recommendedRoute([candidate],evidence),target==='arrival'?'r':null);
    }
});
test('unlocated crossing connections prevent recommendation even when every sampled target is clear',()=>{
    const candidate:Route={...route,unresolvedCrossings:[{id:'grouped-crossing',coord:route.samples[0].coord,along:0,count:2}]};
    const evidence=observedEvidence(candidate);
    assert.equal(evaluateRoute(route,evidence).kind,'recommended');
    const decision=evaluateRoute(candidate,evidence);
    assert.equal(decision.kind,'hold');
    assert.equal(recommendedRoute([candidate],evidence),null);
    assert.equal(decision.issues.filter(issue=>issue.status==='clear').length,candidate.samples.length);
    assert.deepEqual(decision.issues.filter(issue=>issue.status!=='clear').map(issue=>({sampleId:issue.sampleId,status:issue.status,source:issue.source})),[{sampleId:'grouped-crossing',status:'unknown',source:'provider'}]);
});
test('legacy clear counts without a finding, source, or structured observation cannot recommend',()=>{
    for(const missing of ['finding','source','observation'] as const){
        const evidence=observedEvidence();
        const item=evidence['r:s0'];
        if(missing==='observation'&&item.finding)delete item.finding.observation;
        else if(missing==='finding')delete item.finding;
        else if(missing==='source')delete item.source;
        assert.equal(evaluateRoute(route,evidence).issues[0].status,'unknown');
        assert.equal(recommendedRoute([route],evidence),null);
    }
});
test('capture and analysis failures are unknown service issues, not physical obstacles',()=>{
    for(const failure of ['capture','analysis','service','missing'] as const){
        const evidence=observedEvidence();
        evidence['r:s0']={sampleId:'s0',stage:'processed',status:'unknown',failure,reason:'Processing did not produce an observation.',checkedAt:''};
        const decision=evaluateRoute(route,evidence);
        assert.notEqual(decision.kind,'recommended');
        assert.equal(decision.issues[0].status,'unknown');
        assert.equal(decision.issues[0].source,failure==='missing'?'coverage':'service');
        assert.equal(decision.issues.some(issue=>issue.status==='blocked'),false);
    }
});
test('known rough surfaces are conditional, not a recommendation or an unverified connection',()=>{
    for(const surface of ['uneven','unpaved'] as const){
        const finding=observedFinding({observation:{connection:'flush',surface,uncertainty:'none',target:'sidewalk',reason:'The entire connection is visible but its surface is rough.'}});
        const evidence=observedEvidence(route,finding);
        assert.equal(evaluateRoute(route,evidence).kind,'conditional');
        assert.equal(recommendedRoute([route],evidence),null);
    }
});
test('provider stairs require a detour without fabricating a visual finding',()=>{
    const sample=route.samples[0];
    const candidate:Route={...route,barriers:[{sampleId:sample.id,coord:sample.coord,along:sample.along,reason:'Provider instruction requires stairs.'}]};
    const decision=evaluateRoute(candidate,{});
    assert.equal(decision.kind,'detour');
    assert.equal(decision.issues[0].source,'provider');
    assert.equal(decision.issues[0].status,'blocked');
    assert.equal(hasOnlyProviderBarriers(decision),true);
});
test('provider guidance never replaces a directly observed obstacle or becomes a visual finding by itself',()=>{
    const sample=route.samples[0],candidate:Route={...route,samples:[sample],barriers:[{sampleId:sample.id,coord:sample.coord,along:sample.along,reason:'Provider instruction requires stairs.'}]};
    const clearEvidence=observedEvidence(candidate),clearDecision=evaluateRoute(candidate,clearEvidence);
    assert.equal(clearDecision.kind,'detour');
    assert.equal(clearDecision.issues[0].source,'provider');
    assert.equal(hasOnlyProviderBarriers(clearDecision),true);
    assert.equal(clearEvidence['r:'+sample.id].finding?.status,'clear');
    const stairs=observedFinding({status:'blocked',observation:{connection:'stairs',surface:'continuous',uncertainty:'none',target:'sidewalk',reason:'Stairs are directly visible on the same intended path.'}});
    const observed=evaluateRoute(candidate,observedEvidence(candidate,stairs));
    assert.equal(observed.kind,'detour');
    assert.equal(observed.issues[0].source,'imagery');
    assert.equal(hasOnlyProviderBarriers(observed),false);
});
test('observable imagery does not establish a requested numeric slope limit',()=>{
    const evidence=observedEvidence();
    assert.equal(evaluateRoute(route,evidence,[],5).kind,'hold');
    assert.equal(recommendedRoute([route],evidence,undefined,5),null);
    assert.equal(evaluateRoute(route,evidence,[],null).kind,'recommended');
});
test('route evaluation does not mutate routes, evidence, findings, or exclusions',()=>{
    const candidate=structuredClone(route),finding=observedFinding({observation:{connection:'stairs',surface:'continuous',uncertainty:'none',target:'sidewalk',reason:'Stairs are directly visible on the intended path.'}});
    const evidence=observedEvidence(candidate,finding),passages=['shared-obstacle'];
    const before=structuredClone({candidate,evidence,passages});
    function freeze(value:unknown):void {
        if(value&&typeof value==='object'){
            for(const child of Object.values(value))freeze(child);
            Object.freeze(value);
        }
    }
    freeze(candidate);freeze(evidence);freeze(passages);
    const first=evaluateRoute(candidate,evidence,passages);
    assert.equal(first.kind,'detour');
    assert.deepEqual(evaluateRoute(candidate,evidence,passages),first);
    assert.deepEqual({candidate,evidence,passages},before);
});
test('a model warning without a persistent physical burden is neither a recommendation nor an obstacle',()=>{
 for(const status of ['caution','blocked'] as const){
  const finding=observedFinding({status,reason:'A parked vehicle was present in the old image.'});
  const decision=evaluateRoute(route,observedEvidence(route,finding));
  assert.equal(decision.kind,'hold');
  assert.ok(decision.issues.every(issue=>issue.status==='unknown'));
  assert.equal(recommendedRoute([route],observedEvidence(route,finding)),null);
 }
});
