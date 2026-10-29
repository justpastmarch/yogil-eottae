import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {setImmediate} from 'node:timers/promises';
import {Miniflare} from 'miniflare';
import {JourneyJobStore,JourneyJobError,readJourney,advanceJourney,cancelJourney,executeJourneyBatch} from '../lib/journey-jobs.ts';
import {JOURNEY_VERSION,reserveJourneyOperation,advanceJourneyState,projectJourneyResult,journeyStateSchema,type JourneyState,type JourneyDependencies} from '../lib/journey.ts';
import {samplesFor,summary,type Finding,type Route,type Sample} from '../lib/domain.ts';
import {streetImage,ImageryServiceError,type StreetImage} from '../lib/street-imagery.ts';
import {runWithServerEnv,type ServerConfig} from '../lib/server-config.ts';
import type {JointFinding} from '../lib/khu.ts';
import {saveJourneyCapture} from '../lib/journey-captures.ts';
import {blockedPassageFor} from '../lib/detours.ts';
import {buildPedestrianGraph} from '../lib/osm-graph.ts';
async function migrate(db:D1Database){
    const directory=new URL('../drizzle/',import.meta.url);
    for(const filename of (await readdir(directory)).filter(name=>name.endsWith('.sql')).sort()){
        const sql=await readFile(new URL(filename,directory),'utf8');
        for(const part of sql.split('--> statement-breakpoint'))await db.prepare(part).run();
    }
}
const config:ServerConfig={routing:{kind:'kakao',restKey:'test'},ai:'test',model:'gemini-test',mapillary:'',rendererToken:'test'};
function state():JourneyState{
    const coords:[number,number][]=[[127,37],[127.001,37]];
    const route:Route={id:'r',name:'r',coords,distance:89,seconds:100,options:[],steps:[],samples:samplesFor(coords),fetchedAt:''};
    return {version:JOURNEY_VERSION,provider:'kakao',goal:'arrival',start:{id:'a',name:'a',address:'',coord:coords[0]},end:{id:'b',name:'b',address:'',coord:coords[1]},profile:'수동 휠체어',candidates:[route],evidence:{},exclusions:[],pendingReplans:[],lookups:0,analyses:0,replans:0,phase:'running'};
}
function observedFinding(status:Finding['status']='clear'):JointFinding['finding']{
    return {status,reason:'Observed route surface and connection',evidence:[],limitations:[],pathVisible:true,routeMatch:'same-path',visibility:status==='unknown'?'occluded':'visible',reviewReason:status==='unknown'?'occlusion':'none',observation:{connection:status==='blocked'?'stairs':status==='unknown'?'unobservable':'flush',surface:status==='caution'?'uneven':status==='unknown'?'unobservable':'continuous',uncertainty:status==='unknown'?'occlusion':'none',target:'sidewalk',reason:'Observed the specified sidewalk connection'}};
}
function imageFor(sample:Sample):StreetImage{
    return {image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{url:'https://map.kakao.com/?panoid='+sample.id,panoId:sample.id,capturedAt:Date.now(),coord:sample.coord,heading:sample.heading}};
}
function captureDependencies(overrides:Partial<JourneyDependencies>={}):JourneyDependencies{
    return {
        streetImage:async sample=>imageFor(sample),
        analyzeKhuImage:async()=>({model:'gemini-test',finding:observedFinding(),checkedAt:'2026-10-26T00:00:00Z',usage:{input:1,output:1}}),
        analyzeKhuViews:async()=>{throw Error('unexpected joint analysis');},
        reroute:async()=>{throw Error('unexpected reroute');},
        ...overrides,
    };
}
test('a visible obstacle remains an observation even when the image is older than a year',async()=>{
 const s=state(),operation=reserveJourneyOperation(s);assert.ok(operation?.kind==='capture');
 await advanceJourneyState(s,operation,config,new AbortController().signal,captureDependencies({
  streetImage:async sample=>({...imageFor(sample),source:{...imageFor(sample).source,capturedAt:Date.now()-400*86400000}}),
  analyzeKhuImage:async()=>({model:'gemini-test',finding:observedFinding('blocked'),checkedAt:new Date().toISOString(),usage:{input:1,output:1}}),
 }));
 const item=s.evidence[operation.route.id+':'+operation.sample.id];
 assert.equal(item.finding?.status,'blocked');
 const decision=projectJourneyResult(s).assessments[operation.route.id].decision;
 assert.equal(decision.issues.find(issue=>issue.sampleId===operation.sample.id)?.status,'blocked');
 assert.ok(s.pendingReplans.length>0);
 assert.equal(reserveJourneyOperation(s)?.kind,'replan');
});
test('an opposite-facing crossing image cannot establish an entry just because the model reports clear',async()=>{
 const s=state(),sample={...s.candidates[0].samples[0],critical:true,target:'crossing-entry' as const,heading:84};
 s.candidates[0].samples=[sample];
 const operation=reserveJourneyOperation(s);assert.ok(operation?.kind==='capture');
 const base=observedFinding();
 await advanceJourneyState(s,operation,config,new AbortController().signal,captureDependencies({
  streetImage:async point=>({...imageFor(point),source:{...imageFor(point).source,heading:264}}),
  analyzeKhuImage:async()=>({model:'gemini-test',finding:{...base,observation:{...base.observation,target:'crossing-entry'}},checkedAt:new Date().toISOString(),usage:{input:1,output:1}}),
 }));
 const item=s.evidence[operation.route.id+':'+sample.id];
 assert.equal(item.status,'unknown');
 assert.equal(item.review?.reason,'framing');
 assert.equal(projectJourneyResult(s).recommendedId,null);
});
test('real D1 lease, owner isolation, expiration and cancel prevent stale commits',async()=>{
    const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-01-01',d1Databases:['DB']});
    try{
        const db=await mf.getD1Database('DB');
        await migrate(db);
        const store=new JourneyJobStore(db);
        const s=state();
        await store.insert('job','owner',s,1000);
        await assert.rejects(store.read('job','other',1001),error=>error instanceof JourneyJobError&&error.status===404);
        const lease=await store.acquire('job','owner','first',1001);
        assert.ok(lease);
        assert.equal(await store.acquire('job','owner','second',1002),null);
        const operation=reserveJourneyOperation(s);
        assert.ok(operation);
        const reserved=await store.write('job','owner',lease,s,false,1002);
        assert.ok(reserved);
        assert.equal(JSON.parse((await store.read('job','owner',1003)).state).lookups,1);
        assert.equal(summary(s.candidates[0],s.evidence).checked,0);
        await store.cancel('job','owner',1004);
        assert.equal(await store.write('job','owner',reserved,s,true,1005),null);
        const canceled=await store.read('job','owner',1005);
        assert.equal(canceled.phase,'canceled');
        assert.equal(summary(s.candidates[0],JSON.parse(canceled.state).evidence).checked,0);
        assert.equal(projectJourneyResult({...s,phase:'canceled'}).recommendedId,null);
        await assert.rejects(store.read('job','owner',1000+30*60_000));
        await store.insert('recovery','owner',state(),1000);
        const recovering=state();recovering.lookups=60;recovering.analyses=48;
        const stale=await store.acquire('recovery','owner','old',1001);
        assert.ok(stale);
        assert.ok(reserveJourneyOperation(recovering));
        const staleReserved=await store.write('recovery','owner',stale,recovering,false,1002);
        assert.ok(staleReserved);
        const replacement=await store.acquire('recovery','owner','new',stale.lease_until+1);
        assert.ok(replacement);
        const recovered=JSON.parse(replacement.state);
        const attempted=Object.values(journeyStateSchema.parse(recovered).evidence)[0];
        assert.equal(attempted.stage,'processed');
        assert.equal(attempted.status,'unknown');
        assert.equal(attempted.failure,'service');
        assert.equal(attempted.finding,undefined);
        assert.equal(summary(recovering.candidates[0],recovered.evidence).checked,1);
        const continued=reserveJourneyOperation(recovered);
        assert.equal(continued?.kind,'capture');
        assert.notEqual(continued?.kind==='capture'?continued.sample.id:null,attempted.sampleId);
        assert.equal(recovered.lookups,62);
        assert.equal(recovered.analyses,50);
        assert.equal(projectJourneyResult(recovered).recommendedId,null);
        assert.equal(await store.write('recovery','owner',stale,state(),true,stale.lease_until+2),null);
    }finally{await mf.dispose();}
});
test('expired graph-backed replan is retried once without losing its last attempt',{timeout:10_000},async t=>{
    const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-01-01',d1Databases:['DB']});
    try{
        const db=await mf.getD1Database('DB');await migrate(db);
        const store=new JourneyJobStore(db),s=state(),started=Promise.withResolvers<void>(),controller=new AbortController();
        const via:[[number,number]]=[[127.0005,37.0002]],coords:[number,number][]=[[127,37],[127.0005,37.0002],[127.001,37]];
        s.pendingReplans=[via];s.replans=3;
        await store.insert('replan','owner',s);
        t.mock.method(globalThis,'fetch',async(input:string|URL|Request,init?:RequestInit)=>{
            const url=new URL(input instanceof Request?input.url:String(input));
            if(url.origin==='https://dapi.kakao.com')return Response.json({status:'OK',route:{properties:{totalDistance:100,totalTime:100},legs:[{steps:[{properties:{x:127,y:37,guidance:'출발',distance:100,time:100},path:{points:coords}}]}]}});
            assert.equal(url.origin,'https://osm.example');
            const signal=init?.signal;assert.ok(signal);started.resolve();
            const {promise,reject}=Promise.withResolvers<Response>();
            signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
            if(signal.aborted)reject(signal.reason);
            return promise;
        });
        const env={DB:db,KAKAO_REST_API_KEY:'test',CHATKHU_API_KEY:'test',OSM_OVERPASS_URL:'https://osm.example/interpreter'};
        const stale=runWithServerEnv(env,()=>advanceJourney('replan','owner',controller.signal));
        await started.promise;
        const leased=await store.read('replan','owner');
        const replacement=await store.acquire('replan','owner','replacement',leased.lease_until+1);
        assert.ok(replacement);
        const recovered=journeyStateSchema.parse(JSON.parse(replacement.state));
        assert.deepEqual(recovered.pendingReplans,[via]);
        assert.equal(recovered.replans,3);
        controller.abort();
        await assert.rejects(stale,error=>error instanceof DOMException&&error.name==='AbortError');
        assert.equal(await store.write('replan','owner',leased,s,true,leased.lease_until+2),null);

        const operation=reserveJourneyOperation(recovered);
        assert.ok(operation?.kind==='replan');
        assert.deepEqual(operation.via,via);
        const reserved=await store.write('replan','owner',replacement,recovered,false,leased.lease_until+2,[operation.via]);
        assert.ok(reserved);
        const alternative:Route={...s.candidates[0],id:'bypass',coords,distance:100,samples:samplesFor(coords)};
        const graph=buildPedestrianGraph({osm3s:{timestamp_osm_base:'2026-01-01T00:00:00Z'},elements:[
            ...coords.map(([lon,lat],index)=>({type:'node' as const,id:index+1,lon,lat})),
            {type:'way' as const,id:1,nodes:[1,2,3],tags:{highway:'footway'}},
        ]});
        let reroutes=0,graphLoads=0;
        await executeJourneyBatch(recovered,[operation],config,new AbortController().signal,captureDependencies({
            reroute:async(_start,_end,_config,requested)=>{reroutes++;assert.deepEqual(requested,via);return alternative;},
            loadPedestrianGraph:async()=>{graphLoads++;return {kind:'available',graph};},
        }));
        assert.equal(reroutes,1);assert.equal(graphLoads,1);
        assert.equal(recovered.candidates.find(route=>route.id==='bypass')?.graphCoverage?.status,'available');
        assert.ok(await store.write('replan','owner',reserved,recovered,true,leased.lease_until+3));
        const next=await store.acquire('replan','owner','next',leased.lease_until+4);
        assert.ok(next);
        const completed=journeyStateSchema.parse(JSON.parse(next.state));
        assert.equal(completed.replans,4);
        assert.deepEqual(completed.pendingReplans,[]);
        assert.equal(completed.candidates.filter(route=>route.id==='bypass').length,1);
        assert.notEqual(reserveJourneyOperation(completed)?.kind,'replan');
    }finally{await mf.dispose();}
});
test('canceling an in-flight replan prevents recovery and stale completion',{timeout:10_000},async t=>{
    const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-01-01',d1Databases:['DB']});
    try{
        const db=await mf.getD1Database('DB');await migrate(db);
        const store=new JourneyJobStore(db),s=state(),started=Promise.withResolvers<void>(),controller=new AbortController();
        s.pendingReplans=[[[127.0005,37.0002]]];
        await store.insert('cancel-replan','owner',s);
        t.mock.method(globalThis,'fetch',async(_input:string|URL|Request,init?:RequestInit)=>{
            const signal=init?.signal;assert.ok(signal);started.resolve();
            const {promise,reject}=Promise.withResolvers<Response>();
            signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
            if(signal.aborted)reject(signal.reason);
            return promise;
        });
        const env={DB:db,KAKAO_REST_API_KEY:'test',CHATKHU_API_KEY:'test'};
        const pending=runWithServerEnv(env,()=>advanceJourney('cancel-replan','owner',controller.signal));
        await started.promise;
        const leased=await store.read('cancel-replan','owner');
        await store.cancel('cancel-replan','owner');
        controller.abort();
        await assert.rejects(pending,error=>error instanceof DOMException&&error.name==='AbortError');
        assert.equal(await store.acquire('cancel-replan','owner','replacement',leased.lease_until+1),null);
        assert.equal(await store.write('cancel-replan','owner',leased,s,true,leased.lease_until+1),null);
        assert.equal((await store.read('cancel-replan','owner')).phase,'canceled');
    }finally{await mf.dispose();}
});
test('caller cancellation cannot commit a limited result before the cancel request',{timeout:10_000},async t=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-01-01',d1Databases:['DB']});
 try{
  const db=await mf.getD1Database('DB');await migrate(db);
  const store=new JourneyJobStore(db),id='aborted-job',owner='owner',controller=new AbortController(),started=Promise.withResolvers<void>();
  await store.insert(id,owner,state());
  t.mock.method(globalThis,'fetch',async(_input:string|URL|Request,init?:RequestInit)=>{
   const signal=init?.signal;assert.ok(signal);started.resolve();
   const {promise,reject}=Promise.withResolvers<Response>();
   signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
   if(signal.aborted)reject(signal.reason);
   return promise;
  });
  const env={DB:db,KAKAO_REST_API_KEY:'test',CHATKHU_API_KEY:'test',ROADVIEW_RENDERER_URL:'https://renderer.example/capture',ROADVIEW_RENDERER_TOKEN:'test'};
  const pending=runWithServerEnv(env,()=>advanceJourney(id,owner,controller.signal));
  await started.promise;controller.abort();
  await assert.rejects(pending,error=>error instanceof DOMException&&error.name==='AbortError');
  const result=await runWithServerEnv(env,()=>cancelJourney(id,owner));
  assert.equal(result.phase,'canceled');
  assert.equal(result.journey.recommendedId,null);
 }finally{await mf.dispose();}
});
test('interrupted capture reservation stays unknown and cannot recommend a route',()=>{
    const s=state();
    const first=reserveJourneyOperation(s);
    assert.equal(first?.kind,'capture');
    assert.equal(s.lookups,1);
    assert.equal(s.analyses,1);
    assert.equal(Object.values(s.evidence)[0].stage,'reserved');
    assert.equal(summary(s.candidates[0],s.evidence).checked,0);
    const second=reserveJourneyOperation(s);
    assert.equal(second?.kind,'capture');
    assert.notEqual(second?.kind==='capture'?second.sample.id:null,first?.kind==='capture'?first.sample.id:null);
    assert.equal(s.phase,'running');
    assert.equal(projectJourneyResult(s).recommendedId,null);
});
test('renderer 429 retains real routes as limited instead of discarding them',async()=>{
    const s=state();const op=reserveJourneyOperation(s);assert.ok(op);
    await advanceJourneyState(s,op,config,new AbortController().signal,{
        analyzeKhuViews:async()=>{throw new Error('joint analysis not provided in this test');},
        streetImage:async()=>{throw new ImageryServiceError(429);},
        analyzeKhuImage:async()=>{throw new Error('unexpected AI request');},
        reroute:async()=>{throw new Error('unexpected reroute');},
    });
    assert.equal(Object.values(s.evidence)[0].stage,'processed');
    assert.equal(Object.values(s.evidence)[0].finding,undefined);
    assert.equal(s.phase,'limited');assert.equal(s.candidates.length,1);assert.equal(projectJourneyResult(s).recommendedId,null);
});
test('speculative reroute 503 preserves remaining routes and pending waypoint attempts',async()=>{
    const s=state();s.pendingReplans=[[[127,37],[127.001,37.001]],[[127,37],[127.002,37.002]]];
    const op=reserveJourneyOperation(s);assert.equal(op?.kind,'replan');assert.ok(op);
    await advanceJourneyState(s,op,config,new AbortController().signal,{
        analyzeKhuViews:async()=>{throw new Error('joint analysis not provided in this test');},
        streetImage:async()=>null,
        analyzeKhuImage:async()=>{throw new Error('unexpected AI request');},
        reroute:async()=>{throw Object.assign(new Error('upstream unavailable'),{status:503});},
    });
    assert.equal(s.phase,'running');assert.equal(s.candidates.length,1);
    assert.equal(reserveJourneyOperation(s)?.kind,'replan');
});
test('a clear result completes only after every sample has its own image finding',async()=>{
    const s=state();
    let calls=0;
    while(s.phase==='running'){
        const op=reserveJourneyOperation(s);if(!op) break;
        await advanceJourneyState(s,op,config,new AbortController().signal,{
            analyzeKhuViews:async()=>{throw new Error('joint analysis not provided in this test');},
            streetImage:async sample=>imageFor(sample),
            analyzeKhuImage:async()=>{calls++;return {model:'gemini-test',finding:observedFinding(),checkedAt:new Date().toISOString(),usage:{input:1,output:1}};},
            reroute:async()=>{throw new Error('unexpected reroute');},
        });
        if(calls<s.candidates[0].samples.length) assert.equal(projectJourneyResult(s).recommendedId,null);
    }
    assert.equal(calls,s.candidates[0].samples.length);assert.equal(s.phase,'ready');assert.equal(projectJourneyResult(s).recommendedId,'r');
});

