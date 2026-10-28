import {chromium} from '../services/roadview-renderer/node_modules/playwright/index.mjs';
import {writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const reportDir=process.env.DETAILS_REPORT_DIR??fileURLToPath(new URL('../.sites-runtime/route-details/',import.meta.url));
await mkdir(reportDir,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--enable-webgl','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
let latest,pendingCapture;
page.on('pageerror',error=>errors.push(error.message));
page.on('response',async response=>{
 if(response.url().endsWith('/api/action'))try{const data=await response.json();if(data.jobId)latest=data;}catch{}
});
try{
 await page.goto(process.env.DETAILS_BASE_URL??'http://localhost:3000/',{waitUntil:'networkidle'});
 await page.locator('.primary.search-button').click();
 await page.locator('.route-card').first().waitFor({timeout:80000});
 await page.locator('.route-detail-button').first().click();
 await page.waitForFunction(()=>[...document.querySelectorAll('.current-analysis .capture-thumbnail img')].some(image=>image.complete&&image.naturalWidth>128),null,{timeout:90000});
 const frame=page.locator('.current-analysis .capture-thumbnail img').first();
 await frame.scrollIntoViewIfNeeded();
 const source=await frame.getAttribute('src');
 const capture=latest.captures.find(item=>item.url===source);
 assert.ok(capture,'The visible frame must belong to the current persisted job');
 const pendingItem=latest.journey.evidence[capture.evidenceId];
 assert.ok(pendingItem?.stage==='reserved'||pendingItem?.review?.state==='reserved','The screenshot must be visible before its analysis finishes');
 const imageResponse=await page.request.get(new URL(source,page.url()).href);
 assert.equal(imageResponse.status(),200);
 assert.match(imageResponse.headers()['content-type'],/^image\//);
 pendingCapture={captureId:capture.id,evidenceId:capture.evidenceId,viewId:capture.viewId,stage:pendingItem.stage,review:pendingItem.review?.state,bytes:(await imageResponse.body()).length};
 await page.screenshot({path:path.join(reportDir,'판독중-실제스크린샷.png')});
 await page.getByRole('button',{name:'경로 목록으로',exact:true}).click();
 const firstObserved=()=>latest&&Object.values(latest.journey.evidence).some(item=>item.finding&&item.source);
 if(!firstObserved()&&latest?.phase==='running')await page.waitForResponse(async response=>{
  if(!response.url().endsWith('/api/action'))return false;
  try{const data=await response.json();return data.jobId&&(data.phase!=='running'||Object.values(data.journey.evidence).some(item=>item.finding&&item.source));}catch{return false;}
 },{timeout:180000});
 assert.ok(firstObserved(),'Real image analysis must finish before verifying its observation surface');
 const route=latest.journey.routes.find(candidate=>candidate.samples.some(sample=>latest.journey.evidence[candidate.id+':'+sample.id]?.source));
 assert.ok(route);
 const index=latest.journey.routes.findIndex(candidate=>candidate.id===route.id),decision=latest.journey.assessments[route.id].decision;
 await page.locator('.route-select').nth(index).click();
 assert.equal(await page.locator('.primary.full').isDisabled(),decision.kind!=='recommended');
 if(decision.kind==='detour')assert.equal(await page.locator('.walking-preview').count(),0);
 if(decision.kind==='conditional'&&latest.phase!=='running'&&route.steps.length&&!decision.issues.some(issue=>issue.status==='blocked')&&!latest.journey.assessments[route.id].blockedPassageIds.length){
  const confirmation=page.getByRole('region',{name:'조건부 경로 확인'});
  await confirmation.getByRole('checkbox').check();
  assert.equal(await page.getByRole('button',{name:'조건부 경로 안내 시작'}).isEnabled(),true);
  await page.getByRole('button',{name:'조건부 경로 안내 시작'}).click();
  assert.ok(await page.getByText('조건부 경로입니다.',{exact:false}).isVisible());
  await page.getByRole('button',{name:'경로 안내 닫기'}).click();
  await page.locator('.route-select').nth(index).click();
  assert.equal(await confirmation.getByRole('checkbox').isChecked(),false);
  assert.equal(await page.locator('.primary.full').isDisabled(),true);
 }
 await page.locator('.route-detail-button').nth(index).click();
 await page.locator('.route-action.kind-'+decision.kind).waitFor();
 assert.equal(await page.locator('#from').count(),0);
 assert.equal(await page.evaluate(()=>document.activeElement?.tagName),'H2');
 const sample=route.samples.find(point=>latest.journey.evidence[route.id+':'+point.id]?.source),markerId=route.id+':'+sample.id;
 await page.locator('[data-evidence-id='+JSON.stringify(markerId)+']').click();
 await page.locator('.detail-point.focused').waitFor();
 assert.equal(await page.locator('.detail-point.focused').count(),1);
 await page.locator('.detail-body').evaluate(element=>element.scrollTop=0);
 await page.screenshot({path:path.join(reportDir,'경로상세-행동결정.png')});
 await page.locator('.roadview-open-btn').first().click();
 await page.locator('dialog[open]').waitFor();
 await page.waitForFunction(()=>[...document.querySelectorAll('.roadview-modal-viewport img')].filter(image=>image.complete&&image.naturalWidth>128).length>=2||[...document.querySelectorAll('.roadview-modal-viewport canvas')].some(canvas=>canvas.width>400&&canvas.height>250),null,{timeout:20000});
 await page.screenshot({path:path.join(reportDir,'판독근거-360로드뷰.png')});
 await page.getByRole('button',{name:'로드뷰 닫기',exact:true}).click();
 await page.locator('dialog').waitFor({state:'detached'});
 assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('roadview-open-btn')),true,'Closing roadview should return keyboard focus to its opener');
 await page.getByRole('button',{name:'경로 목록으로',exact:true}).click();
 assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('route-detail-button')),true);
 const stop=page.getByRole('button',{name:'중지',exact:true});
 if(await stop.isVisible())await stop.click();
 const providerRoute=latest.journey.routes.find(candidate=>candidate.barriers?.length);
 if(providerRoute){
  const providerIndex=latest.journey.routes.findIndex(candidate=>candidate.id===providerRoute.id),barrierId=providerRoute.id+':'+providerRoute.barriers[0].sampleId;
  await page.locator('.route-select').nth(providerIndex).click();
  await page.locator('[data-evidence-id='+JSON.stringify(barrierId)+']').click();
  await page.locator('.action-issue.focused').waitFor();
  assert.ok(await page.locator('.detail-point.focused,.action-issue.focused').evaluateAll(elements=>elements.some(element=>{const point=element.getBoundingClientRect(),region=element.closest('.detail-body').getBoundingClientRect();return Math.min(point.bottom,region.bottom)-Math.max(point.top,region.top)>80;})));
  await page.getByRole('button',{name:'경로 목록으로',exact:true}).click();
 }
 await page.locator('.route-detail-button').nth(index).click();
 await page.locator('.detail-tabs button').nth(1).click();
 await page.setViewportSize({width:390,height:844});
 await page.locator('.detail-body').evaluate(element=>element.scrollTop=0);
 await page.screenshot({path:path.join(reportDir,'경로상세-모바일.png')});
 assert.ok(await page.locator('.detail-body').evaluate(element=>element.scrollHeight>element.clientHeight));
 const mapBox=await page.locator('.map-area').boundingBox();assert.ok(mapBox&&mapBox.height>180);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
 assert.ok(await page.locator('.locate').evaluate(element=>{const box=element.getBoundingClientRect();return document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)?.closest('.locate')===element;}),'Mobile legend must not intercept location control');
 assert.deepEqual(errors,[]);
 await writeFile(path.join(reportDir,'journey.json'),JSON.stringify({snapshot:latest,pendingCapture,routeId:route.id,decision:decision.kind,markerId,mobileMapHeight:mapBox.height,errors},null,2));
 console.log(JSON.stringify({phase:latest.phase,decision:decision.kind,pendingCapture,captures:latest.captures.length,observations:Object.values(latest.journey.evidence).filter(item=>item.finding&&item.source).length,mobileMapHeight:mapBox.height,errors}));
}finally{
 await writeFile(path.join(reportDir,'last-observed-snapshot.json'),JSON.stringify(latest??null,null,2));
 if(latest?.phase==='running')await page.evaluate(async jobId=>{await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'cancel',jobId})});},latest.jobId).catch(()=>{});
 await browser.close();
}
