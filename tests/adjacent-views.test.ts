import {test} from 'node:test';
import assert from 'node:assert/strict';
import {adjacentSamples,captureAdjacentViews} from '../lib/adjacent-views.ts';
import {validateJointFinding} from '../lib/khu.ts';
import {samplesFor,validateFinding,type Route,type Finding} from '../lib/domain.ts';
import {providerStairSamples,reserveJourneyOperation,advanceJourneyState,type JourneyState,type JourneyDependencies} from '../lib/journey.ts';
import type {ServerConfig} from '../lib/server-config.ts';
const config:ServerConfig={routing:{kind:'kakao',restKey:'test'},ai:'test',model:'gemini-test',mapillary:'',rendererToken:'test'};
const route:Route={id:'r',name:'r',coords:[[127,37],[127.002,37]],distance:177,seconds:200,steps:[],options:[],samples:samplesFor([[127,37],[127.002,37]]),fetchedAt:''};
const sample=route.samples[1];
const initial:Finding={status:'caution',reason:'차량이 연결부를 가림',pathVisible:true,routeMatch:'same-path',visibility:'occluded',reviewReason:'occlusion',evidence:[],limitations:[]};
const clear={...initial,status:'clear',visibility:'visible',reviewReason:'none'} satisfies Finding;
function joint(){return {finding:clear,views:[{id:'center',sameCorridor:true,targetPatchVisible:true,observation:'원래 연결부가 보임'},{id:'after',sameCorridor:true,targetPatchVisible:false,observation:'주변 포장만 보임'}],supportIds:['center'],originalConnectionVisible:true};}
function state():JourneyState{return {version:1,start:{id:'a',name:'a',address:'',coord:route.coords[0]},end:{id:'b',name:'b',address:'',coord:route.coords[1]},profile:'수동 휠체어',candidates:[route],evidence:{['r:'+sample.id]:{sampleId:sample.id,stage:'processed',status:'caution',reason:initial.reason,finding:initial,source:{url:'https://map.kakao.com/?panoid=1',capturedAt:Date.now(),coord:sample.coord,heading:sample.heading,distance:0},checkedAt:'',review:{state:'pending',reason:'occlusion',initialFinding:initial,initialSource:{url:'https://map.kakao.com/?panoid=1',capturedAt:Date.now(),coord:sample.coord,distance:0},sources:[],supportIds:[],note:''}}},exclusions:[],pendingReplans:[],lookups:1,analyses:1,replans:0,phase:'running'};}
test('single visible walkway cannot be clear when the connection is occluded',()=>{assert.equal(validateFinding({...initial,status:'clear'}).status,'caution');});
test('joint review requires actual target support on the same corridor and distinct panoramas',()=>{
 assert.equal(validateJointFinding(joint(),['center','after'],['center']).finding.status,'clear');
 assert.equal(validateJointFinding(joint(),['center','after'],[]).finding.status,'unknown');
 assert.equal(validateJointFinding({...joint(),originalConnectionVisible:false},['center','after'],['after']).finding.status,'unknown');
 assert.equal(validateJointFinding({...joint(),supportIds:['after']},['center','after'],['after']).finding.status,'unknown');
 assert.equal(validateJointFinding({...joint(),views:joint().views.map(view=>({...view,sameCorridor:false}))},['center','after'],['after']).finding.status,'unknown');
 assert.throws(()=>validateJointFinding({...joint(),supportIds:['fabricated']},['center','after'],['after']));
 assert.throws(()=>validateJointFinding({...joint(),views:[{id:'center'}]},['center'],['center']));
});
test('ordered adjacent points follow traversal through a self-crossing instead of snapping to another branch',()=>{
 const crossing:Route={...route,coords:[[127,37],[127.001,37],[127.001,37.001],[127,37.001],[127,37],[127.001,37]],samples:[]};
 const later:typeof sample={...sample,coord:[127.0003,37],along:430,heading:90};
 const points=adjacentSamples(crossing,later);
 assert.equal(points.length,3);assert.equal(points[1].sample.along,418);assert.equal(points[2].sample.along,442);
});
test('capture review is bounded to two workers, keeps partial views, and deduplicates rotated same panorama',async()=>{
 let active=0,peak=0,calls=0;
 const result=await captureAdjacentViews({route,sample,limit:3,config,signal:new AbortController().signal,capture:async(point,_config,_signal,options)=>{
   active++;peak=Math.max(peak,active);calls++;assert.deepEqual(options?.target,sample.coord);
   await new Promise(resolve=>setTimeout(resolve,10));active--;
   if(point.along>sample.along)throw new Error('third frame unavailable');
   return {image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{url:'https://map.kakao.com/?panoid=1',panoId:'1',capturedAt:Date.now(),coord:point.coord,heading:point.heading}};
 }});
 assert.equal(calls,3);assert.equal(result.attempts,3);assert.equal(peak,2);assert.equal(result.views.length,1);
});
test('recovery is a separate bounded operation, preserves originals, and cannot erase known blocked passage',async()=>{
 const s=state(),item=s.evidence['r:'+sample.id];
 item.status='blocked';item.finding={...initial,status:'blocked'};
 const op=reserveJourneyOperation(s);assert.equal(op?.kind,'review');assert.ok(op);
 let analyses=0;
 const deps:JourneyDependencies={streetImage:async point=>({image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{url:'https://map.kakao.com/?panoid='+point.along,panoId:String(point.along),capturedAt:Date.now(),coord:point.coord,heading:point.heading}}),analyzeKhuImage:async()=>{throw Error('initial capture must not rerun');},analyzeKhuViews:async({views})=>{analyses++;return {review:{...joint(),views:views.map(view=>({id:view.id,sameCorridor:true,targetPatchVisible:true,observation:'connection'})),supportIds:[views[0].id]},checkedAt:''};},reroute:async()=>{throw Error('not rerouting in review');}};
 await advanceJourneyState(s,op,config,new AbortController().signal,deps);
 assert.equal(analyses,1);assert.equal(item.status,'blocked');assert.equal(item.review?.initialFinding.reason,initial.reason);assert.equal(item.review?.state,'complete');assert.equal(item.review?.sources.length,3);
 assert.notEqual(reserveJourneyOperation(s)?.kind,'review');
});
test('at the capture limit a recovery reserves only remaining requests and never loops',()=>{
 const s=state();s.lookups=59;const op=reserveJourneyOperation(s);assert.equal(op?.kind,'review');if(op?.kind==='review')assert.equal(op.captureLimit,1);assert.equal(s.lookups,60);assert.notEqual(reserveJourneyOperation(s)?.kind,'review');
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
   streetImage:async point=>({image:{mime:'image/jpeg',data:'/9j/AAAA'},source:{url:'https://map.kakao.com/?panoid='+point.along,panoId:String(point.along),capturedAt:Date.now(),coord:point.coord,heading:point.heading}}),
   analyzeKhuImage:async()=>{throw Error('unexpected single analysis');},reroute:async()=>{throw Error('unexpected reroute');},
   analyzeKhuViews:async({views})=>({checkedAt:'',review:{finding:clear,views:views.map(view=>({id:view.id,sameCorridor:view.id===support,targetPatchVisible:view.id===support,observation:'only the supporting view shows the intended connection'})),supportIds:[support],originalConnectionVisible:true}}),
  });
  assert.equal(item.status,support==='center'?'unknown':'clear');
 }
});