test('a clear route with more than sixty samples completes before trying another candidate',async()=>{
    const s=state();
    const coords:[number,number][]=[[127,37],[127.04,37]];
    const first={...s.candidates[0],coords,samples:samplesFor(coords)};
    assert.ok(first.samples.length>60);
    s.candidates=[first,{...first,id:'alternative'},{...first,id:'third'}];
    let calls=0;
    while(s.phase==='running'){
        const op=reserveJourneyOperation(s);if(!op)break;
        await advanceJourneyState(s,op,config,new AbortController().signal,{
            analyzeKhuViews:async()=>{throw new Error('joint analysis not provided in this test');},
            streetImage:async sample=>imageFor(sample),
            analyzeKhuImage:async()=>{calls++;return {model:'gemini-test',finding:observedFinding(),checkedAt:new Date().toISOString(),usage:{input:1,output:1}};},
            reroute:async()=>{throw Error('unexpected reroute');},
        });
    }
    assert.equal(s.phase,'ready');
    assert.equal(projectJourneyResult(s).recommendedId,'r');
    assert.equal(calls,first.samples.length);
    assert.ok(s.lookups>60&&s.analyses>48);
    assert.equal(summary(first,s.evidence).clear,first.samples.length);
});

for(const failure of ['unknown','caution'] as const)test(`a ${failure} observation exhausts all remaining points across candidates without a global analysis cap`,async()=>{
    const s=state();
    const coords:[number,number][]=[[127,37],[127.015,37]];
    const first={...s.candidates[0],coords,samples:samplesFor(coords).map(sample=>({...sample,critical:false}))};
    const second={...first,id:'alternative',name:'alternative'};
    s.candidates=[first,second,{...first,id:'third',name:'third'}];
    assert.ok(first.samples.length+second.samples.length>48);
    let calls=0,reviews=0,captures=0;
    while(s.phase==='running'){
        const op=reserveJourneyOperation(s);if(!op)break;
        await advanceJourneyState(s,op,config,new AbortController().signal,{
            analyzeKhuViews:async({views})=>{reviews++;return {checkedAt:new Date().toISOString(),review:{finding:observedFinding(failure),views:views.map(view=>({id:view.id,sameCorridor:true,targetPatchVisible:false,observation:'target remains hidden'})),supportIds:[],originalConnectionVisible:false}};},
            streetImage:async sample=>{captures++;return imageFor(sample);},
            analyzeKhuImage:async()=>{calls++;return {model:'gemini-test',finding:observedFinding(failure),checkedAt:new Date().toISOString(),usage:{input:1,output:1}};},
            reroute:async()=>{throw Error('unexpected reroute');},
        });
    }
    assert.equal(projectJourneyResult(s).recommendedId,null);
    assert.equal(s.phase,'limited');
    const total=s.candidates.reduce((count,route)=>count+route.samples.length,0);
    assert.equal(calls,total);
    assert.equal(reviews,failure==='unknown'?total:0);
    assert.equal(s.analyses,total+reviews);
    assert.equal(s.lookups,captures);
    assert.ok(captures<=total+3*reviews);
    assert.ok(s.analyses>48&&s.lookups>60);
    assert.ok(Object.values(s.evidence).every(item=>item.stage==='processed'&&(!item.review||item.review.state==='complete')));
    assert.equal(reserveJourneyOperation(s),null);
    for(const route of s.candidates){
        const checked=summary(route,s.evidence);
        assert.equal(checked.checked,route.samples.length);
        assert.equal(route.samples.filter(sample=>s.evidence[route.id+':'+sample.id]?.status===failure).length,checked.checked);
        assert.equal(checked.clear,0);
    }
});

