import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from '../services/roadview-renderer/node_modules/playwright/index.mjs';

const base=process.env.MOBILITY_BASE_URL??'http://localhost:3000';
const controlled=process.env.MOBILITY_CONTROLLED_ERRORS==='1';
const output=process.env.MOBILITY_REPORT_DIR??'.sites-runtime/entrance-usability'+(controlled?'/controlled':'');
// Reuse genuine recorded photo bytes/observations; this driver never buys another AI analysis.
const archivePath=process.env.MOBILITY_ENTRANCE_EVIDENCE??'.sites-runtime/naver-migration/entrance-visual-qa/entrance-response.json';
const archived=controlled?null:await readFile(archivePath,'utf8').then(JSON.parse).catch(()=>{throw new Error('A genuine saved /api/entrance response including source photo bytes is required. Set MOBILITY_ENTRANCE_EVIDENCE; no live analysis is started as a fallback.');});
if(archived)assert.ok(archived.evidence?.length&&archived.evidence.every(photo=>photo.image?.data&&photo.source?.provider==='naver'),'Saved entrance response must contain genuine NAVER source photographs');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--enable-webgl','--ignore-gpu-blocklist']});
const context=await browser.newContext({viewport:{width:1440,height:960}}),page=await context.newPage(),errors=[],jobs=new Set(),canceled=new Set(),release=Promise.withResolvers();
const report={base,controlled,sourceMode:controlled?'CONTROLLED TECHNICAL FAILURE; not an AI result':'ARCHIVED GENUINE SOURCE REPLAY; no new AI analysis',archivePath:controlled?null:archivePath,status:'failed',checks:[],errors};
let latest,advanceHeld=0;
page.on('pageerror',error=>errors.push(error.message));
await page.addInitScript(()=>{
 const state={records:[]};Object.defineProperty(window,'__entrancePanoramas',{value:state});
 const discover=()=>{
  const sdk=window.naver?.maps;if(!sdk?.Panorama||sdk.Panorama.__entranceDriver)return;
  const Original=sdk.Panorama;
  const wrapped=new Proxy(Original,{construct(target,args,newTarget){
   const instance=Reflect.construct(target,args,newTarget),record={instance,options:args[1],initialized:false};state.records.push(record);
   sdk.Event.addListener(instance,'init',()=>{record.initialized=true;});return instance;
  }});
  Object.defineProperty(wrapped,'__entranceDriver',{value:true});sdk.Panorama=wrapped;
 };
 new MutationObserver(discover).observe(document,{childList:true,subtree:true});
 window.addEventListener('load',discover,true);
 state.snapshot=()=>{const last=state.records.at(-1);return last?{count:state.records.length,initialized:last.initialized,panoId:last.instance.getPanoId(),pov:last.instance.getPov(),options:last.options}:null;};
});
await page.route('**/api/action',async route=>{
 const body=route.request().postDataJSON();
 if(body.action==='advance'){advanceHeld++;await release.promise;return route.abort().catch(()=>{});}
 const response=await route.fetch();
 if(!['journey','status','cancel'].includes(body.action))return route.fulfill({response});
 const data=await response.json();
 if(data.jobId){jobs.add(data.jobId);if(body.action==='cancel')canceled.add(data.jobId);latest=data;}
 if(controlled&&body.action==='cancel'){
  data.phase='limited';data.progress.notice='CONTROLLED UI ONLY: analysis service unavailable (HTTP 402)';
  const candidate=data.journey.routes.find(route=>!route.graphSegment),sample=candidate?.samples[0];
  if(sample)data.journey.evidence[candidate.id+':'+sample.id]={sampleId:sample.id,stage:'processed',status:'unknown',failure:'analysis',reason:data.progress.notice,checkedAt:new Date().toISOString()};
 }
 return route.fulfill({response,json:data});
});
await page.route('**/api/entrance',async route=>{
 const {place}=route.request().postDataJSON();
 if(controlled)return route.fulfill({json:{place,verdict:'unknown',uncertainty:'technical',reason:'CONTROLLED UI ONLY: analysis credit failure (HTTP 402)',nextAction:'CONTROLLED UI ONLY: retry or contact the facility',checkedAt:new Date().toISOString(),model:'controlled-fixture',evidence:[],limitations:['CONTROLLED UI ONLY; not a genuine AI observation.']}});
 assert.equal(place.id,archived.place.id,'Archived source must belong to the actual selected place');
 assert.equal(place.name,archived.place.name);assert.deepEqual(place.coord,archived.place.coord);
 return route.fulfill({json:archived});
});
async function selectPlace(field,query){
 const input=page.getByRole('combobox',{name:field,exact:true});await input.fill(query);
 await page.getByRole('button',{name:field+' 검색',exact:true}).click();await page.getByRole('option').filter({hasText:query}).first().click();
}
async function screenshot(name){await page.screenshot({path:output+'/'+name+'.png'});}
async function panoramaSnapshot(){return page.evaluate(()=>window.__entrancePanoramas.snapshot());}
async function exactPanorama(photo){
 const source=new URL(photo.source.url),expected={panoId:photo.source.panoId,pan:Number(source.searchParams.get('heading')),tilt:Number(source.searchParams.get('tilt')),fov:Number(source.searchParams.get('fov'))};
 await page.waitForFunction(expected=>{
  const actual=window.__entrancePanoramas.snapshot();if(!actual?.initialized||actual.panoId!==expected.panoId)return false;
  const delta=((actual.pov.pan-expected.pan+540)%360)-180;
  return Math.abs(delta)<.01&&Math.abs(actual.pov.tilt-expected.tilt)<.01&&Math.abs(actual.pov.fov-expected.fov)<.01;
 },expected,{timeout:30000});
 const tileHandle=await page.waitForFunction(()=>{
  const tiles=[...document.querySelectorAll('.roadview-modal-viewport img')].filter(image=>{let url;try{url=new URL(image.currentSrc||image.src);}catch{return false;}return /(^|\.)pstatic\.net$/.test(url.hostname)&&image.complete&&image.naturalWidth>=128&&image.naturalHeight>=128;});return tiles.length>=2?tiles.length:false;
 },null,{timeout:30000});
 const loadedTiles=await tileHandle.jsonValue();await tileHandle.dispose();
 return {expected,native:await panoramaSnapshot(),loadedTiles};
}
try{
 await page.goto(base,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>[...document.querySelectorAll('.map img')].filter(image=>{try{return /(^|\.)(?:pstatic\.net|naver\.com|naver\.net|navermaps\.com)$/.test(new URL(image.currentSrc||image.src).hostname)&&image.complete&&image.naturalWidth>=128&&image.naturalHeight>=128;}catch{return false;}}).length>=2,null,{timeout:45000});
 await selectPlace('출발지','경희대학교 국제캠퍼스 예술디자인대학관');
 await selectPlace('도착지','맥도날드 경희대국제캠퍼스점');
 const search=page.getByRole('button',{name:'경로 찾기',exact:true});
 assert.equal(await search.isVisible(),true,'A chosen destination must leave route search visible without a helper reopening the panel');assert.equal(await search.isEnabled(),true);
 await search.click();await page.locator('.route-card').first().waitFor({timeout:90000});
 await page.locator('.analysis-activity').getByRole('button',{name:'중지',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.progress button'));
 release.resolve();assert.ok(latest?.journey&&advanceHeld>0,'Real journey required; all analysis advance requests must be held and canceled');
 await page.evaluate(controlled=>{const banner=document.createElement('div');banner.dataset.sourceReplay='true';banner.textContent=controlled?'CONTROLLED UI ONLY — technical failure, not an AI result':'ARCHIVED GENUINE SOURCE REPLAY — saved photographs and earlier observation, no new AI analysis';banner.style.cssText='position:fixed;bottom:0;left:0;right:0;z-index:99999;background:#fff3cd;color:#402800;font:12px sans-serif;padding:8px;text-align:center';document.body.append(banner);},controlled);
 assert.equal(await page.getByRole('button',{name:'입구 확인',exact:true}).count(),0,'Entrance analysis starts automatically after route submission');await page.locator('.place-entrance h4').waitFor({timeout:20000});
 report.headline=await page.locator('.place-entrance h4').innerText();
 assert.equal(await page.locator('.destination-info-actions,.entrance-secondary-actions,.secondary-journey-info').count(),0,'Removed place/contact actions must not displace the entrance result');
 assert.equal(await page.locator('.search-section').isVisible(),false,'Results should not be occupied by search options');
 const entranceText=await page.locator('.place-entrance').innerText();
 assert.doesNotMatch(entranceText,/HTTP\s*\d{3}|controlled-fixture|gemini-|panoId|FOV/i,'Technical/provider diagnostics must not substitute for a user-facing entrance explanation');
 await screenshot('desktop-result');
 if(controlled){
  assert.equal(await page.locator('.entrance-photos figure').count(),0,'Technical failure must not invent photographs');
  assert.equal(await page.getByRole('button',{name:'다시 확인',exact:true}).isEnabled(),true);
  report.checks.push({name:'technical failure offers retry without invented photos or raw diagnostics',controlledUIOnly:true});
 }else{
  await page.locator('.entrance-photos > summary').click();
  assert.equal(await page.locator('.entrance-photos figure').count(),archived.evidence.length);
  await page.waitForFunction(()=>[...document.querySelectorAll('.entrance-photos img')].every(image=>image.complete&&image.naturalWidth>0));
  report.photos=[];
  for(let index=0;index<archived.evidence.length;index++){
   const photo=archived.evidence[index],image=page.locator('.entrance-photos figure').nth(index).locator('img');
   const browserBytes=Buffer.from(await image.evaluate(async element=>Array.from(new Uint8Array(await(await fetch(element.src)).arrayBuffer())))),original=Buffer.from(photo.image.data,'base64');
   assert.deepEqual(browserBytes,original,'The displayed image must be the exact archived source photo, not a new viewpoint or thumbnail substitute');
   await page.locator('.entrance-photos figure').nth(index).locator('.evidence-photo-secondary > summary').click();
   const sourceLink=page.locator('.entrance-photos figure').nth(index).getByRole('link',{name:/촬영 위치 원본/});assert.equal(await sourceLink.getAttribute('href'),photo.source.url);
   report.photos.push({id:photo.id,bytes:original.length,sha256:createHash('sha256').update(original).digest('hex'),browserBytesEqual:true,source:photo.source});
  }
  await screenshot('desktop-evidence');
  const index=Math.max(0,archived.evidence.findIndex(photo=>photo.source.tilt!==0)),photo=archived.evidence[index];
  const opener=page.locator('.entrance-photos figure').nth(index).getByRole('button',{name:'이 사진 위치 360° 거리뷰',exact:true});
  await opener.click();report.panorama=await exactPanorama(photo);await screenshot('desktop-exact-source-panorama');
  const viewport=await page.locator('.roadview-modal-viewport').boundingBox();assert.ok(viewport&&viewport.width>200);
  const before=await panoramaSnapshot();
  await page.mouse.move(viewport.x+viewport.width*.7,viewport.y+viewport.height*.5);await page.mouse.down();await page.mouse.move(viewport.x+viewport.width*.35,viewport.y+viewport.height*.5,{steps:15});await page.mouse.up();
  await page.waitForFunction(before=>{const now=window.__entrancePanoramas.snapshot();return now.panoId===before.panoId&&Math.abs(now.pov.pan-before.pov.pan)>1;},before,{timeout:10000});
  await screenshot('desktop-panorama-dragged');
  await page.getByRole('button',{name:'거리뷰 닫기',exact:true}).click();assert.equal(await opener.evaluate(element=>document.activeElement===element),true);
  await opener.click();report.panoramaReopen=await exactPanorama(photo);
  await page.setViewportSize({width:390,height:844});
  const mobile=await page.locator('.roadview-dialog').boundingBox();assert.ok(mobile&&mobile.x>=0&&mobile.x+mobile.width<=390);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await exactPanorama(photo);await screenshot('mobile-exact-source-panorama');
  await page.keyboard.press('Escape');assert.equal(await page.locator('.roadview-dialog').count(),0);assert.equal(await opener.evaluate(element=>document.activeElement===element),true);
  await page.locator('.entrance-photos > summary').click();
  report.checks.push({name:'exact archived photo bytes, genuine source panorama pose/tiles, drag, reopen and mobile focus',newAIInference:false});
 }
 await page.setViewportSize({width:390,height:844});await page.locator('.place-entrance').scrollIntoViewIfNeeded();await screenshot('mobile-result');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 const attribution=page.locator('.sidebar-footer.source-attribution');assert.equal(await attribution.isVisible(),true);assert.match(await attribution.innerText(),/NAVER.*Kakao/s);
 assert.equal(await page.locator('.travel-mode-bar').isVisible(),true,'Travel mode remains visible above results');
 report.entranceText=entranceText;report.routePhase=latest.phase;report.advanceRequestsForwarded=0;report.advanceRequestsHeld=advanceHeld;
 assert.deepEqual(errors,[]);report.status='passed';
}catch(error){report.failure=String(error.message??error);process.exitCode=1;await screenshot('failure').catch(()=>{});}
finally{
 release.resolve();
 for(const jobId of jobs)if(!canceled.has(jobId))try{const response=await context.request.post(new URL('/api/action',base).href,{data:{action:'cancel',jobId}});assert.ok(response.ok());canceled.add(jobId);}catch(error){errors.push(String(error.message));}
 report.jobs={created:jobs.size,canceled:canceled.size};if(errors.length||jobs.size!==canceled.size){report.status='failed';process.exitCode=1;}
 report.checkedAt=new Date().toISOString();await writeFile(output+'/report.json',JSON.stringify(report,null,2));
 await context.close();await browser.close();console.log(JSON.stringify({status:report.status,sourceMode:report.sourceMode,headline:report.headline,photos:report.photos?.length??0,jobs:report.jobs,failure:report.failure}));
}
