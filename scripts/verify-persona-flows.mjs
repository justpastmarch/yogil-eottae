import {routeGuideBlocked} from '../app/route-presentation.ts';
import {chromium} from '../services/roadview-renderer/node_modules/playwright/index.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

const base=process.env.PERSONA_BASE_URL??'http://localhost:3000/';
const output=process.env.PERSONA_REPORT_DIR??'.sites-runtime/persona-eval/verification';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--enable-webgl','--ignore-gpu-blocklist']});
const context=await browser.newContext({viewport:{width:390,height:844}}),errors=[],jobs=new Set(),canceled=new Set();
const entranceBoundary={mode:'CONTROLLED TECHNICAL FAILURE',httpStatus:503,requests:0,actualEntranceAnalysis:false};
await context.route('**/api/entrance',route=>{entranceBoundary.requests++;return route.fulfill({status:503,json:{error:'CONTROLLED TECHNICAL FAILURE: entrance service withheld; no image analysis performed'}});});
const gates=[],checks=[];
const gate=()=>{const value=Promise.withResolvers();gates.push(value);return value;};
const check=(name,evidence)=>checks.push({name,evidence});
async function cancel(jobId){
 const response=await context.request.post(new URL('/api/action',base).href,{data:{action:'cancel',jobId}});
 assert.ok(response.ok(),'The created journey must be canceled without forwarding analysis');
 canceled.add(jobId);return response.json();
}
async function label(page,text){
 await page.evaluate(text=>{const banner=document.createElement('div');banner.dataset.controlledUiOnly='true';banner.textContent='CONTROLLED UI ONLY — '+text+'; no new imagery or accessibility findings';banner.style.cssText='position:fixed;bottom:0;left:0;right:0;z-index:99999;background:#fff3cd;color:#402800;font:12px sans-serif;padding:8px;text-align:center';document.body.append(banner);},text);
}
async function newPage(state={}){
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 state.journeyGate=gate();state.advanceGate=gate();
 await page.route('**/api/action',async route=>{
  let body;try{body=route.request().postDataJSON();}catch{return route.continue();}
  if(body.action==='journey'&&state.holdJourney){await state.journeyGate.promise;return route.abort().catch(()=>{});}
  if(body.action==='journey'&&state.failJourney)return route.fulfill({status:503,json:{error:'길찾기 서비스를 잠시 이용할 수 없습니다.'}});
  if(body.action==='status'&&state.failStatusOnce){state.failStatusOnce=false;state.statusFailures=(state.statusFailures??0)+1;return route.fulfill({status:503,json:{error:'controlled transient status failure'}});}
  if(body.action==='status'&&state.statusGate){state.statusEntered.resolve();await state.statusGate.promise;return route.abort().catch(()=>{});}
  if(body.action==='advance'){
   if(state.advance)return state.advance(route,body);
   await state.advanceGate.promise;return route.abort().catch(()=>{});
  }
  const response=await route.fetch();
  if(!['journey','cancel','status'].includes(body.action))return route.fulfill({response});
  const data=await response.json();
  if(data.jobId){jobs.add(data.jobId);if(body.action==='cancel')canceled.add(data.jobId);state.snapshot=data;}
  if(body.action==='journey')state.initial=structuredClone(data);
  return route.fulfill({response,json:data});
 });
 return page;
}
async function ready(page){
 await page.waitForFunction(()=>[...document.querySelectorAll('.map img')].filter(image=>{try{return /(^|\.)(?:pstatic\.net|naver\.com|naver\.net|navermaps\.com)$/.test(new URL(image.currentSrc||image.src).hostname)&&image.complete&&image.naturalWidth>=128&&image.naturalHeight>=128;}catch{return false;}}).length>=2,null,{timeout:45000});
}
async function begin(page){
 await page.goto(base,{waitUntil:'domcontentloaded'});
 await ready(page);
 await page.locator('#from').fill('경희대학교 국제캠퍼스 예술디자인대학관');
 await page.locator('#to').fill('맥도날드 경희대국제캠퍼스점');
 await page.locator('.search-button').click();
 await page.locator('.route-card').first().waitFor({timeout:90000});
 await page.locator('.place-entrance [role=alert]').waitFor();assert.equal(await page.locator('.place-entrance .entrance-photos').count(),0,'A controlled service failure must not invent entrance photos or a verdict');
}
const guideable=(route,journey)=>!routeGuideBlocked(journey.assessments[route.id]);
async function selectedName(page){return page.locator('.route-card.selected .route-select').getAttribute('aria-label');}