test('observed blocked passages still stop further capture without inventing clear findings',async()=>{
    const blocked=state();blocked.provider='tmap';
    const operation=reserveJourneyOperation(blocked);assert.ok(operation);
    await advanceJourneyState(blocked,operation,{...config,routing:{kind:'tmap',apiKey:'test'}},new AbortController().signal,captureDependencies({
        analyzeKhuImage:async()=>({model:'gemini-test',finding:observedFinding('blocked'),checkedAt:'2026-10-26T00:00:00Z',usage:{input:1,output:1}}),
    }));
    assert.equal(reserveJourneyOperation(blocked),null);
    assert.equal(projectJourneyResult(blocked).recommendedId,null);
    assert.equal(Object.keys(blocked.evidence).length,1);
});

test('native parsed observations survive persisted journey schema',async()=>{
    const {parseKhuGeminiResponse}=await import('../lib/khu.ts');
    const {journeyStateSchema}=await import('../lib/journey.ts');
    const s=state();const op=reserveJourneyOperation(s);assert.ok(op);
    const features={stairs:{state:'not-observed',reason:'사진에 계단이 보이지 않음'},incline:{state:'present',reason:'동일 통로에 경사가 보임'}};
    const parsed=parseKhuGeminiResponse({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({...observedFinding('caution'),features})}]}}]});
    await advanceJourneyState(s,op,config,new AbortController().signal,{
        analyzeKhuViews:async()=>{throw new Error('joint analysis not provided in this test');},
        streetImage:async sample=>({...imageFor(sample),source:{...imageFor(sample).source,capturedAt:null}}),
        analyzeKhuImage:async()=>({...parsed,model:'gemini-test',checkedAt:new Date().toISOString()}),
        reroute:async()=>{throw Error('unexpected reroute');},
    });
    const persisted=journeyStateSchema.parse(JSON.parse(JSON.stringify(s)));
    assert.deepEqual(Object.values(persisted.evidence)[0].finding?.features,features);
    assert.deepEqual(Object.values(persisted.evidence)[0].finding?.observation,observedFinding('caution').observation);
    assert.deepEqual(Object.values(persisted.evidence)[0].source?.coord,op.kind==='replan'?undefined:op.sample.coord);
    assert.equal(Object.values(persisted.evidence)[0].stage,'processed');
    const legacy=state();legacy.evidence['r:s0']={sampleId:'s0',status:'clear',reason:'legacy',checkedAt:''};
    const legacyResult=projectJourneyResult(journeyStateSchema.parse(legacy));
    assert.equal(legacyResult.recommendedId,null);
    assert.equal(legacyResult.assessments.r.decision?.kind,'hold');
});

