import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {JourneyJobStore} from '../lib/journey-jobs.ts';
import {JOURNEY_VERSION,journeyStateSchema,type JourneyState} from '../lib/journey.ts';
import {samplesFor,type Finding,type Route,type Sample} from '../lib/domain.ts';
import type {StreetImage} from '../lib/street-imagery.ts';
import type {ServerConfig} from '../lib/server-config.ts';
import type {JointFinding} from '../lib/khu.ts';
import {saveJourneyCapture} from '../lib/journey-captures.ts';
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
import {cloneDemoJourney} from '../lib/journey-demo-cache.ts';
import {readJourneyCapture,listJourneyCaptures} from '../lib/journey-captures.ts';
test('demo snapshot cloning preserves real image bytes, judgments and expiry while isolating cancellation',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-01-01',d1Databases:['DB']});
 try{
  const db=await mf.getD1Database('DB');await migrate(db);const store=new JourneyJobStore(db),s=state();
  await store.insert('source','owner',s,1000);const lease=await store.acquire('source','owner','token',1001);assert.ok(lease);
  const sample=s.candidates[0].samples[0],image=imageFor(sample),evidenceId='r:'+sample.id;
  const preview=await saveJourneyCapture(db,{jobId:'source',ownerId:'owner',lease:{revision:lease.revision,token:'token'},view:{evidenceId,viewId:'initial',image,target:sample}},1002);assert.ok(preview);
  const source=preview.source;
  s.evidence[evidenceId]={sampleId:sample.id,stage:'processed',status:'clear',finding:observedFinding(),source,reason:'real observation',checkedAt:'2026-10-30T00:00:00Z'};
  s.evidence['r:pending']={sampleId:'pending',stage:'reserved',status:'unknown',reason:'pending',checkedAt:'2026-10-30T00:00:00Z'};
  await store.write('source','owner',lease,s,true,1003);
  assert.equal(await cloneDemoJourney(db,s,'other',config,1004),null);
  assert.equal(await cloneDemoJourney(db,{...s,profile:'유아차'},'owner',config,1004),null);
  const cloned=await cloneDemoJourney(db,s,'owner',config,1004);assert.ok(cloned);assert.notEqual(cloned,'source');
  const row=await store.read(cloned,'owner',1005),actual=journeyStateSchema.parse(JSON.parse(row.state));
  assert.deepEqual(actual.evidence[evidenceId],s.evidence[evidenceId]);assert.equal(actual.evidence['r:pending'],undefined);
  assert.equal(row.expires_at,1801000);
  const captures=await listJourneyCaptures(db,cloned,'owner',1005);assert.equal(captures.length,1);assert.notEqual(captures[0].id,preview.id);assert.equal(captures[0].createdAt,preview.createdAt);
  assert.deepEqual(await readJourneyCapture(db,captures[0].id,'owner',1005),await readJourneyCapture(db,preview.id,'owner',1005));
  await store.cancel('source','owner',1006);assert.equal((await store.read(cloned,'owner',1007)).phase,'running');
  assert.equal(await cloneDemoJourney(db,s,'owner',config,1801000),null);
 }finally{await mf.dispose();}
});
