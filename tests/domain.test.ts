import {test} from 'node:test';
import assert from 'node:assert/strict';
import {meters,projectOnRoute,recommendedRoute,samplesFor,summary,rankRoutes,validateFinding,type Route,type Evidence} from '../lib/domain.ts';
const a:[number,number]=[127,37],b:[number,number]=[127,37.01];
const route:Route={id:'r',name:'r',options:[],coords:[a,b],distance:1112,seconds:0,steps:[],samples:samplesFor([a,b]),fetchedAt:''};
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
test('caution and shared blocked passages prevent recommendation despite complete coverage',()=>{
    const evidence:Record<string,Evidence>=Object.fromEntries(route.samples.map(sample=>['r:'+sample.id,{sampleId:sample.id,status:'clear',reason:'observed',checkedAt:''}]));
    assert.equal(recommendedRoute([route],evidence,{r:{blockedPassageIds:[]}}),'r');
    assert.equal(recommendedRoute([route],evidence,{r:{blockedPassageIds:['other-route:stairs']}}),null);
    assert.equal(recommendedRoute([route],evidence,{}),null);
    evidence['r:s0'].status='caution';
    assert.equal(recommendedRoute([route],evidence),null);
});

test('structured features belong only to an observable same path',()=>{
    const features={stairs:{state:'present',reason:'사진에 계단이 보임'},incline:{state:'not-observed',reason:'사진에 경사가 보이지 않음'}};
    const raw={status:'blocked',reason:'observed',evidence:[],limitations:[],pathVisible:true,routeMatch:'same-path',features};
    assert.deepEqual(validateFinding(raw).features,features);
    for(const change of [{routeMatch:'different-path'},{routeMatch:'uncertain'},{pathVisible:false},{status:'unknown'}]){
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