test('missing images and failed capture attempts finish unknown without invented observations',async()=>{
    for(const failure of ['missing','transient','auth','aborted']){
        const s=state();const op=reserveJourneyOperation(s);assert.ok(op);
        const controller=new AbortController();
        const advance=executeJourneyBatch(s,[op],config,controller.signal,{
            analyzeKhuViews:async()=>{throw new Error('joint analysis not provided in this test');},
        streetImage:async()=>{
                if(failure==='missing') return null;
                if(failure==='aborted') controller.abort();
                throw new ImageryServiceError(failure==='auth'?401:503);
            },
            analyzeKhuImage:async()=>{throw Error('unexpected AI call');},
            reroute:async()=>{throw Error('unexpected reroute');},
        });
        await advance;
        const evidence=Object.values(s.evidence)[0];
        assert.equal(evidence.stage,'processed');
        assert.equal(evidence.status,'unknown');
        assert.equal(evidence.finding,undefined);
        assert.equal(evidence.source,undefined);
        assert.equal(projectJourneyResult(s).recommendedId,null);
    }
});

test('imagery outage stops after one attempt and preserves routes without classifying remaining points',async()=>{
 const s=state(),op=reserveJourneyOperation(s);assert.ok(op);
 await advanceJourneyState(s,op,config,new AbortController().signal,{
  streetImage:async()=>{throw new ImageryServiceError(503);},analyzeKhuImage:async()=>{throw Error('must not call AI without an image');},analyzeKhuViews:async()=>{throw Error('unexpected review');},reroute:async()=>{throw Error('unexpected reroute');},
 });
 assert.equal(s.phase,'limited');assert.equal(Object.keys(s.evidence).length,1);assert.equal(s.candidates.length,1);assert.equal(s.lookups,1);assert.equal(Object.values(s.evidence)[0].failure,'service');assert.equal(reserveJourneyOperation(s),null);assert.equal(projectJourneyResult(s).recommendedId,null);
 assert.equal(journeyStateSchema.parse(JSON.parse(JSON.stringify(s))).notice,s.notice);
});
test('noncritical missing local coverage allows subsequent locations to be inspected',async()=>{
 const s=state();s.candidates[0].samples=s.candidates[0].samples.map(sample=>({...sample,critical:false}));let calls=0;
 const deps={streetImage:async()=>{calls++;return null;},analyzeKhuImage:async()=>{throw Error('unexpected AI');},analyzeKhuViews:async()=>{throw Error('unexpected review');},reroute:async()=>{throw Error('unexpected reroute');}};
 for(let index=0;index<2;index++){const op=reserveJourneyOperation(s);assert.ok(op);await advanceJourneyState(s,op,config,new AbortController().signal,deps);}
 assert.equal(calls,2);assert.equal(Object.keys(s.evidence).length,2);assert.equal(s.phase,'running');assert.equal(s.notice,undefined);
});
test('missing imagery at a mandatory connection stays unknown without spending the obstacle reroute budget',async()=>{
 const s=state(),op=reserveJourneyOperation(s);assert.ok(op?.kind==='capture');assert.equal(op.sample.critical,true);
 await advanceJourneyState(s,op,config,new AbortController().signal,captureDependencies({streetImage:async()=>null}));
 assert.ok(s.exclusions.some(passage=>passage.reason==='unverified'));
 assert.equal(s.exclusions.some(passage=>passage.reason==='obstacle'),false);
 assert.equal(projectJourneyResult(s).assessments.r.blockedPassageIds.length,0);
 assert.deepEqual(s.pendingReplans,[]);
 assert.equal(reserveJourneyOperation(s)?.kind,'capture');
 assert.equal(s.replans,0);
 assert.equal(projectJourneyResult(s).assessments.r.decision.kind,'hold');
});
for(const obstacleFirst of [true,false])test(`a batch promotes an information gap to an obstacle without a ${obstacleFirst?'later':'earlier'} sibling downgrading shared-route protection`,async()=>{
 const s=state(),obstacle=reserveJourneyOperation(s),sibling=reserveJourneyOperation(s);
 assert.ok(obstacle?.kind==='capture'&&sibling?.kind==='capture');
 s.exclusions=[{...blockedPassageFor(obstacle.route,obstacle.sample),reason:'unverified',detail:'연결부 영상 없음'}];
 s.candidates.push({...structuredClone(obstacle.route),id:'shared'});
 await executeJourneyBatch(s,obstacleFirst?[obstacle,sibling]:[sibling,obstacle],config,new AbortController().signal,captureDependencies({
  streetImage:async sample=>({...imageFor(sample),image:{mime:'image/jpeg',data:sample.id===obstacle.sample.id?'/9j/AAAA':'/9j/BBBB'}}),
  analyzeKhuImage:async({image})=>({model:'gemini-test',finding:observedFinding(image.data==='/9j/AAAA'?'blocked':'clear'),checkedAt:new Date().toISOString(),usage:{input:1,output:1}}),
 }));
 const restored=journeyStateSchema.parse(JSON.parse(JSON.stringify(s)));
 assert.equal(restored.exclusions.length,1);
 assert.equal(restored.exclusions[0].reason,'obstacle');
 for(const id of ['r','shared']){
  const assessment=projectJourneyResult(restored).assessments[id];
  assert.equal(assessment.blockedPassageIds.length,1);
  assert.equal(assessment.decision.kind,'detour');
  assert.ok(assessment.decision.issues.some(issue=>issue.status==='blocked'&&issue.source==='imagery'));
 }
 assert.equal(restored.evidence['r:'+sibling.sample.id].finding?.status,'clear');
 assert.ok(restored.pendingReplans.length>0);
 assert.equal(reserveJourneyOperation(restored)?.kind,'replan');
});