try{
 const state={holdJourney:true},page=await newPage(state);
 await page.addInitScript(()=>Object.defineProperty(navigator,'geolocation',{configurable:true,value:{getCurrentPosition(_success,error){error({code:1,message:'permission denied'});}}}));
 await page.goto(base,{waitUntil:'domcontentloaded'});
 await ready(page);
 const start=await page.locator('#from').inputValue(),end=await page.locator('#to').inputValue();
 await page.locator('.search-button').click();
 await page.getByRole('button',{name:'검색 중지',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'검색을 중지'}).waitFor();
 await page.waitForFunction(()=>document.activeElement?.matches('[role=alert]'));
 assert.equal(await page.locator('#from').inputValue(),start);assert.equal(await page.locator('#to').inputValue(),end);
 state.holdJourney=false;state.journeyGate.resolve();state.failStatusOnce=true;
 check('canceling initial search preserves input and focuses notice',true);
 await begin(page);
 await page.waitForFunction(()=>!!document.querySelector('.progress button'));
 // The failed read is intentionally silent to the customer. Continued polling/progress, not diagnostic wording, proves recovery.
 await page.waitForResponse(response=>{try{return response.url().endsWith('/api/action')&&response.request().postDataJSON().action==='status'&&response.ok();}catch{return false;}},{timeout:15000});
 assert.equal(state.statusFailures,1);assert.equal(canceled.size,0,'A read-only status failure must not cancel analysis');
 await page.getByRole('button',{name:'중지',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('.progress button'));
 await page.waitForFunction(()=>document.activeElement?.matches('.notice[role=status]'));
 state.advanceGate.resolve();
 const before=await page.locator('.route-card').count();assert.ok(before>0);
 const list=await page.locator('.results-scroll').boundingBox(),map=await page.locator('.map-area').boundingBox();
 assert.ok(list&&list.height>=200,'Mobile result list must remain usable');assert.ok(map&&map.height>=180,'Mobile map must remain usable');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.getByRole('button',{name:'통행 상태 범례 보기',exact:true}).click();
 assert.equal(await page.locator('.legend-entries').isVisible(),true);
 await page.getByRole('button',{name:'통행 상태 범례 접기',exact:true}).click();
 assert.equal(await page.locator('.legend-entries').isVisible(),false);
 await page.screenshot({path:output+'/mobile-results.png'});
 await page.locator('.locate').click();await page.getByRole('alert').filter({hasText:'현재 위치를 찾지 못했습니다'}).waitFor();
 assert.equal(await page.locator('.route-card').count(),before);
 await page.getByRole('button',{name:'위치 안내 닫기',exact:true}).click();
 assert.equal(await page.evaluate(()=>document.activeElement?.matches('.locate')),true);
 check('mobile layout, location denial and focus recovery',{listHeight:list.height,mapHeight:map.height});
 await page.getByRole('button',{name:'출발지·도착지 및 조건 변경',exact:true}).click();
 state.failJourney=true;await page.locator('.search-button').click();
 await page.getByRole('alert').filter({hasText:'이전 결과'}).waitFor({timeout:30000});
 assert.equal(await page.locator('.route-card').count(),before);
 await page.screenshot({path:output+'/failed-retry.png'});
 await page.setViewportSize({width:640,height:360});
 await page.locator('.route-detail-button').first().click();
 const detail=await page.locator('.detail-body').boundingBox();assert.ok(detail&&detail.height>=80);
 await page.waitForFunction(()=>document.activeElement?.matches('.detail-title h2'));
 await page.screenshot({path:output+'/short-viewport-detail.png'});
 await page.getByRole('button',{name:'경로 목록으로',exact:true}).click();
 assert.equal(await page.evaluate(()=>document.activeElement?.matches('.route-detail-button')),true);
 check('failed retry preserves candidates; details and back work without pending markers',{candidates:before,detailHeight:detail.height});

 const keyboard=await newPage();await keyboard.setViewportSize({width:1440,height:900});
 await keyboard.goto(base,{waitUntil:'domcontentloaded'});await ready(keyboard);await keyboard.evaluate(()=>{document.documentElement.style.zoom='200%';});
 await keyboard.locator('#from').fill('영통역');await keyboard.locator('#from-suggestions [role=option]').first().waitFor({timeout:20000});
 for(let index=0;index<5;index++)await keyboard.locator('#from').press('ArrowDown');
 const active=await keyboard.locator('#from').getAttribute('aria-activedescendant');assert.ok(active);
 assert.equal(await keyboard.locator('#'+active).evaluate(option=>{const box=option.getBoundingClientRect(),list=option.closest('.search-results').getBoundingClientRect();return box.top>=list.top&&box.bottom<=list.bottom;}),true);
 await keyboard.screenshot({path:output+'/keyboard-active.png'});check('keyboard search option stays visible at enlarged view',{zoom:'CSS 200% approximation'});

 const raceState={statusGate:gate(),statusEntered:gate()};
 raceState.advance=async(route,body)=>{await raceState.statusEntered.promise;const terminal=await cancel(body.jobId);return route.fulfill({json:terminal}).catch(()=>{});};
 const race=await newPage(raceState);await race.setViewportSize({width:1440,height:900});
 try{
  await begin(race);await raceState.statusEntered.promise;
  await race.locator('.notice[role=status]').waitFor({timeout:10000});
  assert.equal(await race.getByRole('button',{name:'중지',exact:true}).count(),0,'A held status request must not hide the terminal advance response');
  await race.screenshot({path:output+'/held-status-terminal.png'});check('terminal advance wins held status',true);
 }finally{raceState.statusGate.resolve();await race.close();}

 const stopState={},stop=await newPage(stopState);await stop.setViewportSize({width:1440,height:900});
 await stop.unroute('**/api/action');
 // Controlled cancel/terminal race: real route seed and canceled real job, only the terminal phase is changed.
 await stop.route('**/api/action',async route=>{
  const body=route.request().postDataJSON();
  if(body.action==='advance'){await stopState.advanceGate.promise;return route.abort().catch(()=>{});}
  const response=await route.fetch();if(!['journey','status','cancel'].includes(body.action))return route.fulfill({response});
  const data=await response.json();if(data.jobId){jobs.add(data.jobId);stopState.snapshot=data;}
  if(body.action==='cancel'){canceled.add(data.jobId);data.phase='limited';}
  return route.fulfill({response,json:data});
 });
 try{
  await begin(stop);const button=stop.getByRole('button',{name:'중지',exact:true});await button.focus();await button.press('Enter');
  await stop.waitForFunction(()=>document.activeElement?.matches('.routes-section h2'));
  const candidate=stopState.snapshot.journey.routes.find(route=>guideable(route,stopState.snapshot.journey));assert.ok(candidate,'Scenario must have a complete nonblocked route');
  await stop.getByRole('button',{name:candidate.name+' 선택',exact:true}).click();
  await stop.getByRole('button',{name:'길안내 시작',exact:true}).click();await stop.locator('.navigation-panel').waitFor();
  await label(stop,'cancel/terminal race');await stop.screenshot({path:output+'/stop-completion-race.png'});
  check('stop/terminal race restores keyboard focus and ordinary guidance remains available',true);
 }finally{stopState.advanceGate.resolve();await stop.close();}

 for(const mode of ['selection','guide']){
  const stability={release:gate()};
  stability.advance=async(route,body)=>{
   await stability.release.promise;const terminal=await cancel(body.jobId);
   const other=terminal.journey.routes.find(candidate=>candidate.id!==stability.chosen.id&&guideable(candidate,terminal.journey));
   assert.ok(other,'Stability control requires a different complete candidate');
   // A later response makes another nonblocked candidate fastest; no access or terrain evidence is invented.
   other.seconds=1;terminal.phase='limited';
   return route.fulfill({json:terminal}).catch(()=>{});
  };
  const view=await newPage(stability);await view.setViewportSize({width:1440,height:900});
  try{
   await begin(view);const journey=stability.initial.journey;
   stability.chosen=journey.routes.find(route=>guideable(route,journey));assert.ok(stability.chosen);
   await view.getByRole('button',{name:'빠른 시간 순',exact:true}).click();
   await view.getByRole('button',{name:stability.chosen.name+' 선택',exact:true}).click();
   const selected=await selectedName(view);let guidance;
   if(mode==='guide'){
    await view.getByRole('button',{name:'길안내 시작',exact:true}).click();await view.locator('.navigation-panel').waitFor();
    const next=view.locator('.nav-actions button').last();if(await next.count()&&await next.isEnabled())await next.click();
    guidance=await view.locator('.navigation-panel').innerText();
   }
   stability.release.resolve();await view.waitForFunction(()=>!document.querySelector('.progress button'),null,{timeout:30000});
   assert.equal(await selectedName(view),selected,'Later analysis must not replace an explicit route selection');
   if(mode==='guide')assert.equal(await view.locator('.navigation-panel').innerText(),guidance,'Later analysis must preserve the active guide and step');
   await label(view,'later response changes route ranking, '+mode+' stability');await view.screenshot({path:output+'/'+mode+'-stability.png'});
   check('later response preserves explicit '+mode,{routeId:stability.chosen.id,photoAnalysisForwarded:false});
  }finally{stability.release.resolve();await view.close();}
 }
 assert.deepEqual(errors,[]);
 assert.ok(entranceBoundary.requests>0,'Submitted trips must request entrance confirmation automatically');
 const result={kind:'Real search/routing with held advance; controlled entrance technical failures, network failures, terminal races, ranking updates and geolocation denial. No AI inference.',entranceBoundary,checks,errors};
 await writeFile(output+'/result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{
 for(const pending of gates)pending.resolve();
 try{for(const jobId of jobs)if(!canceled.has(jobId))await cancel(jobId);assert.equal(canceled.size,jobs.size,'Every created job must be canceled');}
 finally{await context.close();await browser.close();}
}
