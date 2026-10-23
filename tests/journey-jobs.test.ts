import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {JourneyJobStore,JourneyJobError} from '../lib/journey-jobs.ts';
import {reserveJourneyOperation,advanceJourneyState,projectJourneyResult,journeyStateSchema,type JourneyState} from '../lib/journey.ts';
import {samplesFor,summary,type Route} from '../lib/domain.ts';
import {ImageryServiceError} from '../lib/street-imagery.ts';
import type {ServerConfig} from '../lib/server-config.ts';
const config:ServerConfig={routing:{kind:'kakao',restKey:'test'},ai:'test',model:'gemini-test',mapillary:'',rendererToken:'test'};
function state():JourneyState{
    const coords:[number,number][]=[[127,37],[127.001,37]];
    const route:Route={id:'r',name:'r',coords,distance:89,seconds:100,options:[],steps:[],samples:samplesFor(coords),fetchedAt:''};
    return {version:1,start:{id:'a',name:'a',address:'',coord:coords[0]},end:{id:'b',name:'b',address:'',coord:coords[1]},profile:'수동 휠체어',candidates:[route],evidence:{},exclusions:[],pendingReplans:[],lookups:0,analyses:0,replans:0,phase:'running'};
}
test('real D1 lease, owner isolation, expiration and cancel prevent stale commits',async()=>{
    const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-01-01',d1Databases:['DB']});
    try{
        const db=await mf.getD1Database('DB');
        const sql=await readFile(new URL('../drizzle/0000_aromatic_skullbuster.sql',import.meta.url),'utf8');
        for(const part of sql.split('--> statement-breakpoint')) await db.prepare(part).run();
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
        const recovering=state();
        const stale=await store.acquire('recovery','owner','old',1001);
        assert.ok(stale);
        assert.ok(reserveJourneyOperation(recovering));
        const staleReserved=await store.write('recovery','owner',stale,recovering,false,1002);
        assert.ok(staleReserved);
        const replacement=await store.acquire('recovery','owner','new',91_002);
        assert.ok(replacement);
        const recovered=JSON.parse(replacement.state);
        const attempted=Object.values(journeyStateSchema.parse(recovered).evidence)[0];
        assert.equal(attempted.stage,'processed');
        assert.equal(attempted.status,'unknown');
        assert.match(attempted.reason,/중단/);
        assert.equal(attempted.finding,undefined);
        assert.equal(summary(recovering.candidates[0],recovered.evidence).checked,1);
        assert.equal(reserveJourneyOperation(recovered),null);
        assert.equal(recovered.lookups,1);
        assert.equal(recovered.analyses,1);
        assert.equal(projectJourneyResult(recovered).recommendedId,null);
        assert.equal(await store.write('recovery','owner',stale,state(),true,91_003),null);
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
    assert.equal(second,null);
    assert.equal(s.phase,'limited');
    assert.equal(projectJourneyResult(s).recommendedId,null);
});
test('renderer 429 retains real routes as limited instead of discarding them',async()=>{
    const s=state();const op=reserveJourneyOperation(s);assert.ok(op);
    await advanceJourneyState(s,op,config,new AbortController().signal,{
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
            streetImage:async sample=>({image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{url:'https://example.com/actual-provider-image',capturedAt:Date.now(),coord:sample.coord,heading:sample.heading}}),
            analyzeKhuImage:async()=>{calls++;return {model:'gemini-test',finding:{status:'clear',reason:'visible clear path',evidence:[],limitations:[],pathVisible:true,routeMatch:'same-path'},checkedAt:new Date().toISOString(),usage:{input:1,output:1}};},
            reroute:async()=>{throw new Error('unexpected reroute');},
        });
        if(calls<s.candidates[0].samples.length) assert.equal(projectJourneyResult(s).recommendedId,null);
    }
    assert.equal(calls,s.candidates[0].samples.length);assert.equal(s.phase,'ready');assert.equal(projectJourneyResult(s).recommendedId,'r');
});