test('concurrent independent captures preserve both findings and their source locations',{timeout:5_000},async()=>{
    const s=state(),first=reserveJourneyOperation(s),second=reserveJourneyOperation(s);
    assert.ok(first?.kind==='capture'&&second?.kind==='capture');
    const bothStarted=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
    const captured=new Set<string>();
    const pending=executeJourneyBatch(s,[first,second],config,new AbortController().signal,captureDependencies({
        streetImage:async sample=>{
            captured.add(sample.id);
            if(captured.size===2)bothStarted.resolve();
            await release.promise;
            return imageFor(sample);
        },
    }));
    await bothStarted.promise;
    assert.equal(captured.size,2);
    assert.equal(projectJourneyResult(s).recommendedId,null);
    release.resolve();
    await pending;
    for(const operation of [first,second]){
        const evidence=s.evidence[operation.route.id+':'+operation.sample.id];
        assert.equal(evidence.stage,'processed');
        assert.deepEqual(evidence.finding,observedFinding());
        assert.deepEqual(evidence.source?.coord,operation.sample.coord);
    }
    assert.equal(s.lookups,2);
    assert.equal(s.analyses,2);
    assert.equal(Object.keys(s.evidence).length,2);
    assert.ok(Object.values(s.evidence).every(evidence=>evidence.stage!=='reserved'));
});

