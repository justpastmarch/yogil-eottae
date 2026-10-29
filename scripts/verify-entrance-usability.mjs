import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from '../services/roadview-renderer/node_modules/playwright/index.mjs';

const base=process.env.MOBILITY_BASE_URL??'http://localhost:3000';
const controlled=process.env.MOBILITY_CONTROLLED_ERRORS==='1';
const output=process.env.MOBILITY_REPORT_DIR??'.sites-runtime/entrance-usability'+(controlled?'/controlled':'');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--enable-webgl','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:1440,height:960}});
const errors=[],responses=[];
let controlledJobId;
page.on('pageerror',error=>errors.push(error.message));
page.on('response',async response=>{
 if(!response.url().endsWith('/api/action')||!response.ok())return;
 try{const data=await response.json();if(data.journey)responses.push(data);}catch{}
});
if(controlled){
 await page.route('**/api/action',async intercepted=>{
  const request=intercepted.request().postDataJSON();
  if(request.action==='journey'){
   const response=await intercepted.fetch();
   if(!response.ok())return intercepted.fulfill({response});
   const seed=await response.json();controlledJobId=seed.jobId;
   seed.phase='limited';seed.captures=[];
   seed.progress.notice='경로 사진 분석 중단: 분석 서비스 크레딧이 부족합니다. (HTTP 402)';
   const candidate=seed.journey.routes[0],sample=candidate.samples[0];
   seed.journey.evidence[candidate.id+':'+sample.id]={sampleId:sample.id,stage:'processed',status:'unknown',failure:'analysis',reason:seed.progress.notice,checkedAt:new Date().toISOString()};
   return intercepted.fulfill({json:seed});
  }
  if(request.action==='advance')throw new Error('Controlled failures must not start external image analysis');
  return intercepted.continue();
 });
 await page.route('**/api/entrance',async intercepted=>{
  const {place}=intercepted.request().postDataJSON();
  return intercepted.fulfill({json:{place,verdict:'unknown',uncertainty:'technical',reason:'분석 서비스 크레딧을 확인해야 합니다 (HTTP 402)',nextAction:'서비스 계정의 크레딧을 확인한 뒤 다시 분석하세요.',checkedAt:new Date().toISOString(),model:'controlled-fixture',evidence:[],limitations:['제어된 오류 화면 검증이며 실제 AI 판독 결과가 아닙니다.']}});
 });
}
async function selectPlace(field,query){
 if(!await page.getByRole('combobox',{name:field,exact:true}).isVisible())await page.locator('.results-controls button').click();
 await page.getByRole('combobox',{name:field,exact:true}).fill(query);
 await page.getByRole('button',{name:field+' 검색',exact:true}).click();
 await page.getByRole('option').filter({hasText:query}).first().click();
}
try{
 await page.goto(base,{waitUntil:'networkidle'});
 await selectPlace('출발지','경희대학교 국제캠퍼스 예술디자인대학');
 await selectPlace('도착지','맥도날드 경희대국제캠퍼스점');
 if(!await page.getByRole('button',{name:'경로 찾기',exact:true}).isVisible())await page.locator('.results-controls button').click();
 await page.getByRole('button',{name:'경로 찾기',exact:true}).click();
 await page.locator('.route-card').first().waitFor({timeout:90000});
 await page.waitForFunction(()=>{
  const progress=document.querySelector('.progress')?.textContent??'';
  return /판독 완료\s+[1-9]/.test(progress)||!!document.querySelector('.route-analysis-notice');
 },null,{timeout:240000});
 if(await page.getByRole('button',{name:'중지',exact:true}).isVisible())await page.getByRole('button',{name:'중지',exact:true}).click();
 const journey=responses.at(-1);
 assert.ok(journey,'A real route response is required');
 const observations=Object.values(journey.journey.evidence).filter(item=>item.finding).map(item=>({sampleId:item.sampleId,status:item.status,reason:item.reason}));
 await page.getByRole('button',{name:'입구 확인',exact:true}).click();
 await page.locator('.place-entrance h4').waitFor({timeout:110000});
 const entranceText=await page.locator('.place-entrance').innerText();
 const headline=await page.locator('.place-entrance h4').innerText();
 assert.equal(await page.locator('.entrance-details').getAttribute('open'),null,'Detailed diagnostics should not displace the main result');
 assert.equal(await page.locator('.search-section').isVisible(),false,'Result screen should not be occupied by search options');
 assert.equal(await page.locator('.legend-entries').isVisible(),false,'Map diagnostics should be available on demand');
 await page.screenshot({path:output+'/desktop-result.png'});
 if(await page.locator('.entrance-photos').count())await page.locator('.entrance-photos > summary').click();
 const photoCount=await page.locator('.entrance-photos figure').count();
 if(controlled){
  assert.equal(photoCount,0,'A technical failure must not invent photographs');
  await page.getByRole('button',{name:'다시 확인',exact:true}).waitFor();
  assert.match(await page.locator('.route-analysis-notice > summary').innerText(),/HTTP 402/);
  assert.match(await page.locator('.entrance-reason').innerText(),/HTTP 402/);
 }else assert.ok(photoCount>0,'The selected place must retain genuine source photographs');
 if(photoCount){
  await page.locator('.entrance-photos img').first().scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>[...document.querySelectorAll('.entrance-photos img')].every(img=>img.complete&&img.naturalWidth>0));
 }
 await page.screenshot({path:output+'/desktop-evidence.png'});
 if(photoCount)await page.locator('.entrance-photos > summary').click();
 await page.setViewportSize({width:390,height:844});
 await page.locator('.place-entrance').scrollIntoViewIfNeeded();
 await page.screenshot({path:output+'/mobile-result.png'});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'The mobile result must not overflow horizontally');
 await page.locator('.entrance-details > summary').click();
 const detailsText=await page.locator('.entrance-details').innerText();
 await page.screenshot({path:output+'/mobile-details.png'});
 assert.deepEqual(errors,[]);
 const report={base,controlled,checkedAt:new Date().toISOString(),scenario:'예술디자인대학 → 맥도날드 경희대국제캠퍼스점',routePhase:journey.phase,routeNotice:journey.progress.notice,observations,headline,entranceText,photoCount,detailsText,errors};
 await writeFile(output+'/report.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify({routePhase:report.routePhase,observations:observations.length,headline,photoCount,errors}));
}finally{
 const jobId=controlled?controlledJobId:responses.at(-1)?.jobId;
 if(jobId)await page.request.post(base+'/api/action',{data:{action:'cancel',jobId}}).catch(()=>{});
 await browser.close();
}
