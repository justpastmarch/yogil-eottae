import {routeGuideBlocked} from '../app/route-presentation.ts';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from '../services/roadview-renderer/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';

const base=process.env.MOBILITY_BASE_URL??'http://localhost:3000';
const output=process.env.MOBILITY_REPORT_DIR??'.sites-runtime/mobility-features';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--enable-webgl','--ignore-gpu-blocklist']});
const context=await browser.newContext({viewport:{width:1440,height:960}}),page=await context.newPage(),errors=[],jobs=new Set(),canceled=new Set(),release=Promise.withResolvers();
const entranceBoundary={mode:'CONTROLLED TECHNICAL FAILURE',httpStatus:503,requests:0,actualEntranceAnalysis:false};
const report={status:'failed',scope:'Real route preferences and estimated terrain behind the compact disclosure. All route analysis advances held; automatic entrance requests receive a controlled technical failure. Source-photo/360 coverage belongs to the separate archive-backed entrance and route-detail drivers; no duplicate paid entrance analysis.',checks:[],errors,entranceBoundary};
let latest,advanceHeld=0;
page.on('pageerror',error=>errors.push(error.message));
await context.route('**/api/entrance',route=>{entranceBoundary.requests++;return route.fulfill({status:503,json:{error:'CONTROLLED TECHNICAL FAILURE: entrance service withheld; no image analysis performed'}});});
await page.route('**/api/action',async route=>{
 const body=route.request().postDataJSON();
 if(body.action==='advance'){advanceHeld++;await release.promise;return route.abort().catch(()=>{});}
 const response=await route.fetch();if(!['journey','status','cancel'].includes(body.action))return route.fulfill({response});
 const data=await response.json();if(data.jobId){jobs.add(data.jobId);latest=data;if(body.action==='cancel')canceled.add(data.jobId);}
 return route.fulfill({response,json:data});
});
const blocked=(route,journey)=>routeGuideBlocked(journey.assessments[route.id]);
async function selectPlace(field,query){const input=page.getByRole('combobox',{name:field,exact:true});await input.fill(query);await page.getByRole('button',{name:field+' 검색',exact:true}).click();await page.getByRole('option').filter({hasText:query}).first().click();}
async function displayedRoutes(){
 const labels=await page.locator('.route-card .route-select').evaluateAll(buttons=>buttons.map(button=>button.getAttribute('aria-label')));
 return labels.map(label=>{const route=latest.journey.routes.find(candidate=>candidate.name+' 선택'===label);assert.ok(route,'Every displayed candidate must come from the real route response');return route;});
}
async function selectedRoute(){const label=await page.locator('.route-card.selected .route-select').getAttribute('aria-label');const route=latest.journey.routes.find(candidate=>candidate.name+' 선택'===label);assert.ok(route);return route;}
async function screenshot(name){await page.screenshot({path:output+'/'+name+'.png'});}
try{
 await page.goto(base,{waitUntil:'domcontentloaded'});
 // Wait for the real client map effect before filling SSR-rendered inputs that hydration could reset.
 await page.waitForFunction(()=>[...document.querySelectorAll('.map img')].filter(image=>{try{return /(^|\.)(?:pstatic\.net|naver\.com|naver\.net|navermaps\.com)$/.test(new URL(image.currentSrc||image.src).hostname)&&image.complete&&image.naturalWidth>=128&&image.naturalHeight>=128;}catch{return false;}}).length>=2,null,{timeout:45000});
 await selectPlace('출발지','경희대학교 국제캠퍼스 예술디자인대학관');await selectPlace('도착지','맥도날드 경희대국제캠퍼스점');
 const search=page.getByRole('button',{name:'경로 찾기',exact:true});assert.equal(await search.isVisible(),true,'Destination selection must keep route search directly available');await search.click();
 await page.locator('.route-card').first().waitFor({timeout:90000});
 await page.locator('.place-entrance [role=alert]').waitFor();assert.ok(entranceBoundary.requests>0,'Submitted trips must request entrance confirmation automatically');assert.equal(await page.locator('.place-entrance .entrance-photos').count(),0,'A controlled service failure must not invent entrance photos or a verdict');
 await page.getByRole('button',{name:'중지',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.progress button'));release.resolve();
 assert.ok(latest?.journey&&advanceHeld>0);assert.equal(Object.values(latest.journey.evidence).some(item=>item.finding),false,'Terrain estimates must not be presented as new image analysis');
 const terrain=page.locator('.route-map-details');
 assert.equal(await terrain.getAttribute('open'),null,'Main grade and crossing detail is collapsed by default');
 assert.equal(await terrain.locator('.terrain-profile').isVisible(),false,'The main grade profile stays behind its compact disclosure');
 await terrain.locator(':scope > summary').filter({hasText:'경사·횡단 상세'}).click();
 assert.equal(await terrain.locator('.terrain-profile').isVisible(),true,'Opening grade and crossing detail exposes the actual profile');
 assert.equal(await terrain.locator('.terrain-numeric').getAttribute('open'),null,'Full numeric segment rows stay in native disclosure');
 await page.getByRole('button',{name:'빠른 시간 순',exact:true}).click();
 const fast=await displayedRoutes();for(let index=1;index<fast.length;index++)assert.ok(fast[index-1].seconds<=fast[index].seconds,'Fastest-first preference must order actual walking durations');
 assert.equal((await selectedRoute()).id,fast.find(route=>!blocked(route,latest.journey))?.id,'Fastest preference must choose the first guideable route, not a known obstacle');
 await page.getByRole('button',{name:'완만한 경사 순',exact:true}).click();
 const gentle=await displayedRoutes();
 for(let index=1;index<gentle.length;index++){
  const a=gentle[index-1],b=gentle[index],availableA=a.grade?.status==='available',availableB=b.grade?.status==='available';
  assert.ok(availableA||!availableB,'Missing terrain coverage must not be promoted as a gentler measured route');
  if(availableA&&availableB)assert.ok(a.grade.maxAbsPercent<b.grade.maxAbsPercent||a.grade.maxAbsPercent===b.grade.maxAbsPercent&&(a.grade.ascentMeters<b.grade.ascentMeters||a.grade.ascentMeters===b.grade.ascentMeters&&a.seconds<=b.seconds),'Gentler-first preference must compare the actual estimated grade and climb');
 }
 const selected=await selectedRoute();assert.equal(selected.id,gentle.find(route=>!blocked(route,latest.journey))?.id);
 assert.ok(selected.grade&&selected.grade.status!=='unavailable'&&selected.grade.segments.length,'Selected live route must have actual estimated terrain segments');
 assert.equal(await terrain.locator('.terrain-summary').isVisible(),true);await terrain.locator('.map-display-options > summary').click();
 const threshold=page.getByRole('combobox',{name:'경사 통계 기준',exact:true});await threshold.selectOption('5');
 await page.locator('.route-card.selected .route-detail-button').click();await page.locator('.detail-body').waitFor();
 assert.equal(await page.locator('.route-details .terrain-profile').isVisible(),true,'Route detail keeps the full grade profile visible');
 await page.locator('.route-details .terrain-numeric > summary').click();
 const segments=page.locator('.route-details .terrain-numeric ol button');assert.equal(await segments.count(),selected.grade.segments.length,'Every real estimated terrain segment must remain inspectable in details');
 for(let index=0;index<await segments.count();index++)assert.equal(await segments.nth(index).isEnabled(),true,'Terrain segment locations must be actionable');
 await screenshot('terrain-details');await page.getByRole('button',{name:'경로 목록으로',exact:true}).click();
 assert.equal(await threshold.inputValue(),'5','A chosen terrain threshold must survive detail navigation');
 assert.equal((await selectedRoute()).id,selected.id,'Returning from terrain details must preserve the explicit route');
 await screenshot('routes-desktop');await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Mobile result content must not overflow');
 assert.equal(await page.locator('.sidebar-footer.source-attribution').isVisible(),true,'Mobile source attribution must remain available');
 await screenshot('routes-mobile');
 report.checks.push({name:'real candidate ordering and first guideable selection',fast:fast.map(route=>({id:route.id,seconds:route.seconds})),gentle:gentle.map(route=>({id:route.id,grade:route.grade?.status,maxAbsPercent:route.grade?.maxAbsPercent,ascentMeters:route.grade?.ascentMeters}))});
 report.checks.push({name:'collapsed main terrain detail, visible detail profile, actionable segments and persistent threshold/selection',routeId:selected.id,gradeStatus:selected.grade.status,segments:selected.grade.segments.length,threshold:5,imageryFindingClaimed:false});
 assert.deepEqual(errors,[]);report.status='passed';
}catch(error){report.failure=String(error.message??error);process.exitCode=1;await screenshot('failure').catch(()=>{});}
finally{
 release.resolve();
 for(const jobId of jobs)if(!canceled.has(jobId))try{const response=await context.request.post(new URL('/api/action',base).href,{data:{action:'cancel',jobId}});assert.ok(response.ok());canceled.add(jobId);}catch(error){errors.push(String(error.message));}
 report.jobs={created:jobs.size,canceled:canceled.size};if(errors.length||jobs.size!==canceled.size){report.status='failed';process.exitCode=1;}
 report.checkedAt=new Date().toISOString();await writeFile(output+'/live-verification.json',JSON.stringify(report,null,2));
 await context.close();await browser.close();console.log(JSON.stringify({status:report.status,checks:report.checks.length,jobs:report.jobs,failure:report.failure}));
}