test('a provider failure waits for and preserves its successful peer without inventing an obstacle',{timeout:5_000},async()=>{
    const s=state(),first=reserveJourneyOperation(s),second=reserveJourneyOperation(s);
    assert.ok(first?.kind==='capture'&&second?.kind==='capture');
    const bothStarted=Promise.withResolvers<void>(),fail=Promise.withResolvers<void>(),succeed=Promise.withResolvers<void>(),failureThrown=Promise.withResolvers<void>();
    let started=0,settled=false;
    const pending=executeJourneyBatch(s,[first,second],config,new AbortController().signal,captureDependencies({
        streetImage:async sample=>{
            if(++started===2)bothStarted.resolve();
            if(sample.id===first.sample.id){
                await fail.promise;
                failureThrown.resolve();
                throw new ImageryServiceError(503);
            }
            await succeed.promise;
            return imageFor(sample);
        },
    })).then(()=>{settled=true;});
    await bothStarted.promise;
    fail.resolve();
    await failureThrown.promise;
    await setImmediate();
    assert.equal(settled,false);
    succeed.resolve();
    await pending;
    const failed=s.evidence[first.route.id+':'+first.sample.id],successful=s.evidence[second.route.id+':'+second.sample.id];
    assert.equal(failed.stage,'processed');
    assert.equal(failed.status,'unknown');
    assert.equal(failed.failure,'service');
    assert.equal(failed.finding,undefined);
    assert.equal(failed.source,undefined);
    assert.deepEqual(successful.finding,observedFinding());
    assert.deepEqual(successful.source?.coord,second.sample.coord);
    assert.equal(successful.stage,'processed');
    assert.ok(Object.values(s.evidence).every(evidence=>evidence.stage!=='reserved'));
    const result=projectJourneyResult(s),decision=result.assessments.r.decision;
    assert.equal(result.recommendedId,null);
    assert.ok(decision);
    assert.equal(decision.kind,'hold');
    assert.equal(decision.issues.find(issue=>issue.sampleId===first.sample.id)?.source,'service');
    assert.equal(decision.issues.some(issue=>issue.status==='blocked'),false);
    assert.equal(result.assessments.r.blockedPassageIds.length,0);
    assert.equal(s.exclusions.filter(passage=>passage.reason==='obstacle').length,0);
});

for(const kind of ['capture','review'] as const)test(`pending ${kind} work cannot finalize while other finite samples are reserved beyond former counts`,()=>{
    const s=state();
    const operation=reserveJourneyOperation(s);assert.ok(operation?.kind==='capture');
    if(kind==='review'){
        const finding=observedFinding('unknown'),source={...imageFor(operation.sample).source,distance:0};
        s.evidence[operation.route.id+':'+operation.sample.id]={sampleId:operation.sample.id,stage:'processed',status:'unknown',reason:finding.reason,checkedAt:'2026-10-26T00:00:00Z',finding,source,review:{state:'reserved',reason:'occlusion',initialFinding:finding,initialSource:source,sources:[],supportIds:[],note:''}};
    }
    s.lookups=60;s.analyses=48;
    while(reserveJourneyOperation(s)){}
    assert.equal(Object.keys(s.evidence).length,s.candidates[0].samples.length);
    assert.equal(s.phase,'running');
    assert.equal(projectJourneyResult(s).recommendedId,null);
});

test('exhausting unreserved samples does not finalize while captures remain in flight',()=>{
    const s=state();
    while(reserveJourneyOperation(s)){}
    assert.equal(Object.keys(s.evidence).length,s.candidates[0].samples.length);
    assert.ok(Object.values(s.evidence).every(evidence=>evidence.stage==='reserved'));
    assert.equal(s.phase,'running');
    assert.equal(projectJourneyResult(s).recommendedId,null);
});

