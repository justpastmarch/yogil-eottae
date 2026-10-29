import {chromium} from '../services/roadview-renderer/node_modules/playwright/index.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

const base=process.env.PERSONA_BASE_URL??'http://localhost:3000/';
const output=process.env.PERSONA_REPORT_DIR??'.sites-runtime/persona-eval/verification';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--enable-webgl','--ignore-gpu-blocklist']});
const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage(),errors=[];
page.on('pageerror',error=>errors.push(error.message));
let heldJourney,heldAdvance,failJourney=false,failStatusOnce=true,statusFailures=0,cancelCalls=0;
let releaseJourney=Promise.withResolvers(),releaseAdvance=Promise.withResolvers();
await page.route('**/api/action',async route=>{
 let body;try{body=route.request().postDataJSON();}catch{return route.continue();}
 if(body.action==='journey'&&heldJourney){await releaseJourney.promise;return route.abort().catch(()=>{});}
 if(body.action==='journey'&&failJourney)return route.fulfill({status:503,json:{error:'길찾기 서비스를 잠시 이용할 수 없습니다.'}});
 if(body.action==='status'&&heldAdvance&&failStatusOnce){failStatusOnce=false;statusFailures++;return route.fulfill({status:503,json:{error:'상태 확인 실패'}});}
 if(body.action==='cancel')cancelCalls++;
 if(body.action==='advance'&&heldAdvance){await releaseAdvance.promise;return route.abort().catch(()=>{});}
 return route.continue();
});
try{
 await page.goto(base,{waitUntil:'networkidle'});
 await page.addInitScript(()=>Object.defineProperty(navigator,'geolocation',{configurable:true,value:{getCurrentPosition(_success,error){error({code:1,message:'permission denied'});}}}));
 await page.reload({waitUntil:'networkidle'});
 const start=await page.locator('#from').inputValue(),end=await page.locator('#to').inputValue();
 heldJourney=true;
 await page.locator('.search-button').click();
 await page.getByRole('button',{name:'검색 중지'}).waitFor({timeout:30000});
 await page.getByRole('button',{name:'검색 중지'}).click();
 await page.getByRole('alert').filter({hasText:'검색을 중지'}).waitFor();
 await page.waitForFunction(()=>document.activeElement?.matches('[role=alert]')&&document.activeElement.textContent.includes('검색을 중지'));
 assert.equal(await page.locator('#from').inputValue(),start);assert.equal(await page.locator('#to').inputValue(),end);
 heldJourney=false;releaseJourney.resolve();
 heldAdvance=true;
 if(!await page.locator('.search-button').isVisible())await page.locator('.results-controls button').click();
 await page.locator('.search-button').click();
 await page.locator('.route-card').first().waitFor({timeout:60000});
 const progress=page.getByRole('button',{name:'중지',exact:true});
 await progress.waitFor();await page.getByRole('status').filter({hasText:'진행 상태를 잠시 확인하지 못했습니다'}).waitFor({timeout:10000});
 assert.equal(cancelCalls,0,'A read-only status failure must not cancel the running analysis');
 await progress.click();
 await page.waitForFunction(()=>!document.querySelector('.progress button'));
 await page.waitForFunction(()=>document.activeElement?.matches('.notice[role=status]')&&document.activeElement.textContent.includes('중지'));
 heldAdvance=false;releaseAdvance.resolve();
 const before=await page.locator('.route-card').count();assert.ok(before>0);
 const list=await page.locator('.results-scroll').boundingBox(),map=await page.locator('.map-area').boundingBox();
 assert.ok(list&&list.height>=200,`Mobile results viewport too small: ${list?.height}`);
 assert.ok(map&&map.height>=180,`Mobile map too small: ${map?.height}`);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.equal(await page.locator('.legend-entries').isVisible(),false);
 await page.getByRole('button',{name:'통행 상태 범례 보기'}).click();
 assert.equal(await page.locator('.legend-entries').isVisible(),true);
 await page.getByRole('button',{name:'통행 상태 범례 접기'}).click();
 await page.screenshot({path:output+'/mobile-results.png'});
 await page.locator('.locate').click();
 await page.getByRole('alert').filter({hasText:'현재 위치를 찾지 못했습니다'}).waitFor();
 assert.equal(await page.locator('.route-card').count(),before,'Location denial must not discard existing routes');
 await page.getByRole('button',{name:'위치 안내 닫기'}).click();
 assert.equal(await page.evaluate(()=>document.activeElement?.matches('.locate')),true,'Dismissal restores focus to the location control');
 await page.getByRole('button',{name:'출발지·도착지 및 조건 변경'}).click();
 await page.locator('.search-button').scrollIntoViewIfNeeded();
 failJourney=true;await page.locator('.search-button').click();
 await page.getByRole('alert').filter({hasText:'이전 결과'}).waitFor({timeout:30000});
 assert.equal(await page.locator('.route-card').count(),before,'Failed retry must retain previous candidates');
 await page.screenshot({path:output+'/failed-retry.png'});
 await page.setViewportSize({width:640,height:360});
 await page.locator('.route-detail-button').first().click();
 const detail=await page.locator('.detail-body').boundingBox();
 assert.ok(detail&&detail.height>=80,`Enlarged-view detail area too small: ${detail?.height}`);
 const issue=page.locator('.action-issue').first();await issue.scrollIntoViewIfNeeded();await issue.click();
 await page.waitForFunction(()=>document.activeElement?.matches('.detail-point.focused, .action-issue.focused'));
 await page.screenshot({path:output+'/short-viewport-detail.png'});
 const desktop=await browser.newPage({viewport:{width:1440,height:900}});
 await desktop.goto(base,{waitUntil:'networkidle'});
 await desktop.evaluate(()=>{document.documentElement.style.zoom='200%';});
 await desktop.locator('#from').fill('영통역');
 await desktop.locator('#from-suggestions [role=option]').first().waitFor({timeout:20000});
 for(let i=0;i<5;i++)await desktop.locator('#from').press('ArrowDown');
 const selected=await desktop.locator('#from').getAttribute('aria-activedescendant');assert.ok(selected);
 const visible=await desktop.locator('#'+selected).evaluate(option=>{const o=option.getBoundingClientRect(),list=option.closest('.search-results').getBoundingClientRect();return o.top>=list.top&&o.bottom<=list.bottom;});
 assert.equal(visible,true,'Keyboard-selected search result must remain visible in the list');
 await desktop.screenshot({path:output+'/keyboard-active.png'});
 const racePage=await browser.newPage({viewport:{width:1440,height:900}}),statusEntered=Promise.withResolvers(),releaseStatus=Promise.withResolvers();
 let jobId;
 racePage.on('response',async response=>{if(!response.url().endsWith('/api/action'))return;try{const data=await response.json();if(data.jobId)jobId=data.jobId;}catch{}});
 await racePage.route('**/api/action',async route=>{
  let body;try{body=route.request().postDataJSON();}catch{return route.continue();}
  if(body.action==='status'){statusEntered.resolve();await releaseStatus.promise;return route.abort().catch(()=>{});}
  if(body.action==='advance'){
   await statusEntered.promise;
   const canceled=await racePage.request.post(new URL('/api/action',base).href,{data:{action:'cancel',jobId:body.jobId}});
   return route.fulfill({status:canceled.status(),body:await canceled.body(),headers:{'content-type':'application/json'}});
  }
  return route.continue();
 });
 try{
  await racePage.goto(base,{waitUntil:'networkidle'});await racePage.locator('.search-button').click();
  await statusEntered.promise;
  await racePage.locator('.notice[role="status"]').waitFor({timeout:10000});
  assert.equal(await racePage.getByRole('button',{name:'중지',exact:true}).count(),0,'A held status poll must not hide a completed advance result');
  await racePage.screenshot({path:output+'/held-status-terminal.png'});
 }finally{
  releaseStatus.resolve();
  if(jobId)await racePage.request.post(new URL('/api/action',base).href,{data:{action:'cancel',jobId}}).catch(()=>{});
  await racePage.close();
 }
 const stopRacePage=await browser.newPage({viewport:{width:1440,height:900}}),releaseStopAdvance=Promise.withResolvers();
 await stopRacePage.route('**/api/action',async route=>{
  let body;try{body=route.request().postDataJSON();}catch{return route.continue();}
  if(body.action==='advance'){await releaseStopAdvance.promise;return route.abort().catch(()=>{});}
  if(body.action==='cancel'){
   const response=await stopRacePage.request.post(new URL('/api/action',base).href,{data:body});
   const snapshot=await response.json();snapshot.phase='limited';
   return route.fulfill({json:snapshot});
  }
  return route.continue();
 });
 try{
  await stopRacePage.goto(base,{waitUntil:'networkidle'});
  assert.equal(await stopRacePage.locator('#profile').count(),0,'Mobility-profile selection is outside the requested product scope');
  await stopRacePage.locator('.search-button').click();
  const stop=stopRacePage.getByRole('button',{name:'중지',exact:true});await stop.waitFor({timeout:30000});
  await stop.focus();await stop.press('Enter');
  await stopRacePage.waitForFunction(()=>document.activeElement?.matches('.routes-section h2'));
  const candidates=stopRacePage.locator('.route-select');let previewChecked=false;
  for(let index=0;index<await candidates.count();index++){
   await candidates.nth(index).click();
   if(await stopRacePage.locator('.walking-preview').count()){
    await stopRacePage.locator('.walking-preview').click();
    await stopRacePage.getByRole('status').filter({hasText:'선택한 이동 수단의 통행을 권장하는 안내가 아닙니다'}).waitFor();
    previewChecked=true;
    break;
   }
  }
  assert.equal(previewChecked,true,'Walking preview must remain explicitly non-accessibility guidance');
  await stopRacePage.screenshot({path:output+'/stop-completion-race.png'});
 }finally{releaseStopAdvance.resolve();await stopRacePage.close();}
 const previewPage=await browser.newPage({viewport:{width:1440,height:900}}),releasePreview=Promise.withResolvers();
 let previewSnapshot,previewIndex=0;
 await previewPage.route('**/api/action',async route=>{
  let body;try{body=route.request().postDataJSON();}catch{return route.continue();}
  if(body.action==='journey'){
   const response=await route.fetch();previewSnapshot=await response.json();
   return route.fulfill({response,json:previewSnapshot});
  }
  if(body.action==='advance'){
   await releasePreview.promise;
   const finished=structuredClone(previewSnapshot),id=finished.journey.routes[previewIndex].id;
   finished.phase='ready';finished.journey.recommendedId=id;finished.journey.assessments[id].decision.kind='recommended';
   return route.fulfill({json:finished}).catch(()=>{});
  }
  return route.continue();
 });
 try{
  await previewPage.goto(base,{waitUntil:'networkidle'});await previewPage.locator('.search-button').click();
  const candidates=previewPage.locator('.route-select');await candidates.first().waitFor({timeout:30000});
  let opened=false;
  for(previewIndex=0;previewIndex<await candidates.count();previewIndex++){
   await candidates.nth(previewIndex).click();
   if(await previewPage.locator('.walking-preview').count()){await previewPage.locator('.walking-preview').click();opened=true;break;}
  }
  assert.equal(opened,true,'A real route must allow a walking preview for this scenario');
  await previewPage.getByRole('status').filter({hasText:'일반 도보 순서 미리보기'}).waitFor();
  releasePreview.resolve();
  await previewPage.waitForFunction(()=>!document.querySelector('.progress button'),{timeout:30000});
  assert.equal(await previewPage.getByRole('status').filter({hasText:'일반 도보 순서 미리보기'}).count(),1,'A later recommendation must not silently turn a preview into accessibility guidance');
  await previewPage.screenshot({path:output+'/preview-stability.png'});
 }finally{
  releasePreview.resolve();
  if(previewSnapshot?.jobId)await previewPage.request.post(new URL('/api/action',base).href,{data:{action:'cancel',jobId:previewSnapshot.jobId}}).catch(()=>{});
  await previewPage.close();
 }
 assert.deepEqual(errors,[]);
 const result={kind:'Live search and routing, browser-injected held requests, 503, synthetic terminal and recommendation responses and location permission denial; no AI inference',initialCancellation:true,inputsPreserved:true,priorCandidates:before,mobileResultsHeight:list.height,mobileMapHeight:map.height,locationDenialPreservesResults:true,failedRetryPreservesResults:true,transientStatusFailures:statusFailures,terminalAdvanceWinsHeldStatus:true,syntheticTerminalStopRaceFocus:true,stopRacePreviewWarning:true,previewStaysPreview:true,keyboardActiveOptionVisible:true,shortViewportDetailHeight:detail.height,stopFocusRestored:true,collapsibleLegend:true,zoom:'CSS 200% approximation',errors};
 await writeFile(output+'/result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{releaseJourney.resolve();releaseAdvance.resolve();await context.close();await browser.close();}