for(const failure of ['unknown','caution'] as const)test(`a ${failure} first route does not consume the budget needed for a clear alternative`,async()=>{
    const s=state();
    const coords:[number,number][]=[[127,37],[127.015,37]];
    const first={...s.candidates[0],coords,samples:samplesFor(coords)};
    const second={...first,id:'alternative',name:'alternative'};
    s.candidates=[first,second];
    assert.ok(first.samples.length+second.samples.length>48);
    let calls=0;
    while(s.phase==='running'){
        const op=reserveJourneyOperation(s);if(!op)break;
        await advanceJourneyState(s,op,config,new AbortController().signal,{
            streetImage:async sample=>({image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{url:'https://example.com/fixture',capturedAt:Date.now(),coord:sample.coord,heading:sample.heading}}),
            analyzeKhuImage:async()=>({model:'gemini-test',finding:{status:++calls===1?failure:'clear',reason:'test observation',evidence:[],limitations:[],pathVisible:true,routeMatch:'same-path'},checkedAt:new Date().toISOString(),usage:{input:1,output:1}}),
            reroute:async()=>{throw Error('unexpected reroute');},
        });
    }
    assert.equal(projectJourneyResult(s).recommendedId,'alternative');
    assert.equal(calls,1+second.samples.length);
    assert.ok(calls<=48);
});

test('native parsed observations survive persisted journey schema',async()=>{
    const {parseKhuGeminiResponse}=await import('../lib/khu.ts');
    const {journeyStateSchema}=await import('../lib/journey.ts');
    const s=state();const op=reserveJourneyOperation(s);assert.ok(op);
    const features={stairs:{state:'not-observed',reason:'사진에 계단이 보이지 않음'},incline:{state:'present',reason:'동일 통로에 경사가 보임'}};
    const parsed=parseKhuGeminiResponse({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({status:'caution',reason:'경사 관찰',evidence:[],limitations:[],pathVisible:true,routeMatch:'same-path',features})}]}}]});
    await advanceJourneyState(s,op,config,new AbortController().signal,{
        streetImage:async sample=>({image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{url:'https://example.com/fixture',capturedAt:null,coord:sample.coord,heading:sample.heading}}),
        analyzeKhuImage:async()=>({...parsed,model:'gemini-test',checkedAt:new Date().toISOString()}),
        reroute:async()=>{throw Error('unexpected reroute');},
    });
    const persisted=journeyStateSchema.parse(JSON.parse(JSON.stringify(s)));
    assert.deepEqual(Object.values(persisted.evidence)[0].finding?.features,features);
    assert.equal(Object.values(persisted.evidence)[0].stage,'processed');
    const legacy=state();legacy.evidence['r:s0']={sampleId:'s0',status:'clear',reason:'legacy',checkedAt:''};
    assert.equal(journeyStateSchema.parse(legacy).evidence['r:s0'].stage,undefined);
});

test('missing images and failed capture attempts finish unknown without invented observations',async()=>{
    for(const failure of ['missing','transient','auth','aborted']){
        const s=state();const op=reserveJourneyOperation(s);assert.ok(op);
        const controller=new AbortController();
        const advance=advanceJourneyState(s,op,config,controller.signal,{
            streetImage:async()=>{
                if(failure==='missing') return null;
                if(failure==='aborted') controller.abort();
                throw new ImageryServiceError(failure==='auth'?401:503);
            },
            analyzeKhuImage:async()=>{throw Error('unexpected AI call');},
            reroute:async()=>{throw Error('unexpected reroute');},
        });
        if(failure==='auth'||failure==='aborted') await assert.rejects(advance);
        else await advance;
        const evidence=Object.values(s.evidence)[0];
        assert.equal(evidence.stage,'processed');
        assert.equal(evidence.status,'unknown');
        assert.equal(evidence.finding,undefined);
        assert.equal(evidence.source,undefined);
        assert.equal(projectJourneyResult(s).recommendedId,null);
    }
});
