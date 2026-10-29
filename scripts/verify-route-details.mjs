import {routeGuideBlocked} from '../app/route-presentation.ts';
import {chromium} from '../services/roadview-renderer/node_modules/playwright/index.mjs';
import {writeFile,readFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {assessRouteAdmission,evaluateRoute,recommendedRoute} from '../lib/domain.ts';
import {journeySnapshotResponse} from '../lib/requests.ts';

const base=process.env.DETAILS_BASE_URL??'http://localhost:3000/';
const reportDir=process.env.DETAILS_REPORT_DIR??fileURLToPath(new URL('../.sites-runtime/route-details/',import.meta.url));
const archiveDir=process.env.DETAILS_ARCHIVE_DIR??fileURLToPath(new URL('../.sites-runtime/naver-migration/NaverRouteVisualQA/',import.meta.url));
// This is an explicitly labeled replay of a genuine earlier capture, not a new model observation.
const [saved,chosen,proof,photoBytes]=await Promise.all([
 readFile(path.join(archiveDir,'route-job-canceled.json'),'utf8').then(JSON.parse),
 readFile(path.join(archiveDir,'chosen-source.json'),'utf8').then(JSON.parse),
 readFile(path.join(archiveDir,'report.json'),'utf8').then(JSON.parse),
 readFile(path.join(archiveDir,'archived-source.png')),
]).catch(()=>{throw new Error('Genuine saved route snapshot, chosen source, proof report and original photo are required. Set DETAILS_ARCHIVE_DIR; no live AI fallback is started.');});
const photoHash=createHash('sha256').update(photoBytes).digest('hex');
assert.equal(photoHash,proof.privateImage.sha256,'Archived bytes must match the genuine source proof, not a screenshot substitute');
const capture=saved.captures.find(item=>item.id===chosen.capture.id);assert.ok(capture);
const archivedRoute=saved.journey.routes.find(route=>route.samples.some(sample=>route.id+':'+sample.id===capture.evidenceId));assert.ok(archivedRoute);
assert.deepEqual(saved.journey.evidence[capture.evidenceId],chosen.finding,'Archived photo and original observation must refer to the same recorded point');
await mkdir(reportDir,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--enable-webgl','--ignore-gpu-blocklist']});
const context=await browser.newContext({viewport:{width:1440,height:960}}),errors=[],jobs=new Set(),canceled=new Set(),release=Promise.withResolvers();
const report={status:'failed',scope:'Fresh real route details with analysis held, then separate genuine archived source replay and labeled controlled pending-photo UI. No new AI inference.',checks:[],errors};
let page,latest,held=0;
context.on('page',view=>view.on('pageerror',error=>errors.push(error.message)));
await context.addInitScript(()=>{
 const state={records:[]};Object.defineProperty(window,'__detailPanorama',{value:state});
 const discover=()=>{const sdk=window.naver?.maps;if(!sdk?.Panorama||sdk.Panorama.__detailsDriver)return;const Original=sdk.Panorama;
  const wrapped=new Proxy(Original,{construct(target,args,newTarget){const instance=Reflect.construct(target,args,newTarget),record={instance,ready:false};state.records.push(record);sdk.Event.addListener(instance,'init',()=>{record.ready=true;});return instance;}});
  Object.defineProperty(wrapped,'__detailsDriver',{value:true});sdk.Panorama=wrapped;
 };
 new MutationObserver(discover).observe(document,{childList:true,subtree:true});window.addEventListener('load',discover,true);
 state.snapshot=()=>{const record=state.records.at(-1);return record?{ready:record.ready,panoId:record.instance.getPanoId(),pov:record.instance.getPov()}:null;};
});
const guideBlocked=(route,journey)=>routeGuideBlocked(journey.assessments[route.id]);
async function cancel(jobId){const response=await context.request.post(new URL('/api/action',base).href,{data:{action:'cancel',jobId}});assert.ok(response.ok(),'Every fresh real route job must be canceled');canceled.add(jobId);}
async function screenshot(view,name){await view.screenshot({path:path.join(reportDir,name+'.png')});}
async function ready(view){
 // Provider tiles are created by the real client map effect, after React has attached its controls.
 await view.waitForFunction(()=>[...document.querySelectorAll('.map img')].filter(image=>{try{return /(^|\.)(?:pstatic\.net|naver\.com|naver\.net|navermaps\.com)$/.test(new URL(image.currentSrc||image.src).hostname)&&image.complete&&image.naturalWidth>=128&&image.naturalHeight>=128;}catch{return false;}}).length>=2,null,{timeout:45000});
}
async function open(view,route){await view.getByRole('button',{name:route.name+' 선택',exact:true}).click();await view.locator('.route-card.selected .route-detail-button').click();await view.locator('.detail-body').waitFor();await view.waitForFunction(()=>document.activeElement?.matches('.detail-title h2'));}
async function back(view){await view.getByRole('button',{name:'경로 목록으로',exact:true}).click();assert.equal(await view.evaluate(()=>document.activeElement?.matches('.route-detail-button')),true);}
function replay(pending){
 const snapshot=structuredClone(saved);snapshot.phase='limited';snapshot.journey.routes=[structuredClone(archivedRoute)];snapshot.captures=[structuredClone(capture)];snapshot.journey.recommendedId=null;
 const assessment=snapshot.journey.assessments[archivedRoute.id];
 // Archive-only projection drops retired centroid diagnostics; original imagery/provider findings are unchanged.
 snapshot.journey.routes[0].unverifiedConnections=archivedRoute.unverifiedConnections?.filter(connection=>['station','underpass','elevator'].includes(connection.kind));
 snapshot.journey.assessments={[archivedRoute.id]:assessment};
 if(pending){
  const original=snapshot.journey.evidence[capture.evidenceId];
  snapshot.journey.evidence[capture.evidenceId]={stage:'reserved',sampleId:original.sampleId,status:'unknown',reason:'CONTROLLED UI ONLY — photo available, analysis pending',source:original.source,checkedAt:original.checkedAt};
  // Derive the pending verdict from this reserved observation rather than editing decision prose.
 }
 const route=snapshot.journey.routes[0];
 assessment.decision=evaluateRoute(route,snapshot.journey.evidence,assessment.blockedPassageIds,snapshot.journey.maxSlope);
 assessment.admission=assessRouteAdmission({route,decision:assessment.decision,blockedPassageIds:assessment.blockedPassageIds,maxSlope:snapshot.journey.maxSlope});
 snapshot.journey.recommendedId=recommendedRoute(snapshot.journey.routes,snapshot.journey.evidence,snapshot.journey.assessments,snapshot.journey.maxSlope);
 snapshot.journey.status=snapshot.journey.recommendedId?'ready':'limited';
 return journeySnapshotResponse.parse(snapshot);
}
try{
 page=await context.newPage();
 await page.route('**/api/action',async route=>{
  const body=route.request().postDataJSON();if(body.action==='advance'){held++;await release.promise;return route.abort().catch(()=>{});}
  const response=await route.fetch();if(!['journey','status','cancel'].includes(body.action))return route.fulfill({response});
  const data=await response.json();if(data.jobId){jobs.add(data.jobId);latest=data;if(body.action==='cancel')canceled.add(data.jobId);}
  return route.fulfill({response,json:data});
 });
 await page.goto(base,{waitUntil:'domcontentloaded'});await ready(page);await page.locator('.search-button').click();await page.locator('.route-card').first().waitFor({timeout:90000});
 assert.ok(latest?.journey);const route=latest.journey.routes.find(candidate=>!guideBlocked(candidate,latest.journey));assert.ok(route,'Fresh scenario requires a complete nonblocked candidate');
 assert.equal(Object.values(latest.journey.evidence).some(item=>item.finding),false,'Held advances must not produce a new model observation');
 await open(page,route);
 const guide=page.getByRole('button',{name:'길안내 시작',exact:true});assert.equal(await guide.isEnabled(),true,'Pending/unknown photos must not gate ordinary route guidance');
 await screenshot(page,'live-pending-details');await guide.click();await page.locator('.navigation-panel').waitFor();await screenshot(page,'live-pending-guide');
 await page.getByRole('button',{name:'경로 안내 닫기',exact:true}).click();await back(page);
 await page.getByRole('button',{name:'중지',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.progress button'));release.resolve();
 report.checks.push({name:'fresh complete route details and ordinary guide work while photos are pending',routeId:route.id,analysisForwarded:0,advanceHeld:held});
 await page.close();page=null;

 for(const pending of [false,true]){
  const snapshot=replay(pending),view=await context.newPage();page=view;
  await view.route('**/api/action',async intercepted=>{
   const body=intercepted.request().postDataJSON();
   if(body.action==='journey')return intercepted.fulfill({json:snapshot});
   if(body.action==='advance')throw new Error('Archived/controlled UI replay must never run analysis');
   if(body.action==='cancel')return intercepted.fulfill({json:{...snapshot,phase:'canceled'}});
   return intercepted.continue();
  });
  await view.route('**/api/journey-image?*',async intercepted=>{assert.equal(new URL(intercepted.request().url()).searchParams.get('id'),capture.id);return intercepted.fulfill({contentType:'image/jpeg',body:photoBytes,headers:{'cache-control':'private, no-store'}});});
  await view.goto(base,{waitUntil:'domcontentloaded'});await ready(view);await view.locator('.search-button').click();await view.locator('.route-card').first().waitFor({timeout:30000});
  await view.evaluate(pending=>{const banner=document.createElement('div');banner.dataset.archiveReplay='true';banner.textContent=pending?'CONTROLLED UI ONLY — pending state with genuine archived photo, not a new observation':'GENUINE ARCHIVE REPLAY — original photo and earlier observation; not current routing or new AI';banner.style.cssText='position:fixed;bottom:0;left:0;right:0;z-index:99999;background:#fff3cd;padding:8px;text-align:center;font:12px sans-serif';document.body.append(banner);},pending);
  await open(view,archivedRoute);await view.locator('.detail-all-points > summary').click();await view.locator('.detail-all-points button[data-evidence-id='+JSON.stringify(capture.evidenceId)+']').click();
  const frame=view.locator('.capture-thumbnail img');await frame.waitFor();await frame.scrollIntoViewIfNeeded();
  await view.waitForFunction(()=>[...document.querySelectorAll('.capture-thumbnail img')].some(image=>image.complete&&image.naturalWidth>128));
  assert.equal(await frame.getAttribute('src'),capture.url);
  const bytes=Buffer.from(await frame.evaluate(async image=>Array.from(new Uint8Array(await(await fetch(image.src)).arrayBuffer()))));assert.deepEqual(bytes,photoBytes);
  const row=frame.locator('xpath=ancestor::figure');await row.locator('.evidence-photo-secondary > summary').click();
  const sourceLink=row.getByRole('link',{name:/촬영 위치 원본/});assert.equal(await sourceLink.getAttribute('href'),capture.source.url);
  if(pending)assert.doesNotMatch(await view.locator('.detail-point.focused .detail-reason').innerText(),/단차 없이 이어지는|연결 경사로와 이어지는/,'A pending selected point must not assert a positive connection observation');
  await screenshot(view,pending?'controlled-pending-photo':'archived-original-photo-and-observation');
  if(!pending){
   const opener=row.locator('.roadview-open-btn');await opener.click();
   const url=new URL(capture.source.url),expected={panoId:capture.source.panoId,pan:Number(url.searchParams.get('heading')),tilt:Number(url.searchParams.get('tilt')),fov:Number(url.searchParams.get('fov'))};
   await view.waitForFunction(expected=>{const now=window.__detailPanorama.snapshot();return now?.ready&&now.panoId===expected.panoId&&Math.abs(((now.pov.pan-expected.pan+540)%360)-180)<.01&&Math.abs(now.pov.tilt-expected.tilt)<.01&&Math.abs(now.pov.fov-expected.fov)<.01;},expected,{timeout:30000});
   await view.waitForFunction(()=>[...document.querySelectorAll('.roadview-modal-viewport img')].filter(image=>{try{return /(^|\.)pstatic\.net$/.test(new URL(image.src).hostname)&&image.complete&&image.naturalWidth>=128;}catch{return false;}}).length>=2,null,{timeout:30000});
   report.panorama={expected,native:await view.evaluate(()=>window.__detailPanorama.snapshot())};await screenshot(view,'archived-source-real-360');
   await view.getByRole('button',{name:'거리뷰 닫기',exact:true}).click();assert.equal(await opener.evaluate(element=>document.activeElement===element),true);
   const after=Buffer.from(await frame.evaluate(async image=>Array.from(new Uint8Array(await(await fetch(image.src)).arrayBuffer()))));assert.deepEqual(after,photoBytes,'Exploring the panorama must not replace the original archived photograph');
  }
  await view.setViewportSize({width:390,height:844});await screenshot(view,pending?'controlled-pending-photo-mobile':'archived-source-mobile');
  const map=await view.locator('.map-area').boundingBox();assert.ok(map&&map.height>=180);assert.equal(await view.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await view.locator('.locate').evaluate(element=>{const box=element.getBoundingClientRect();return document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)?.closest('.locate')===element;}),true);
  await back(view);report.checks.push({name:pending?'controlled pending photo stays available without a model claim':'genuine archived observation, exact original photo, source link and native 360 remain available',controlledUIOnly:pending,archiveReplay:true,photoHash,mobileMapHeight:map.height});
  await view.close();page=null;
 }
 assert.deepEqual(errors,[]);report.status='passed';
}catch(error){report.failure=String(error.message??error);process.exitCode=1;if(page)await screenshot(page,'failure').catch(()=>{});}
finally{
 release.resolve();for(const jobId of jobs)if(!canceled.has(jobId))try{await cancel(jobId);}catch(error){errors.push(String(error.message));}
 report.jobs={created:jobs.size,canceled:canceled.size};if(errors.length||jobs.size!==canceled.size){report.status='failed';process.exitCode=1;}
 report.checkedAt=new Date().toISOString();await writeFile(path.join(reportDir,'report.json'),JSON.stringify(report,null,2));
 await context.close();await browser.close();console.log(JSON.stringify({status:report.status,checks:report.checks.length,jobs:report.jobs,failure:report.failure}));
}