test('old-version jobs reject reads, acquisitions and cancellation even after completion',async()=>{
    const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-01-01',d1Databases:['DB']});
    try{
        const db=await mf.getD1Database('DB');
        await migrate(db);
        const store=new JourneyJobStore(db);
        for(const version of [1,2,8])for(const phase of ['running','ready','limited','failed','canceled'] as const)for(const action of ['read','acquire','cancel'] as const){
            const id=version+'-'+phase+'-'+action,s=state();s.phase=phase;
            await store.insert(id,'owner',s,1000);
            await db.prepare('UPDATE journey_jobs SET state=?,lease_token=?,lease_until=? WHERE id=?').bind(JSON.stringify({...s,version}),'old-lease',50_000,id).run();
            const attempt=action==='read'?store.read(id,'owner',1001):action==='acquire'?store.acquire(id,'owner','new-lease',1001):store.cancel(id,'owner',1001);
            await assert.rejects(attempt,error=>error instanceof JourneyJobError&&error.status===409);
            const row=await db.prepare('SELECT phase,lease_token,lease_until FROM journey_jobs WHERE id=?').bind(id).first();
            assert.ok(row);
            assert.equal(row.phase,'canceled');
            assert.equal(row.lease_token,null);
            assert.equal(row.lease_until,0);
        }
    }finally{await mf.dispose();}
});

test('a pending review executes alone and never overlaps more than two image requests',{timeout:10_000},async t=>{
    const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-01-01',d1Databases:['DB']});
    const firstPair=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
    let requests=0,active=0,peak=0;
    const rendererUrl='https://renderer.example.test/capture';
    t.mock.method(globalThis,'fetch',async(input:string|URL|Request,init?:RequestInit)=>{
        assert.equal(String(input),rendererUrl);
        requests++;active++;peak=Math.max(peak,active);
        if(requests===2)firstPair.resolve();
        await release.promise;
        active--;
        return Response.json(null);
    });
    try{
        const db=await mf.getD1Database('DB');
        await migrate(db);
        const s=state(),sample=s.candidates[0].samples[0],finding=observedFinding('unknown');
        assert.ok(finding.observation);
        finding.observation.uncertainty='framing';finding.reviewReason='framing';
        const source={...imageFor(sample).source,distance:0},key='r:'+sample.id;
        s.evidence[key]={sampleId:sample.id,stage:'processed',status:'unknown',reason:finding.reason,checkedAt:'2026-10-26T00:00:00Z',finding,source,review:{state:'pending',reason:'framing',initialFinding:finding,initialSource:source,sources:[],supportIds:[],note:''}};
        s.lookups=1;s.analyses=1;
        await new JourneyJobStore(db).insert('review-only','owner',s);
        const pending=runWithServerEnv({DB:db,KAKAO_REST_API_KEY:'test',CHATKHU_API_KEY:'test',CHATKHU_MODEL:'gemini-test',ROADVIEW_RENDERER_URL:rendererUrl,ROADVIEW_RENDERER_TOKEN:'test'},()=>advanceJourney('review-only','owner',new AbortController().signal));
        await firstPair.promise;
        assert.equal(active,2);
        release.resolve();
        const result=await pending;
        assert.equal(peak,2);
        assert.ok(requests>=2);
        assert.deepEqual(Object.keys(result.journey.evidence),[key]);
        const reviewed=result.journey.evidence[key];
        assert.equal(reviewed.review?.state,'complete');
        assert.deepEqual(reviewed.finding,finding);
        assert.deepEqual(reviewed.source,source);
        assert.equal(result.progress.analyses,1);
        assert.equal(result.journey.recommendedId,null);
    }finally{
        release.resolve();
        await mf.dispose();
    }
});
test('status exposes a screenshot before the model finishes and retains it after model failure',{timeout:10_000},async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-01-01',d1Databases:['DB']});
 const modelStarted=Promise.withResolvers<void>(),releaseModel=Promise.withResolvers<void>();
 let pending:Promise<void>|undefined;
 try{
  const db=await mf.getD1Database('DB');await migrate(db);
  const s=state(),store=new JourneyJobStore(db),id='capturing-job',owner='image-owner';
  await store.insert(id,owner,s);
  const lease=await store.acquire(id,owner,'capture-lease');assert.ok(lease);
  const operation=reserveJourneyOperation(s);assert.ok(operation?.kind==='capture');
  const reserved=await store.write(id,owner,lease,s,false);assert.ok(reserved?.lease_token);
  const token=reserved.lease_token;
  pending=executeJourneyBatch(s,[operation],config,new AbortController().signal,captureDependencies({
   analyzeKhuImage:async()=>{modelStarted.resolve();await releaseModel.promise;throw new Error('External model failed after receiving the image.');},
  }),async view=>{const capture=await saveJourneyCapture(db,{jobId:id,ownerId:owner,lease:{revision:reserved.revision,token},view});assert.ok(capture);});
  await modelStarted.promise;
  const status=await runWithServerEnv({DB:db},()=>readJourney(id,owner));
  assert.equal(status.phase,'running');assert.equal(status.progress.checked,0);
  assert.equal(status.journey.evidence['r:'+operation.sample.id].stage,'reserved');
  assert.deepEqual(status.captures.map(capture=>({evidenceId:capture.evidenceId,viewId:capture.viewId,coord:capture.source.coord})),[{evidenceId:'r:'+operation.sample.id,viewId:'initial',coord:operation.sample.coord}]);
  const saved=status.captures[0];
  await assert.rejects(runWithServerEnv({DB:db},()=>readJourney(id,'different-owner')),error=>error instanceof JourneyJobError&&error.status===404);
  releaseModel.resolve();await pending;
  await store.write(id,owner,reserved,s,true);
  const failed=await runWithServerEnv({DB:db},()=>readJourney(id,owner));
  assert.equal(failed.phase,'limited');assert.equal(failed.journey.evidence['r:'+operation.sample.id].failure,'analysis');
  assert.deepEqual(failed.captures,[saved]);
  assert.equal(failed.journey.assessments.r.decision.exploration.state,'interrupted');
  assert.equal(failed.journey.recommendedId,null);
 }finally{releaseModel.resolve();await pending;await mf.dispose();}
});
test('exploration reports completion and interruption without changing the route decision',()=>{
 const s=state();s.replans=3;
 s.candidates.push({...s.candidates[0],id:'detour',detourReason:'A provider-returned bypass.'});
 for(const [phase,expected] of [['running','searching'],['limited','finished'],['canceled','interrupted'],['failed','interrupted']] satisfies [JourneyState['phase'],'searching'|'finished'|'interrupted'][]){
  s.phase=phase;
  const decision=projectJourneyResult(s).assessments.r.decision;
  assert.equal(decision.kind,'hold');
  assert.deepEqual({state:decision.exploration.state,attempts:decision.exploration.attempts,alternatives:decision.exploration.alternatives},{state:expected,attempts:3,alternatives:1});
  assert.doesNotMatch(decision.exploration.reason,/우회.*조회|채택|후보.*\d|[0-9]+회/);
  assert.doesNotMatch(decision.action,/우회.*조회|채택|후보.*\d|[0-9]+회/);
 }
});
test('a shared physical obstacle has a positioned explanation without duplicate markers',()=>{
 const s=state(),route=s.candidates[0],sample=route.samples[1];
 const barrier={sampleId:'provider-stairs',coord:sample.coord,along:sample.along,reason:'Provider stair instruction.'};
 route.barriers=[barrier];
 const other={...route,id:'other'},inherited={...route,id:'inherited',barriers:[]};s.candidates.push(other,inherited);
 const stairSample={...sample,id:barrier.sampleId};
 s.exclusions=[route,other].map(candidate=>({...blockedPassageFor(candidate,stairSample),reason:'obstacle',detail:barrier.reason}));
 const journey=projectJourneyResult(s);
 for(const candidate of s.candidates){
  const issues=journey.assessments[candidate.id].decision.issues.filter(issue=>issue.status==='blocked');
  assert.equal(issues.length,1);assert.equal(issues[0].source,'provider');
  assert.ok(Math.abs(issues[0].along-sample.along)<1);
  assert.equal(journey.assessments[candidate.id].decision.kind,'detour');
 }
});
test('a map-provided staircase gets an image observation even though its route cannot be recommended',()=>{
 const s=state(),route=s.candidates[0],sample=route.samples[1];
 route.barriers=[{sampleId:'provider-stairs',coord:sample.coord,along:sample.along,reason:'Provider stairs.'}];
 s.exclusions=[{...blockedPassageFor(route,sample),reason:'obstacle'}];
 const operation=reserveJourneyOperation(s);
 assert.equal(projectJourneyResult(s).assessments.r.decision.kind,'detour');
 assert.ok(operation?.kind==='capture');assert.deepEqual(operation.sample.coord,sample.coord);
 assert.equal(operation.sample.id,'provider-stairs');
});

