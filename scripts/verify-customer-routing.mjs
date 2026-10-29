import {assessRouteAdmission} from '../lib/domain.ts';
import {routeGuideBlocked} from '../app/route-presentation.ts';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from '../services/roadview-renderer/node_modules/playwright/index.mjs';
import {crossingPointControl} from './ux-refresh-driver-utils.mjs';

const base=process.env.CUSTOMER_BASE_URL??'http://localhost:3000/';
const output=process.env.CUSTOMER_REPORT_DIR??'.sites-runtime/customer-routing';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--enable-webgl','--ignore-gpu-blocklist']});
const context=await browser.newContext({viewport:{width:1440,height:960}}),page=await context.newPage();
const jobs=new Set(),canceled=new Set(),errors=[],checks=[],release=Promise.withResolvers();
let initial,inputs,advanceHeld=0;
const report={scope:'Fresh real 예술디자인대학관 → 맥도날드 search/routing. All analysis advance is held; controlled obstacle/partial UI cases are labeled and are not real findings.',checks,errors,status:'failed'};
const meters=(a,b)=>{const radians=Math.PI/180,dlat=(b[1]-a[1])*radians,dlng=(b[0]-a[0])*radians;return 6371000*2*Math.asin(Math.sqrt(Math.sin(dlat/2)**2+Math.cos(a[1]*radians)*Math.cos(b[1]*radians)*Math.sin(dlng/2)**2));};
const blocked=(candidate,journey)=>routeGuideBlocked(journey.assessments[candidate.id]);
context.on('page',view=>view.on('pageerror',error=>errors.push(error.message)));
page.on('pageerror',error=>errors.push(error.message));
async function cancel(jobId){const response=await context.request.post(new URL('/api/action',base).href,{data:{action:'cancel',jobId}});assert.ok(response.ok(),'Real journey cleanup must succeed');canceled.add(jobId);}
async function capture(view,name){await view.screenshot({path:output+'/'+name+'.png'});}
async function choose(view,candidate){await view.getByRole('button',{name:candidate.name+' 선택',exact:true}).click();assert.equal(await view.getByRole('button',{name:candidate.name+' 선택',exact:true}).getAttribute('aria-pressed'),'true');}
async function visibleGuideCTA(view,scenario){
 // Bounding boxes do not scroll the button into view. A hidden/clipped initial CTA must fail.
 const [button,sidebar]=await Promise.all([view.locator('.selected-route-actions button.primary').boundingBox(),view.locator('.sidebar').boundingBox()]);
 const viewport=view.viewportSize();
 assert.ok(button&&sidebar&&viewport,scenario+': guide CTA and sidebar must be rendered');
 assert.ok(button.x>=Math.max(0,sidebar.x)-1&&button.y>=Math.max(0,sidebar.y)-1&&button.x+button.width<=Math.min(viewport.width,sidebar.x+sidebar.width)+1&&button.y+button.height<=Math.min(viewport.height,sidebar.y+sidebar.height)+1,scenario+': guide CTA must be inside the sidebar and viewport before any auto-scroll');
 const uncovered=await view.locator('.selected-route-actions button.primary').evaluate(element=>{const box=element.getBoundingClientRect(),hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);return hit===element||element.contains(hit);});
 assert.equal(uncovered,true,scenario+': guide CTA must not be clipped or covered');
 checks.push({name:scenario+' guide CTA is immediately visible',button,sidebar,viewport});
}
async function guide(view,candidate,name){
 await choose(view,candidate);const start=view.getByRole('button',{name:'길안내 시작',exact:true});assert.equal(await start.isEnabled(),true,'Pending/unknown photos must not gate ordinary guidance');
 await start.click();await view.locator('.navigation-panel').waitFor();
 const step=await view.locator('.navigation-panel h3').innerText();assert.ok(step.trim());
 const layout=await view.locator('.navigation-panel').evaluate(element=>{const nav=element.getBoundingClientRect(),map=document.querySelector('.map-area').getBoundingClientRect(),heading=element.querySelector('h3'),box=heading.getBoundingClientRect(),hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);return {withinMap:nav.top>=map.top&&nav.bottom<=map.bottom,headingExposed:hit===heading||heading.contains(hit)};});
 assert.equal(layout.withinMap,true,name+': current instructions must fit inside the map rather than behind the route list');
 assert.equal(layout.headingExposed,true,name+': current movement instruction must not be covered');
 const actions=view.locator('.nav-actions button');
 if(await actions.last().isEnabled()){
  await actions.last().click();assert.equal(await actions.first().isEnabled(),true,'Previous step must be usable after advancing');
 }
 assert.equal(await actions.evaluateAll(buttons=>buttons.filter(button=>!button.disabled).every(button=>{const box=button.getBoundingClientRect(),hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);return hit===button||button.contains(hit);})),true,name+': enabled movement controls must not be covered by map overlays');
 await capture(view,name);await view.getByRole('button',{name:'경로 안내 닫기',exact:true}).click();
 return step;
}
async function selectPlace(view,field,query){
 const input=view.getByRole('combobox',{name:field,exact:true});await input.fill(query);
 await view.getByRole('button',{name:field+' 검색',exact:true}).click();
 await view.getByRole('option').filter({hasText:query}).first().click();
}
await page.route('**/api/action',async route=>{
 const body=route.request().postDataJSON();
 if(body.action==='advance'){advanceHeld++;await release.promise;return route.abort().catch(()=>{});}
 if(body.action==='journey')inputs={start:body.start,end:body.end};
 const response=await route.fetch();
 if(!['journey','status','cancel'].includes(body.action))return route.fulfill({response});
 const data=await response.json();if(data.jobId){jobs.add(data.jobId);if(body.action==='cancel')canceled.add(data.jobId);}
 if(body.action==='journey')initial=structuredClone(data);
 return route.fulfill({response,json:data});
});
try{
 await page.goto(base,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>[...document.querySelectorAll('.map img')].some(image=>image.complete&&image.naturalWidth>=128&&image.naturalHeight>=128),null,{timeout:45000});
 await selectPlace(page,'출발지','경희대학교 국제캠퍼스 예술디자인대학관');
 await selectPlace(page,'도착지','맥도날드 경희대국제캠퍼스점');
 assert.equal(await page.getByRole('button',{name:'경로 찾기',exact:true}).isVisible(),true,'Selecting a destination must keep route search visible without manually reopening the panel');
 assert.equal(await page.getByRole('button',{name:'경로 찾기',exact:true}).isEnabled(),true);
 await page.getByRole('button',{name:'경로 찾기',exact:true}).click();await page.locator('.route-card').first().waitFor({timeout:90000});
 assert.ok(initial?.jobId&&initial.journey.routes.length,'A fresh actual provider journey is required');
 assert.equal(initial.phase,'running','This case must exercise pending analysis, not a completed or cached verdict');
 assert.equal(Object.values(initial.journey.evidence).some(item=>item.finding),false,'No new model finding belongs to this no-inference case');
 const candidates=initial.journey.routes,complete=candidates.find(candidate=>!blocked(candidate,initial.journey));assert.ok(complete,'Actual scenario must have a complete nonblocked walking route');
 const startOffset=meters(inputs.start.coord,complete.coords[0]),endOffset=meters(inputs.end.coord,complete.coords.at(-1));
 assert.ok(startOffset>=45&&startOffset<=65,`The actual POI centroid regression requires its approximately 54m walk-path offset; got ${startOffset.toFixed(1)}m`);
 await visibleGuideCTA(page,'initial desktop result');
 await capture(page,'desktop-pending-results');
 const firstStep=await guide(page,complete,'desktop-pending-guide');
 assert.equal(await page.getByRole('button',{name:'중지',exact:true}).isVisible(),true,'Guidance must start while photo analysis is still pending');
 checks.push({name:'approximately 54m POI centroid offset does not block ordinary guidance',startOffsetMeters:startOffset,endOffsetMeters:endOffset,routeId:complete.id,firstStep});
 const west=candidates.find(candidate=>candidate.crossingChoice&&candidate.steps.some(step=>/서천/.test(step.text)));
 assert.ok(west,'Actual provider routing must expose the existing west 서천 crossing alternative');
 assert.match(west.name,/서천/,'The selectable alternative must use an actual named crossing, not an anonymous count');
 assert.equal(blocked(west,initial.journey),false,'The west alternative must be guidable when no actual obstacle or partial segment is present');
 await guide(page,west,'desktop-west-seocheon-guide');
 checks.push({name:'actual named west 서천 alternative remains selectable and guidable',id:west.id,name:west.name,distance:west.distance,crossingChoice:west.crossingChoice});
 await choose(page,west);await page.locator('.route-card.selected .route-detail-button').click();
 await page.locator('.detail-body').waitFor();await capture(page,'desktop-details');
 await page.getByRole('button',{name:'경로 목록으로',exact:true}).click();
 assert.equal(await page.evaluate(()=>document.activeElement?.matches('.route-detail-button')),true);
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await visibleGuideCTA(page,'mobile result');
 await capture(page,'mobile-pending-results');await guide(page,west,'mobile-pending-guide');
 await page.locator('.route-card.selected .route-detail-button').click();await page.locator('.detail-body').waitFor();await capture(page,'mobile-details');
 await page.getByRole('button',{name:'경로 목록으로',exact:true}).click();
 await page.getByRole('button',{name:'중지',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.progress button'));
 const attribution=page.locator('.sidebar-footer.source-attribution');
 assert.equal(await attribution.isVisible(),true,'Mobile attribution must remain visible, not display:none');
 assert.match(await attribution.innerText(),/NAVER/);assert.match(await attribution.innerText(),/OpenStreetMap/);
 await attribution.scrollIntoViewIfNeeded();await capture(page,'mobile-source-attribution');
 checks.push({name:'mobile legal source attribution remains available',visible:true});
 release.resolve();assert.ok(advanceHeld>0,'At least one real advance request must have been held, never forwarded');

 for(const kind of ['provider-stairs','physical-barrier','blocked-passage','partial-graph','unknown-wrong-target']){
  const fixture=structuredClone(initial),target=fixture.journey.routes.find(candidate=>candidate.id===complete.id),assessment=fixture.journey.assessments[target.id],sample=target.samples[Math.floor(target.samples.length/2)];
  assert.ok(sample,'Controlled obstacle UI requires an actual sample location');fixture.phase='limited';
  if(kind==='provider-stairs'||kind==='physical-barrier'){
   const issue={id:target.id+':'+sample.id,sampleId:sample.id,coord:sample.coord,along:sample.along,status:'blocked',source:kind==='provider-stairs'?'provider':'imagery',reason:'CONTROLLED UI ONLY — stairs/physical barrier; no real photo observation',action:'CONTROLLED UI ONLY — use another route'};
   assessment.decision.issues=assessment.decision.issues.filter(item=>item.id!==issue.id).concat(issue);
   if(kind==='provider-stairs')target.barriers=[...(target.barriers??[]),{sampleId:sample.id,coord:sample.coord,along:sample.along,reason:issue.reason,source:'provider'}];
  }else if(kind==='blocked-passage')assessment.blockedPassageIds=['controlled-ui-only-actual-barrier-overlap'];
  else if(kind==='partial-graph')target.graphSegment={provider:'openstreetmap',snapshotAt:new Date().toISOString(),startGapMeters:54,endGapMeters:19,sharedRoadMeters:0};
  else{
   sample.target='crossing-entry';
   const id=target.id+':'+sample.id,reason='CONTROLLED UI ONLY — 사진의 관찰 대상이 필요한 연결부와 일치하지 않습니다.';
   assessment.decision.issues=assessment.decision.issues.filter(issue=>issue.id!==id).concat({id,sampleId:sample.id,coord:sample.coord,along:sample.along,status:'unknown',source:'imagery',reason,action:'같은 연결부의 다른 촬영 위치를 확인하세요.'});
   fixture.journey.evidence[id]={stage:'processed',sampleId:sample.id,status:'unknown',reason,checkedAt:new Date().toISOString(),finding:{status:'clear',reason:'CONTROLLED UI ONLY — intentionally wrong-target positive observation',evidence:[],limitations:['CONTROLLED UI ONLY'],pathVisible:true,visibility:'visible',routeMatch:'same-path',observation:{connection:'flush',surface:'continuous',uncertainty:'none',target:'sidewalk',reason:'CONTROLLED UI ONLY — not the required crossing entry'}}};
  }
  assessment.admission=assessRouteAdmission({route:target,decision:assessment.decision,blockedPassageIds:assessment.blockedPassageIds,maxSlope:fixture.journey.maxSlope});
  const controlled=await context.newPage();await controlled.setViewportSize({width:1440,height:960});
  await controlled.route('**/api/action',async route=>{
   const body=route.request().postDataJSON();
   if(body.action==='journey')return route.fulfill({json:fixture});
   if(body.action==='advance')throw new Error('Controlled terminal UI state must never start analysis');
   if(body.action==='cancel')return route.fulfill({json:{...fixture,phase:'canceled'}});
   return route.continue();
  });
  try{
   await controlled.goto(base,{waitUntil:'domcontentloaded'});
   await controlled.waitForFunction(()=>[...document.querySelectorAll('.map img')].filter(image=>{try{return /(^|\.)(?:pstatic\.net|naver\.com|naver\.net|navermaps\.com)$/.test(new URL(image.currentSrc||image.src).hostname)&&image.complete&&image.naturalWidth>=128&&image.naturalHeight>=128;}catch{return false;}}).length>=2,null,{timeout:45000});
   await controlled.locator('#from').fill(inputs.start.name);await controlled.locator('#to').fill(inputs.end.name);
   await controlled.locator('.search-button').click();await controlled.locator('.route-card').first().waitFor({timeout:30000});
   await controlled.evaluate(kind=>{const banner=document.createElement('div');banner.textContent='CONTROLLED UI ONLY — '+kind+'; not an actual route/AI finding';banner.dataset.controlledUiOnly='true';banner.style.cssText='position:fixed;bottom:0;left:0;right:0;z-index:99999;background:#fff3cd;padding:10px;text-align:center';document.body.append(banner);},kind);
   await choose(controlled,target);
   if(kind==='unknown-wrong-target'){
    await (await crossingPointControl(controlled,target.id+':'+sample.id)).click();
    await controlled.locator('.detail-body').waitFor();
    const row=controlled.locator('.detail-point.focused .detail-reason');
    assert.match(await row.innerText(),/관찰 대상이 필요한 연결부와 일치하지/);
    assert.doesNotMatch(await row.innerText(),/단차 없이 이어지는|연결 경사로와 이어지는/,'An unknown wrong-target row must not expose a positive raw observation as route evidence');
    assert.equal(await controlled.getByRole('button',{name:'길안내 시작',exact:true}).isEnabled(),true,'Unknown observation mismatch is not a known physical obstacle');
   }else{
    assert.equal(await controlled.locator('.selected-route-actions button.primary').isDisabled(),true,'Known obstacles and actual partial graph segments must still block guidance');
    assert.equal(await controlled.locator('.navigation-panel').count(),0);
    await controlled.locator('.route-card.selected .route-detail-button').click();await controlled.locator('.detail-body').waitFor();
    if(kind!=='partial-graph')assert.equal(await controlled.locator('.route-details button.primary').isDisabled(),true);
    assert.equal(await controlled.getByRole('button',{name:'길안내 시작',exact:true}).count(),0,'Blocked details must not offer a guide start');
   }
   await capture(controlled,'controlled-'+kind+'-details');
   await controlled.getByRole('button',{name:'경로 목록으로',exact:true}).click();
   if(kind==='unknown-wrong-target')await guide(controlled,target,'controlled-unknown-wrong-target-guide');
   const alternative=fixture.journey.routes.find(candidate=>candidate.id!==target.id&&!blocked(candidate,fixture.journey));assert.ok(alternative,'Controlled state must preserve a usable alternative');
   await guide(controlled,alternative,'controlled-'+kind+'-alternative-guide');
   checks.push({name:kind==='unknown-wrong-target'?'controlled unknown wrong-target row avoids positive raw observation and still permits ordinary guidance':'controlled '+kind+' blocks only affected route and preserves alternative guidance',controlledUIOnly:true,findingsInjected:kind==='unknown-wrong-target'?'explicitly labeled fabricated wrong-target observation; not a real AI result':false,targetId:target.id,alternativeId:alternative.id});
  }finally{await controlled.close();}
 }
 const malformed=await context.newPage();let attempts=0;
 const recovered=structuredClone(initial);recovered.phase='limited';
 await malformed.route('**/api/action',async route=>{
  const body=route.request().postDataJSON();
  if(body.action==='journey')return route.fulfill({json:++attempts===1?{jobId:'controlled-invalid-response',phase:'limited',journey:{}}:recovered});
  if(body.action==='cancel')return route.fulfill({json:{...recovered,phase:'canceled'}});
  if(body.action==='advance')throw new Error('Malformed-response UI case must never start analysis');
  return route.continue();
 });
 try{
  await malformed.goto(base,{waitUntil:'domcontentloaded'});
  await malformed.waitForFunction(()=>[...document.querySelectorAll('.map img')].filter(image=>{try{return /(^|\.)(?:pstatic\.net|naver\.com|naver\.net|navermaps\.com)$/.test(new URL(image.currentSrc||image.src).hostname)&&image.complete&&image.naturalWidth>=128&&image.naturalHeight>=128;}catch{return false;}}).length>=2,null,{timeout:45000});
  await malformed.locator('#from').fill(inputs.start.name);await malformed.locator('#to').fill(inputs.end.name);
  await malformed.locator('.search-button').click();await malformed.getByRole('alert').waitFor();
  assert.doesNotMatch(await malformed.getByRole('alert').innerText(),/Zod|invalid_|received|unverifiedConnections|"journey"/);
  await malformed.getByRole('button',{name:'다시 찾기',exact:true}).click();
  await malformed.getByRole('button',{name:complete.name+' 선택',exact:true}).waitFor();
  assert.equal(attempts,2,'The customer retry must recover the preserved journey inputs');
  checks.push({name:'controlled malformed response hides schema diagnostics and retry recovers routes',controlledUIOnly:true});
 }finally{await malformed.close();}
 assert.deepEqual(errors,[]);report.status='passed';
}catch(error){report.failure=String(error.message??error);process.exitCode=1;await capture(page,'failure').catch(()=>{});}
finally{
 release.resolve();
 for(const jobId of jobs)if(!canceled.has(jobId))try{await cancel(jobId);}catch(error){errors.push(String(error.message));}
 report.jobs={created:jobs.size,canceled:canceled.size};if(errors.length||jobs.size!==canceled.size){report.status='failed';process.exitCode=1;}
 report.finishedAt=new Date().toISOString();await writeFile(output+'/report.json',JSON.stringify(report,null,2));
 await context.close();await browser.close();console.log(JSON.stringify(report));
}
