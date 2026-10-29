import {test} from 'node:test';
import assert from 'node:assert/strict';
import {adjacentSamples,captureAdjacentViews,hasIndependentPanorama,panoramaIdentity,viewIdentity} from '../lib/adjacent-views.ts';
import {KhuError,validateJointFinding} from '../lib/khu.ts';
import {bearing,samplesFor,validateFinding,evaluateRoute,type Route,type Finding} from '../lib/domain.ts';
import {JOURNEY_VERSION,providerStairSamples,reserveJourneyOperation,advanceJourneyState,projectJourneyResult,journeyStateSchema,type JourneyState,type JourneyDependencies} from '../lib/journey.ts';
import type {ServerConfig} from '../lib/server-config.ts';
import {ImageryServiceError,type StreetImage} from '../lib/street-imagery.ts';
const config:ServerConfig={routing:{kind:'kakao',restKey:'test'},ai:'test',model:'gemini-test',mapillary:'',rendererToken:'test'};
const route:Route={id:'r',name:'r',coords:[[127,37],[127.002,37]],distance:177,seconds:200,steps:[],options:[],samples:samplesFor([[127,37],[127.002,37]]),fetchedAt:''};
const sample=route.samples[1];
const initial={status:'caution',reason:'차량이 연결부를 가림',pathVisible:true,routeMatch:'same-path',visibility:'occluded',reviewReason:'occlusion',evidence:[],limitations:[],observation:{connection:'unobservable',surface:'continuous',uncertainty:'occlusion',target:'sidewalk',reason:'차량 뒤 연결부가 직접 보이지 않음'}} satisfies Finding;
const clear={...initial,status:'clear',visibility:'visible',reviewReason:'none',observation:{...initial.observation,connection:'flush',uncertainty:'none',reason:'원래 연결부가 같은 통로의 노면에 이어지는 것이 직접 보임'}} satisfies Finding;
function joint(){return {finding:clear,views:[{id:'center',sameCorridor:true,targetPatchVisible:true,observation:'원래 연결부가 보임'},{id:'after',sameCorridor:true,targetPatchVisible:false,observation:'주변 포장만 보임'}],supportIds:['center'],originalConnectionVisible:true};}
function state(reason:'framing'|'occlusion'='occlusion'):JourneyState{
 const finding=reason==='framing'?validateFinding({...initial,visibility:'unobservable',reviewReason:'framing',observation:{...initial.observation,uncertainty:'framing'}}):initial;
 const source={url:'https://map.kakao.com/?panoid=1',panoId:'1',capturedAt:Date.now(),coord:sample.coord,heading:sample.heading,distance:0};
 return {version:JOURNEY_VERSION,provider:'kakao',goal:'arrival',start:{id:'a',name:'a',address:'',coord:route.coords[0]},end:{id:'b',name:'b',address:'',coord:route.coords[1]},profile:'수동 휠체어',candidates:[route],evidence:{['r:'+sample.id]:{sampleId:sample.id,stage:'processed',status:finding.status,reason:finding.reason,finding,source,checkedAt:'',review:{state:'pending',reason,initialFinding:finding,initialSource:source,sources:[],supportIds:[],note:''}}},exclusions:[],pendingReplans:[],lookups:1,analyses:1,replans:0,phase:'running'};
}
test('single visible walkway cannot be clear when the connection is occluded',()=>{assert.equal(validateFinding({...initial,status:'clear'}).status,'caution');});
test('occluded connections are explained as unobserved rather than blocked',()=>{
 const s=state(),issue=projectJourneyResult(s).assessments[route.id].decision.issues.find(point=>point.sampleId===sample.id);
 assert.equal(issue?.status,'unknown');
 assert.match(issue?.reason??'',/가려/);
 assert.notEqual(issue?.status,'blocked');
});
test('joint review requires actual target support on the same corridor and distinct panoramas',()=>{
 assert.equal(validateJointFinding(joint(),['center','after'],['center']).finding.status,'clear');
 assert.equal(validateJointFinding(joint(),['center','after'],[]).finding.status,'unknown');
 assert.equal(validateJointFinding({...joint(),originalConnectionVisible:false},['center','after'],['after']).finding.status,'unknown');
 assert.equal(validateJointFinding({...joint(),supportIds:['after']},['center','after'],['after']).finding.status,'unknown');
 assert.equal(validateJointFinding({...joint(),views:joint().views.map(view=>({...view,sameCorridor:false}))},['center','after'],['after']).finding.status,'unknown');
 assert.throws(()=>validateJointFinding({...joint(),supportIds:['fabricated']},['center','after'],['after']));
 assert.throws(()=>validateJointFinding({...joint(),views:[{id:'center'}]},['center'],['center']));
});
test('unsupported caution cannot become a conditional route after review',()=>{
 const caution={...clear,status:'caution' as const,observation:{...clear.observation,surface:'uneven' as const}};
 const review={...joint(),finding:caution,supportIds:[]};
 assert.equal(validateJointFinding(review,['center','after'],['center']).finding.status,'unknown');
 assert.equal(validateJointFinding({...review,supportIds:['center']},['center','after'],['center']).finding.status,'caution');
});
test('framing recovery permits same-panorama support only for the directly visible original target',()=>{
 assert.equal(validateJointFinding(joint(),['center','after'],[],'framing').finding.status,'clear');
 for(const result of [
  {...joint(),originalConnectionVisible:false},
  {...joint(),supportIds:[]},
  {...joint(),supportIds:['after']},
  {...joint(),views:joint().views.map(view=>({...view,sameCorridor:false}))},
 ]){
  assert.equal(validateJointFinding(result,['center','after'],[],'framing').finding.status,'unknown');
 }
 assert.equal(validateJointFinding(joint(),['center','after'],[],'occlusion').finding.status,'unknown');
});
test('a rotated view looking away from the crossing cannot support its verdict',async()=>{
 const s=state('framing'),target={...sample,coord:[127.001,37] as [number,number],heading:90,critical:true,target:'crossing-entry' as const};
 const candidate={...route,samples:route.samples.map(point=>point.id===target.id?target:point)};
 s.candidates=[candidate];
 const item=s.evidence['r:'+target.id],camera=[127.0011,37] as [number,number];
 assert.ok(item.review);
 item.review.initialSource={...item.review.initialSource,coord:camera,heading:270};
 await advanceJourneyState(s,{kind:'review',route:candidate,sample:target,captureLimit:3},config,new AbortController().signal,{
  streetImage:async point=>({image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{url:'https://map.kakao.com/?panoid=1',panoId:'1',capturedAt:Date.now(),coord:camera,heading:point.heading}}),
  analyzeKhuImage:async()=>{throw Error('unexpected single analysis');},reroute:async()=>{throw Error('unexpected reroute');},
  analyzeKhuViews:async({views})=>({checkedAt:'',review:{finding:{...clear,observation:{...clear.observation,target:'crossing-entry'}},views:views.map(view=>({id:view.id,sameCorridor:true,targetPatchVisible:true,observation:'claimed visible'})),supportIds:['look-forward'],originalConnectionVisible:true}}),
 });
 assert.equal(item.status,'unknown');
 assert.match(item.reason,/방향/);
 assert.equal(item.review.state,'complete');
});
for(const outcome of ['clear','unknown'] as const)test(`framing review beyond former counts schedules one occlusion review ending ${outcome}`,async()=>{
 const s=state('framing'),item=s.evidence['r:'+sample.id];
 s.lookups=60;s.analyses=48;
 const first=reserveJourneyOperation(s);assert.ok(first?.kind==='review');
 const occluded={...initial,status:'unknown' as const,visibility:'occluded' as const,reviewReason:'occlusion' as const};
 await advanceJourneyState(s,first,config,new AbortController().signal,{
  streetImage:async point=>({image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{url:'https://map.kakao.com/?panoid=1',panoId:'1',capturedAt:Date.now(),coord:sample.coord,heading:point.heading}}),
  analyzeKhuImage:async()=>{throw Error('unexpected single analysis');},reroute:async()=>{throw Error('unexpected reroute');},
  analyzeKhuViews:async({views})=>({checkedAt:'',review:{finding:occluded,views:views.map(view=>({id:view.id,sameCorridor:true,targetPatchVisible:false,observation:'target occluded'})),supportIds:[],originalConnectionVisible:false}}),
 });
 assert.equal(item.review?.state,'pending');
 assert.equal(item.review?.reason,'occlusion');
 assert.deepEqual(s.exclusions,[]);
 const second=reserveJourneyOperation(s);assert.ok(second?.kind==='review');
 await advanceJourneyState(s,second,config,new AbortController().signal,{
  streetImage:async point=>({image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{url:'https://map.kakao.com/?panoid='+(Math.round(point.along)+2),panoId:String(Math.round(point.along)+2),capturedAt:Date.now(),coord:point.coord,heading:point.heading}}),
  analyzeKhuImage:async()=>{throw Error('unexpected single analysis');},reroute:async()=>{throw Error('unexpected reroute');},
  analyzeKhuViews:async({views})=>({checkedAt:'',review:{finding:outcome==='clear'?clear:occluded,views:views.map(view=>({id:view.id,sameCorridor:true,targetPatchVisible:outcome==='clear',observation:outcome==='clear'?'connection visible':'target remains occluded'})),supportIds:outcome==='clear'?['before']:[],originalConnectionVisible:outcome==='clear'}}),
 });
 assert.equal(item.review?.state,'complete');
 assert.equal(item.status,outcome);
 assert.deepEqual(item.review?.supportIds,outcome==='clear'?['before']:[]);
 assert.equal(s.lookups,66);assert.equal(s.analyses,50);
 assert.notEqual(reserveJourneyOperation(s)?.kind,'review');
 assert.equal(projectJourneyResult(s).recommendedId,null);
});
test('ordered adjacent points follow traversal through a self-crossing instead of snapping to another branch',()=>{
 const crossing:Route={...route,coords:[[127,37],[127.001,37],[127.001,37.001],[127,37.001],[127,37],[127.001,37]],samples:[]};
 const later:typeof sample={...sample,coord:[127.0003,37],along:430,heading:90};
 const points=adjacentSamples(crossing,later);
 assert.equal(points.length,3);assert.equal(points[1].sample.along,418);assert.equal(points[2].sample.along,442);
});
test('capture review keeps partial orientations from one panorama with at most two active cameras',async()=>{
 let active=0,peak=0,calls=0;
 const gate=Promise.withResolvers<void>();
 const pending=captureAdjacentViews({route,sample,limit:3,config,signal:new AbortController().signal,capture:async(point,_config,_signal,options)=>{
   active++;peak=Math.max(peak,active);calls++;assert.deepEqual(options?.target,sample.coord);
   await gate.promise;active--;
   if(point.along>sample.along)throw new Error('third frame unavailable');
   return {image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{url:'https://map.kakao.com/?panoid=1',panoId:'1',capturedAt:Date.now(),coord:sample.coord,heading:point.along===sample.along?90:270,tilt:options?.tilt,zoom:options?.zoom}};
 }});
 assert.equal(active,2);assert.equal(calls,2);
 gate.resolve();
 const result=await pending;
 assert.equal(calls,3);assert.equal(result.attempts,3);assert.equal(peak,2);
 assert.equal(result.views.length,2);
 assert.deepEqual(result.views.map(view=>view.image.source.heading).sort((a,b)=>a-b),[90,270]);
});
test('review retains dated and undated real frames with their source attribution',async()=>{
 const frames=[
  {url:'https://map.kakao.com/?panoid=21',panoId:'21',capturedAt:null,capturedMonth:'2025-01'},
  {url:'https://map.kakao.com/?panoid=22',panoId:'22',capturedAt:null},
 ];
 const saved:string[]=[];
 const result=await captureAdjacentViews({route,sample,limit:2,config,signal:new AbortController().signal,
  capture:async point=>({image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{...frames[point.along===sample.along?0:1],coord:point.coord,heading:point.heading}}),
  onView:async view=>{saved.push(view.image.source.url);},
 });
 assert.equal(result.views.length,2);
 assert.deepEqual(new Set(result.views.map(view=>view.image.source.url)),new Set(frames.map(frame=>frame.url)));
 assert.deepEqual(new Set(saved),new Set(frames.map(frame=>frame.url)));
 assert.equal(result.views.find(view=>view.image.source.panoId==='21')?.image.source.capturedMonth,'2025-01');
 assert.equal(result.views.find(view=>view.image.source.panoId==='22')?.image.source.capturedAt,null);
});
test('panorama identity separates physical panoramas from camera orientations',()=>{
 const source={url:'https://map.kakao.com/?panoid=1',panoId:'1',capturedAt:null,coord:sample.coord,heading:0};
 const rotated={...source,heading:90};
 const other={...source,url:'https://map.kakao.com/?panoid=2',panoId:'2',coord:route.coords[0]};
 assert.equal(panoramaIdentity(source),panoramaIdentity(rotated));
 assert.notEqual(viewIdentity(source),viewIdentity(rotated));
 assert.notEqual(panoramaIdentity(source),panoramaIdentity(other));
 assert.equal(hasIndependentPanorama(source,rotated),false);
 assert.equal(hasIndependentPanorama(source,other),true);
 assert.equal(hasIndependentPanorama(source,{...other,coord:source.coord}),false);
 assert.equal(hasIndependentPanorama(source,{...other,url:'https://map.kakao.com/',panoId:undefined}),false);
});
test('opaque NAVER IDs are provider scoped and actual FOV distinguishes views, not physical panoramas',()=>{
 const naver:StreetImage['source']={provider:'naver',url:'https://viewer.map.naver.com/panorama?id=123&heading=0&tilt=-7&fov=90',panoId:'123',capturedAt:null,coord:sample.coord,heading:0,tilt:7,fov:90,zoom:0};
 const closeup={...naver,fov:40,url:naver.url.replace('fov=90','fov=40')};
 const other={...naver,panoId:'opaque-next-id',url:naver.url.replace('id=123','id=opaque-next-id'),coord:route.coords[0]};
 const kakao={...naver,provider:undefined,url:'https://map.kakao.com/?panoid=123',coord:route.coords[0]};
 assert.equal(panoramaIdentity(naver),'naver:123');
 assert.equal(panoramaIdentity(naver),panoramaIdentity(closeup));
 assert.notEqual(viewIdentity(naver),viewIdentity(closeup));
 assert.equal(viewIdentity(naver),viewIdentity({...naver,zoom:2}));
 assert.notEqual(panoramaIdentity(naver),panoramaIdentity(kakao));
 assert.equal(hasIndependentPanorama(naver,closeup),false);
 assert.equal(hasIndependentPanorama(naver,other),true);
 assert.equal(hasIndependentPanorama(naver,kakao),false);
 assert.notEqual(panoramaIdentity({...naver,url:'https://map.naver.com/?panoid=123'}),'kakao:123');
 assert.notEqual(panoramaIdentity({...naver,provider:undefined}),'naver:123');
 assert.notEqual(panoramaIdentity({...kakao,url:'https://www.mapillary.com/app/?panoid=123'}),'kakao:123');
});
test('NAVER framing review keeps actual camera metadata through joint review and persisted state parsing',async()=>{
 const s=state('framing'),item=s.evidence['r:'+sample.id];
 const source={provider:'naver',url:`https://viewer.map.naver.com/panorama?id=opaque-camera&heading=${sample.heading}&tilt=-7&fov=90`,panoId:'opaque-camera',capturedAt:null,capturedMonth:'2026-06',coord:sample.coord,heading:sample.heading,tilt:7,fov:90,zoom:0,distance:0} satisfies NonNullable<typeof item.source>;
 assert.ok(item.review);
 item.source=source;item.review.initialSource=source;
 const op=reserveJourneyOperation(s);assert.ok(op?.kind==='review');
 await advanceJourneyState(s,op,config,new AbortController().signal,{
  streetImage:async(point,_config,_signal,options)=>{
   const pan=((point.heading+180)%360+360)%360-180,tilt=options?.tilt??0,fov=options?.zoom===1?60:90;
   return {image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{...source,url:`https://viewer.map.naver.com/panorama?id=opaque-camera&heading=${pan}&tilt=${-tilt}&fov=${fov}`,heading:point.heading,tilt,fov,zoom:options?.zoom}};
  },
  analyzeKhuImage:async()=>{throw Error('Unexpected initial analysis');},
  analyzeKhuViews:async({views})=>({checkedAt:'',review:{finding:clear,views:views.map(view=>({id:view.id,sameCorridor:true,targetPatchVisible:true,observation:'Original target directly visible'})),supportIds:['look-down'],originalConnectionVisible:true}}),
  reroute:async()=>{throw Error('Unexpected reroute');},
 });
 const persisted=journeyStateSchema.parse(JSON.parse(JSON.stringify(s))).evidence['r:'+sample.id];
 assert.deepEqual(persisted.review?.initialSource,source);
 const downward=persisted.review?.sources.find(view=>view.id==='look-down')?.source;
 assert.equal(downward?.provider,'naver');
 assert.equal(downward?.panoId,'opaque-camera');
 assert.equal(downward?.tilt,25);
 assert.equal(downward?.fov,60);
 assert.equal(persisted.finding?.status,'clear');
});
test('lost screenshot ownership cancels in-flight review captures and starts no further camera',async()=>{
 let calls=0,peerCanceled=false;
 const failure=new Error('lost ownership');
 const pending=captureAdjacentViews({route,sample,limit:3,config,signal:new AbortController().signal,
  capture:async(point,_config,requestSignal)=>{
   calls++;
   if(calls===1)return {image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{url:'https://map.kakao.com/?panoid=1',panoId:'1',capturedAt:Date.now(),coord:point.coord,heading:point.heading}};
   const {promise,reject}=Promise.withResolvers<never>();
   requestSignal.addEventListener('abort',()=>{peerCanceled=true;reject(requestSignal.reason);},{once:true});
   if(requestSignal.aborted){peerCanceled=true;reject(requestSignal.reason);}
   return promise;
  },
  onView:async()=>{throw failure;},
 });
 await assert.rejects(pending,error=>error===failure);
 assert.equal(calls,2);
 assert.equal(peerCanceled,true);
});
for(const status of [401,403,404,429,503])test(`review preserves imagery service error ${status} when no view was captured`,async()=>{
 await assert.rejects(captureAdjacentViews({route,sample,limit:1,config,signal:new AbortController().signal,capture:async()=>{throw new ImageryServiceError(status);}}),error=>error instanceof ImageryServiceError&&error.status===status);
});
test('recovery is a separate bounded operation, preserves originals, and cannot erase known blocked passage',async()=>{
 const s=state(),item=s.evidence['r:'+sample.id];
 item.status='blocked';item.finding={...clear,status:'blocked',observation:{...clear.observation,connection:'stairs',reason:'같은 통로의 계단이 직접 보임'}};
 const op=reserveJourneyOperation(s);assert.equal(op?.kind,'review');assert.ok(op);
 let analyses=0;
 const deps:JourneyDependencies={streetImage:async point=>({image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{url:'https://map.kakao.com/?panoid='+(Math.round(point.along)+2),panoId:String(Math.round(point.along)+2),capturedAt:Date.now(),coord:point.coord,heading:point.heading}}),analyzeKhuImage:async()=>{throw Error('initial capture must not rerun');},analyzeKhuViews:async({views})=>{analyses++;return {review:{...joint(),views:views.map(view=>({id:view.id,sameCorridor:true,targetPatchVisible:true,observation:'connection'})),supportIds:[views[0].id]},checkedAt:''};},reroute:async()=>{throw Error('not rerouting in review');}};
 await advanceJourneyState(s,op,config,new AbortController().signal,deps);
 assert.equal(analyses,1);assert.equal(item.status,'blocked');assert.equal(item.review?.initialFinding.reason,initial.reason);assert.equal(item.review?.state,'complete');assert.equal(item.review?.sources.length,3);
 assert.notEqual(reserveJourneyOperation(s)?.kind,'review');
});
test('review reserves at most three views beyond former global counts and never duplicates an in-flight review',()=>{
 const s=state();s.lookups=60;s.analyses=48;const op=reserveJourneyOperation(s);assert.equal(op?.kind,'review');if(op?.kind==='review')assert.equal(op.captureLimit,3);assert.equal(s.lookups,63);assert.equal(s.analyses,49);assert.notEqual(reserveJourneyOperation(s)?.kind,'review');
});