test('a persisted Google choice reports missing imagery instead of using the configured renderer',async t=>{
 const original=state();original.imageryProvider='google';
 const s=journeyStateSchema.parse(JSON.parse(JSON.stringify(original))),op=reserveJourneyOperation(s);assert.ok(op?.kind==='capture');
 t.mock.method(globalThis,'fetch',async(input:string|URL|Request)=>{
  assert.equal(new URL(String(input)).hostname,'maps.googleapis.com');
  return Response.json({status:'ZERO_RESULTS'});
 });
 await advanceJourneyState(s,op,{...config,rendererUrl:'https://renderer.example/capture',googleStreetViewKey:'test'},new AbortController().signal,{
  streetImage,analyzeKhuImage:async()=>{throw Error('unexpected AI');},analyzeKhuViews:async()=>{throw Error('unexpected review');},reroute:async()=>{throw Error('unexpected reroute');},
 });
 assert.equal(s.evidence[op.route.id+':'+op.sample.id].failure,'missing');
 assert.equal(projectJourneyResult(s).recommendedId,null);
});
test('missing Google key stops the job with setup guidance',async()=>{
 const s=state();s.imageryProvider='google';const op=reserveJourneyOperation(s);assert.ok(op);
 await advanceJourneyState(s,op,config,new AbortController().signal,{
  streetImage:async()=>{throw Error('must not request imagery');},analyzeKhuImage:async()=>{throw Error('unexpected AI');},analyzeKhuViews:async()=>{throw Error('unexpected review');},reroute:async()=>{throw Error('unexpected reroute');},
 });
 assert.equal(s.phase,'limited');assert.match(s.notice??'',/GOOGLE_STREET_VIEW_API_KEY/);
});
test('Google API failure is distinct from missing imagery',async()=>{
 const s=state();s.imageryProvider='google';const op=reserveJourneyOperation(s);assert.ok(op);
 await advanceJourneyState(s,op,{...config,googleStreetViewKey:'test'},new AbortController().signal,{
  streetImage:async()=>{throw new ImageryServiceError(403);},analyzeKhuImage:async()=>{throw Error('unexpected AI');},analyzeKhuViews:async()=>{throw Error('unexpected review');},reroute:async()=>{throw Error('unexpected reroute');},
 });
 assert.equal(s.phase,'limited');assert.match(s.notice??'',/Google 거리영상 API 요청에 실패/);
});

for(const counters of [{lookups:60,analyses:1},{lookups:1,analyses:48},{lookups:60,analyses:48}])test(`unprocessed samples continue with lookup count ${counters.lookups} and analysis count ${counters.analyses}`,async()=>{
    const s=state();Object.assign(s,counters);
    const operation=reserveJourneyOperation(s);
    assert.ok(operation?.kind==='capture');
    await advanceJourneyState(s,operation,config,new AbortController().signal,captureDependencies());
    assert.equal(s.lookups,counters.lookups+1);
    assert.equal(s.analyses,counters.analyses+1);
    assert.equal(s.evidence[operation.route.id+':'+operation.sample.id].status,'clear');
    assert.equal(projectJourneyResult(s).recommendedId,null);
});