test('exact provider stair instruction excludes stairs without fabricating visual evidence',()=>{
 const stairs={...route,steps:[{text:'계단 이용',coord:sample.coord}]};
 assert.equal(providerStairSamples(stairs,'수동 휠체어').length,1);
 assert.equal(providerStairSamples(stairs,'유아차').length,1);
 assert.equal(providerStairSamples({...route,steps:[{text:'계단 옆 보도 이용',coord:sample.coord}]},'수동 휠체어').length,0);
 assert.equal(providerStairSamples(stairs,'보행 보조기').length,1);
});

test('an unrelated new panorama cannot support a clear verdict assigned only to the initial view',()=>{
 assert.equal(validateJointFinding(joint(),['center','after'],['after']).finding.status,'unknown');
 const newSupport={...joint(),views:joint().views.map(view=>({...view,targetPatchVisible:true})),supportIds:['after']};
 assert.equal(validateJointFinding(newSupport,['center','after'],['after']).finding.status,'clear');
});
test('contradictory clear with corridor uncertainty stays unknown and cannot bypass review',()=>{
 const finding=validateFinding({...clear,reviewReason:'corridor-uncertain'});
 assert.equal(finding.status,'unknown');assert.equal(finding.routeMatch,'uncertain');
});
test('recovery uses camera metadata of the supporting view rather than unrelated nearby images',async()=>{
 for(const support of ['center','after']){
  const s=state(),item=s.evidence['r:'+sample.id],op=reserveJourneyOperation(s);assert.ok(op);
  await advanceJourneyState(s,op,config,new AbortController().signal,{
   streetImage:async point=>({image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{url:'https://map.kakao.com/?panoid='+(Math.round(point.along)+2),panoId:String(Math.round(point.along)+2),capturedAt:Date.now(),coord:point.coord,heading:point.heading}}),
   analyzeKhuImage:async()=>{throw Error('unexpected single analysis');},reroute:async()=>{throw Error('unexpected reroute');},
   analyzeKhuViews:async({views})=>({checkedAt:'',review:{finding:clear,views:views.map(view=>({id:view.id,sameCorridor:view.id===support,targetPatchVisible:view.id===support,observation:'only the supporting view shows the intended connection'})),supportIds:[support],originalConnectionVisible:true}}),
  });
  assert.equal(item.status,support==='center'?'unknown':'clear');
  if(support==='after'){
   const supportingSource=item.review?.sources.find(view=>view.id===support)?.source;
   assert.ok(supportingSource);
   assert.deepEqual(item.source,supportingSource);
   assert.equal(item.review?.initialSource.panoId,'1');
  }
 }
});
test('review distinguishes same-panorama framing from occlusion requiring a distinct physical view',async()=>{
 const cases=[
  {reason:'framing',samePano:true,samePosition:true,targetVisible:true,expected:'clear'},
  {reason:'framing',samePano:true,samePosition:true,targetVisible:false,expected:'unknown'},
  {reason:'occlusion',samePano:true,samePosition:false,targetVisible:true,expected:'unknown'},
  {reason:'occlusion',samePano:false,samePosition:true,targetVisible:true,expected:'unknown'},
  {reason:'occlusion',samePano:false,samePosition:false,targetVisible:true,expected:'clear'},
 ] as const;
 for(const scenario of cases){
  const s=state(scenario.reason),key='r:'+sample.id,item=s.evidence[key];
  const original=structuredClone(item.review?.initialFinding),originalSource=structuredClone(item.source);
  const op=reserveJourneyOperation(s);assert.equal(op?.kind,'review');assert.ok(op);
  await advanceJourneyState(s,op,config,new AbortController().signal,{
   streetImage:async(point,_config,_signal,options)=>{
    if(scenario.reason==='framing'){
     assert.deepEqual(point.coord,sample.coord);
     assert.ok(Math.abs(((point.heading-sample.heading+540)%360)-180)<=90);
     assert.ok(options?.tilt!==undefined&&options.tilt>0);
    }
    const panoId=scenario.samePano?'1':String(Math.round(point.along)+2);
    return {image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{url:'https://map.kakao.com/?panoid='+panoId,panoId,capturedAt:Date.now(),coord:scenario.samePosition?sample.coord:point.coord,heading:point.heading,tilt:options?.tilt,zoom:options?.zoom}};
   },
   analyzeKhuImage:async()=>{throw Error('unexpected initial analysis');},
   reroute:async()=>{throw Error('unexpected reroute');},
   analyzeKhuViews:async({views})=>({checkedAt:'',review:{finding:clear,views:views.map(view=>({id:view.id,sameCorridor:true,targetPatchVisible:scenario.targetVisible,observation:scenario.targetVisible?'The original target is directly visible.':'Only neighboring paving is visible.'})),supportIds:[scenario.reason==='framing'?views[0].id:'after'],originalConnectionVisible:scenario.targetVisible}}),
  });
  assert.equal(item.status,scenario.expected);
  assert.deepEqual(item.review?.initialFinding,original);
  assert.deepEqual(item.review?.initialSource,originalSource);
  assert.equal(item.review?.state,'complete');
  if(scenario.reason==='framing'){
   assert.equal(item.review?.sources.length,3);
   assert.equal(new Set(item.review.sources.map(view=>view.source.heading)).size,3);
  }
  const candidate:Route={...route,samples:[sample]};
  assert.equal(evaluateRoute(candidate,s.evidence).kind,scenario.expected==='clear'?'recommended':'hold');
 }
});
test('transport and analysis errors cannot become physical barriers in the journey result',async()=>{
 for(const failure of ['service','analysis','missing'] as const){
  const s=state();
  const candidate:Route={...route,samples:[{...sample,critical:true,target:'crossing-entry'}]};
  s.candidates=[candidate];s.evidence={};
  const op=reserveJourneyOperation(s);assert.equal(op?.kind,'capture');assert.ok(op);
  await advanceJourneyState(s,op,config,new AbortController().signal,{
   streetImage:async()=>{
    if(failure==='service')throw Error('Transport unavailable.');
    if(failure==='missing')return null;
    return {image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{url:'https://map.kakao.com/?panoid=1',panoId:'1',capturedAt:Date.now(),coord:sample.coord,heading:sample.heading}};
   },
   analyzeKhuImage:async()=>{throw Error('Analysis unavailable.');},
   analyzeKhuViews:async()=>{throw Error('Unexpected adjacent review.');},
   reroute:async()=>{throw Error('Unexpected reroute.');},
  });
  assert.equal(s.evidence['r:'+sample.id].failure,failure);
  const decision=evaluateRoute(candidate,s.evidence);
  assert.equal(decision.kind,'hold');
  assert.equal(decision.issues[0].status,'unknown');
  assert.equal(decision.issues[0].source,failure==='missing'?'coverage':'service');
  assert.equal(s.exclusions.some(passage=>passage.reason!=='unverified'),false);
  assert.equal(s.exclusions.length,failure==='missing'?1:0);
 }
});
test('a shared capture deadline with zero views is a service outage rather than missing local coverage',async()=>{
 const originalTimeout=AbortSignal.timeout,deadline=new AbortController();
 AbortSignal.timeout=()=>deadline.signal;
 let calls=0;
 try{
  const pending=captureAdjacentViews({route,sample,limit:3,config,signal:new AbortController().signal,capture:async(_sample,_config,signal)=>{
   calls++;
   const aborted=Promise.withResolvers<void>();
   signal.addEventListener('abort',()=>aborted.reject(signal.reason),{once:true});
   await aborted.promise;
   return null;
  }});
  assert.equal(calls,2);
  deadline.abort(new DOMException('Capture deadline expired.','TimeoutError'));
  await assert.rejects(pending,error=>error instanceof Error&&'status' in error&&error.status===503);
 }finally{AbortSignal.timeout=originalTimeout;}
});
test('framing recovery includes the actual target bearing when the camera originally looked away',async()=>{
 const initialSource={url:'https://map.kakao.com/?panoid=1',panoId:'1',capturedAt:Date.now(),coord:[sample.coord[0]+.0001,sample.coord[1]] as [number,number],heading:90,distance:9};
 const result=await captureAdjacentViews({route,sample,initialSource,reason:'framing',limit:3,config,signal:new AbortController().signal,capture:async(point,_config,_signal,options)=>{
  assert.deepEqual(point.coord,initialSource.coord);
  return {image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{...initialSource,heading:point.heading,tilt:options?.tilt,zoom:options?.zoom}};
 }});
 const target=bearing(initialSource.coord,sample.coord);
 assert.ok(result.views.some(view=>Math.abs(((view.image.source.heading-target+540)%360)-180)<.01));
 assert.ok(result.views.some(view=>Math.abs(((view.image.source.heading-sample.heading+540)%360)-180)<.01),'The intended travel direction must also be visible when the target is behind the camera');
});
test('unsupported joint stairs and raised connections stay unknown through route evaluation',()=>{
 for(const connection of ['stairs','raised'] as const){
  const supported=validateJointFinding({finding:{...clear,observation:{...clear.observation,connection}},views:[{id:'after',sameCorridor:true,targetPatchVisible:true,observation:'The physical obstacle is directly visible on the required connection.'}],supportIds:['after'],originalConnectionVisible:true},['after'],['after']);
  assert.equal(supported.finding.status,'blocked');
  for(const support of ['none','different-corridor','neighboring-surface'] as const){
   const finding={...clear,status:'blocked',observation:{...clear.observation,connection,reason:'An apparent obstacle has no verified support on the target connection.'}} satisfies Finding;
   const result=validateJointFinding({
    finding,
    views:[{id:'after',sameCorridor:support!=='different-corridor',targetPatchVisible:support!=='neighboring-surface',observation:'The required connection is not supported.'}],
    supportIds:support==='none'?[]:['after'],
    originalConnectionVisible:false,
   },['after'],['after']);
   assert.equal(result.finding.status,'unknown');
   assert.equal(result.finding.visibility,'unobservable');
   assert.equal(validateFinding(result.finding).status,'unknown');
   const candidate:Route={...route,samples:[sample]},s=state(),item=s.evidence['r:'+sample.id];
   item.finding=result.finding;item.status=result.finding.status;
   const decision=evaluateRoute(candidate,s.evidence);
   assert.equal(decision.kind,'hold');
   assert.equal(decision.issues[0].status,'unknown');
   assert.equal(decision.issues.some(issue=>issue.status==='blocked'),false);
  }
 }
});
test('wrong-target and not-applicable mandatory observations recover before becoming information gaps',async()=>{
 for(const target of ['crossing-entry','crossing-exit','entrance'] as const){
  for(const mismatch of ['wrong-target','not-applicable'] as const){
   const s=state(),key='r:'+sample.id;
   const candidate:Route={...route,samples:[{...sample,critical:true,target}]};
   const observation=mismatch==='wrong-target'
    ?{...clear.observation,target:'sidewalk' as const}
    :{...clear.observation,target,connection:'not-applicable' as const};
   const finding={...clear,observation};
   s.candidates=[candidate];s.evidence={};
   const deps:JourneyDependencies={
    streetImage:async point=>({image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{url:'https://map.kakao.com/?panoid='+(Math.round(point.along)+2),panoId:String(Math.round(point.along)+2),capturedAt:Date.now(),coord:point.coord,heading:point.heading}}),
    analyzeKhuImage:async()=>({finding,model:'gemini-test',checkedAt:'initial-check',usage:{input:1,output:1},billing:undefined}),
    analyzeKhuViews:async({views})=>({checkedAt:'review-check',review:{finding,views:views.map(view=>({id:view.id,sameCorridor:true,targetPatchVisible:true,observation:'Continuous neighboring paving is visible, but the mandatory connection is not established.'})),supportIds:['after'],originalConnectionVisible:true}}),
    reroute:async()=>{throw Error('Rerouting must be reserved after review.');},
   };
   const capture=reserveJourneyOperation(s);assert.equal(capture?.kind,'capture');assert.ok(capture);
   await advanceJourneyState(s,capture,config,new AbortController().signal,deps);
   assert.equal(s.evidence[key].status,'clear');
   assert.equal(s.evidence[key].review?.state,'pending');
   assert.deepEqual(s.evidence[key].review?.initialFinding,finding);
   assert.equal(projectJourneyResult(s).recommendedId,null);
   assert.equal(s.exclusions.length,0);
   const review=reserveJourneyOperation(s);assert.equal(review?.kind,'review');assert.ok(review);
   await advanceJourneyState(s,review,config,new AbortController().signal,deps);
   assert.equal(s.evidence[key].review?.state,'complete');
   assert.equal(s.exclusions.length,1);
   assert.equal(s.exclusions[0].reason,'unverified');
   assert.equal(s.exclusions[0].sampleId,sample.id);
   const result=projectJourneyResult(s),decision=result.assessments.r.decision;
   assert.equal(result.recommendedId,null);
   assert.equal(decision.kind,'hold');
   assert.equal(decision.issues[0].status,'unknown');
   assert.deepEqual(result.assessments.r.blockedPassageIds,[]);
   assert.equal(reserveJourneyOperation(s),null);
   assert.equal(s.replans,0);
   assert.deepEqual(s.pendingReplans,[]);
  }
 }
});
test('completed sampled crossings cannot hide an unresolved grouped crossing after inspection',()=>{
 const s=state(),key='r:'+sample.id;
 const candidate:Route={...route,samples:[{...sample,critical:true,target:'crossing-entry'}],unresolvedCrossings:[{id:'grouped-crossing',coord:sample.coord,along:sample.along,count:2}]};
 const finding={...clear,observation:{...clear.observation,target:'crossing-entry' as const}};
 s.candidates=[candidate];
 s.evidence[key]={...s.evidence[key],status:'clear',finding,review:undefined};
 const operation=reserveJourneyOperation(s);
 assert.equal(operation,null);
 assert.equal(s.phase,'limited');
 assert.equal(s.replans,0);
 assert.deepEqual(s.pendingReplans,[]);
 assert.equal(s.exclusions.length,1);
 assert.equal(s.exclusions[0].sampleId,'grouped-crossing');
 assert.equal(s.exclusions[0].reason,'unverified');
 const result=projectJourneyResult(s);
 assert.equal(result.recommendedId,null);
 assert.equal(result.assessments.r.decision.kind,'hold');
 assert.deepEqual(result.assessments.r.blockedPassageIds,[]);
});
test('review processing failures preserve the original observation and report service issues',async()=>{
 for(const failure of ['capture','analysis','analysis-timeout','service'] as const){
  const s=state(),key='r:'+sample.id,item=s.evidence[key];
  s.candidates=[{...route,samples:[{...sample,critical:true}]}];
  const original=structuredClone({finding:item.finding,source:item.source,status:item.status,reason:item.reason,checkedAt:item.checkedAt});
  const review=reserveJourneyOperation(s);assert.equal(review?.kind,'review');assert.ok(review);
  await advanceJourneyState(s,review,config,new AbortController().signal,{
   streetImage:async point=>{
    if(failure==='capture')throw new ImageryServiceError(503);
    return {image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{url:'https://map.kakao.com/?panoid='+(Math.round(point.along)+2),panoId:String(Math.round(point.along)+2),capturedAt:Date.now(),coord:point.coord,heading:point.heading}};
   },
   analyzeKhuImage:async()=>{throw Error('Unexpected initial analysis.');},
   analyzeKhuViews:async()=>{throw failure==='analysis'?new KhuError('Invalid model response.'):failure==='analysis-timeout'?new DOMException('Model response deadline exceeded.','TimeoutError'):new Error('Review processing failed.');},
   reroute:async()=>{throw Error('Unexpected reroute.');},
  });
  assert.deepEqual({finding:item.finding,source:item.source,status:item.status,reason:item.reason,checkedAt:item.checkedAt},original);
  assert.deepEqual(item.review?.initialFinding,original.finding);
  assert.deepEqual(item.review?.initialSource,original.source);
  assert.equal(item.review?.state,'complete');
  assert.equal(item.review?.failure,failure==='analysis-timeout'?'analysis':failure);
  assert.equal(s.phase,'limited');
  const result=projectJourneyResult(s),decision=result.assessments.r.decision;
  assert.equal(result.recommendedId,null);
  assert.equal(decision.kind,'hold');
  assert.equal(decision.issues[0].status,'unknown');
  assert.equal(decision.issues[0].source,'service');
  assert.equal(s.exclusions.length,0);
  assert.equal(s.pendingReplans.length,0);
 }
});
test('unsupported past-image warnings trigger recovery without creating physical exclusions',async()=>{
 for(const status of ['caution','blocked'] as const){
  const s=state(),key='r:'+sample.id,finding={...clear,status};
  s.candidates=[{...route,samples:[{...sample,critical:true}]}];s.evidence={};
  const deps:JourneyDependencies={
   streetImage:async point=>({image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{url:'https://map.kakao.com/?panoid='+(Math.round(point.along)+2),panoId:String(Math.round(point.along)+2),capturedAt:Date.now(),coord:point.coord,heading:point.heading}}),
   analyzeKhuImage:async()=>({finding,model:'gemini-test',checkedAt:'first',usage:{input:1,output:1}}),
   analyzeKhuViews:async({views})=>({checkedAt:'review',review:{finding:clear,views:views.map(view=>({id:view.id,sameCorridor:true,targetPatchVisible:true,observation:'The original connection is directly visible.'})),supportIds:['after'],originalConnectionVisible:true}}),
   reroute:async()=>{throw Error('No physical exclusion is expected.');},
  };
  const capture=reserveJourneyOperation(s);assert.ok(capture?.kind==='capture');
  await advanceJourneyState(s,capture,config,new AbortController().signal,deps);
  assert.equal(s.evidence[key].review?.state,'pending');assert.deepEqual(s.exclusions,[]);
  const review=reserveJourneyOperation(s);assert.ok(review?.kind==='review');
  await advanceJourneyState(s,review,config,new AbortController().signal,deps);
  assert.equal(s.evidence[key].status,'clear');
  assert.deepEqual(s.exclusions,[]);
  assert.equal(projectJourneyResult(s).recommendedId,'r');
 }
});
