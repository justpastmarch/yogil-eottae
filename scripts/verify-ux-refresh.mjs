import {routeGuideBlocked} from '../app/route-presentation.ts';
import {GRADE_BANDS,gradeBand,UNKNOWN_GRADE} from '../app/grade-colors.ts';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '../services/roadview-renderer/node_modules/playwright/index.mjs';
import {journeySnapshotResponse} from '../lib/requests.ts';
import {assessRouteAdmission,evaluateRoute,recommendedRoute} from '../lib/domain.ts';
import {instrumentNaverSDK,realNaverTiles,choosePlace,chooseRoute,crossingPointControl,exposedControl,sameCoords,chromeArgs} from './ux-refresh-driver-utils.mjs';

const base=new URL(process.env.UX_BASE_URL??'http://localhost:3000/');
assert.ok(['localhost','127.0.0.1','[::1]'].includes(base.hostname),'Use the real local product server');
assert.equal(base.username+base.password+base.search+base.hash,'','Do not embed credentials in the verification URL');
const output=path.resolve(process.env.UX_REPORT_DIR??'.sites-runtime/ux-refresh');
const beforeDir=process.env.UX_BEFORE_DIR?path.resolve(process.env.UX_BEFORE_DIR):null;
const archiveDir=process.env.DETAILS_ARCHIVE_DIR??fileURLToPath(new URL('../.sites-runtime/naver-migration/NaverRouteVisualQA/',import.meta.url));
await mkdir(output,{recursive:true});
const checks=[],errors=[],jobs=new Set(),canceled=new Set(),release=Promise.withResolvers();
const entranceBoundary={mode:'CONTROLLED TECHNICAL FAILURE',httpStatus:503,requests:0,actualEntranceAnalysis:false};
const report={status:'failed',scope:'Actual ArtDesign → McDonalds place search, real routing geometry and NAVER SDK/tiles; route analysis advances never forwarded and automatic entrance requests receive a controlled technical failure. Separately labeled schema-valid evaluator-derived phase fixtures and genuine earlier source-photo replay. Not a live completed analysis or field accessibility certification.',startedAt:new Date().toISOString(),checks,errors,analysisAdvancesForwarded:0,entranceBoundary};
const check=(name,evidence)=>checks.push({name,evidence});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const browser=await chromium.launch({channel:'chrome',headless:true,args:chromeArgs});
const context=await browser.newContext({viewport:{width:1440,height:960},hasTouch:true});
await context.route('**/api/entrance',route=>{entranceBoundary.requests++;return route.fulfill({status:503,json:{error:'CONTROLLED TECHNICAL FAILURE: entrance service withheld; no image analysis performed'}});});
await context.addInitScript(instrumentNaverSDK);
context.on('page',view=>view.on('pageerror',error=>errors.push(error.message)));
let page,initial,latest,inputs,held=0;
const blocked=(route,journey)=>routeGuideBlocked(journey.assessments[route.id]);
const sdk=view=>view.evaluate(()=>window.__uxSDK.snapshot());
async function screenshot(view,name){await view.screenshot({path:path.join(output,name+'.png')});}
async function cancel(jobId){const response=await context.request.post(new URL('/api/action',base).href,{data:{action:'cancel',jobId}});assert.ok(response.ok(),'Actual job cancellation must succeed');const result=journeySnapshotResponse.parse(await response.json());assert.equal(result.phase,'canceled');canceled.add(jobId);return result;}
async function openDetails(view,route){if(await view.getByRole('button',{name:route.name+' 선택',exact:true}).getAttribute('aria-pressed')!=='true')await chooseRoute(view,route);await view.locator('.route-card.selected .route-detail-button').click();await view.locator('.detail-body').waitFor();await view.waitForFunction(()=>document.activeElement?.matches('.detail-title h2'));}
async function back(view){await view.getByRole('button',{name:'경로 목록으로',exact:true}).click();assert.equal(await view.evaluate(()=>document.activeElement?.matches('.route-detail-button')),true,'Detail close must restore opener focus');}
async function label(view,text){
 // The label is in the document title and a non-interactive header, never covering tested action areas.
 await view.evaluate(text=>{document.title=text+' | '+document.title;const label=document.createElement('div');label.dataset.verificationScope='true';label.textContent=text;label.style.cssText='position:fixed;top:0;right:0;max-width:55%;z-index:99999;background:#fff3cd;color:#402800;font:11px sans-serif;pointer-events:none;padding:3px';document.body.append(label);},text);
}
async function noOverflow(view,name){assert.equal(await view.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,name+': no document horizontal overflow');}
async function onePanelScroll(view,name){
 const scrolling=await view.locator('.sidebar').evaluate(root=>{
  const elements=[root,...root.querySelectorAll('*')].filter(element=>element.getClientRects().length&&['auto','scroll'].includes(getComputedStyle(element).overflowY)&&element.scrollHeight>element.clientHeight+2);
  return elements.map(element=>({className:element.className,nested:elements.some(other=>other!==element&&other.contains(element))}));
 });assert.equal(scrolling.some(element=>element.nested),false,name+': no nested vertical review/edit scrollers');check(name+' vertical scroll ownership',scrolling);
}
async function detailActions(view,name){
 const button=view.locator('.route-details').getByRole('button',{name:'길안내 시작',exact:true});
 assert.equal(await button.evaluate(element=>!!element.closest('.detail-body')),false,'Primary action must be outside detail scrolling content');
 const before=await exposedControl(button);await view.locator('.detail-body').evaluate(element=>{element.scrollTop=element.scrollHeight;});
 const after=await exposedControl(button);assert.ok(Math.abs(before.y-after.y)<1,'Detail action stays fixed while reading');
 check(name+' fixed detail action',{before,after});return button;
}
async function guide(view,name){
 await view.getByRole('button',{name:'길안내 시작',exact:true}).click();await view.locator('.navigation-panel').waitFor();
 assert.equal(await view.getByRole('button',{name:'길안내 시작',exact:true}).count(),0,'Guidance must not retain duplicate Start actions');
 assert.equal(await view.locator('.detail-body:visible,.results-scroll:visible').count(),0,'Review content is separate from active movement guidance');
 const panel=view.locator('.navigation-panel');assert.ok((await panel.locator('h3').innerText()).trim());
 const enabled=panel.locator('.nav-actions button:not(:disabled)');
 for(let index=0;index<await enabled.count();index++)await exposedControl(enabled.nth(index));
 const next=panel.locator('.nav-actions button').last();
 if(await next.isEnabled()){await next.click();assert.equal(await panel.locator('.nav-actions button').first().isEnabled(),true);}
 const close=view.getByRole('button',{name:'경로 안내 닫기',exact:true});await exposedControl(close);
 assert.match(await view.locator('.source-attribution:visible').first().innerText(),/NAVER/);
 await noOverflow(view,name);await screenshot(view,name);await close.click();
}
function derive(snapshot){
 const result=structuredClone(snapshot),journey=result.journey;
 for(const route of journey.routes){const existing=journey.assessments[route.id];const blockedPassageIds=existing?.blockedPassageIds??[],decision=evaluateRoute(route,journey.evidence,blockedPassageIds,journey.maxSlope,{state:result.phase==='running'?'searching':'finished',attempts:0,alternatives:0,reason:'CONTROLLED UI ONLY — evaluator projection; no actual analysis'});journey.assessments[route.id]={blockedPassageIds,decision,admission:assessRouteAdmission({route,decision,blockedPassageIds,maxSlope:journey.maxSlope})};}
 journey.recommendedId=recommendedRoute(journey.routes,journey.evidence,journey.assessments,journey.maxSlope);journey.status=journey.recommendedId?'ready':'limited';
 result.progress={checked:Object.values(journey.evidence).filter(item=>item.stage!=='reserved'&&item.finding&&item.source).length,total:journey.routes.reduce((sum,route)=>sum+route.samples.length,0),analyses:0,notice:'CONTROLLED UI ONLY — evaluator-derived state; not live analysis'};
 return journeySnapshotResponse.parse(result);
}
function clearEvidence(route){return Object.fromEntries(route.samples.map(sample=>[route.id+':'+sample.id,{stage:'processed',sampleId:sample.id,status:'clear',reason:'CONTROLLED UI ONLY — fabricated structured observation for presentation coverage',checkedAt:new Date().toISOString(),source:{url:'https://example.invalid/controlled-ui-only',capturedAt:null,coord:sample.coord,distance:0},finding:{status:'clear',reason:'CONTROLLED UI ONLY — not a real image finding',evidence:[],limitations:['CONTROLLED UI ONLY — no observation asserted'],pathVisible:true,visibility:'visible',routeMatch:'same-path',observation:{connection:'flush',surface:'continuous',uncertainty:'none',target:sample.target??'sidewalk',reason:'CONTROLLED UI ONLY — not a real image finding'}}}]));}
function phaseFixtures(seed){
 // Real shapes and geometry are retained. A candidate that has real independent blockers is never silently promoted.
 const eligible=seed.journey.routes.filter(route=>!blocked(route,seed.journey)&&route.samples.length&&route.graphCoverage?.status==='available'&&!route.unverifiedConnections?.length&&!route.unresolvedCrossings?.length);
 assert.ok(eligible.length>=1,'Completed fixture needs an actual route with resolved graph/connections and no physical blockers');
 const route=eligible[0],required=route.samples.find(sample=>sample.critical||['crossing-entry','crossing-exit','arrival','entrance'].includes(sample.target));assert.ok(required,'Required-unknown coverage needs an actual required sample');
 const make=(name,phase,evidence)=>derive({...structuredClone(seed),phase,captures:[],journey:{...structuredClone(seed.journey),routes:[structuredClone(route)],assessments:{[route.id]:structuredClone(seed.journey.assessments[route.id])},evidence}});
 const completed=make('recommended-complete','ready',clearEvidence(route));assert.equal(completed.journey.assessments[route.id].decision.kind,'recommended');
 const unknownEvidence=clearEvidence(route),id=route.id+':'+required.id;
 unknownEvidence[id].status='unknown';unknownEvidence[id].finding={...unknownEvidence[id].finding,status:'unknown',visibility:'unobservable',observation:{...unknownEvidence[id].finding.observation,connection:'unobservable',surface:'unobservable',reason:'CONTROLLED UI ONLY — required connection unobservable'}};
 const requiredUnknown=make('required-unknown','limited',unknownEvidence);assert.equal(requiredUnknown.journey.assessments[route.id].decision.kind,'hold');
 const failure=make('service-failure','failed',{[id]:{sampleId:required.id,stage:'processed',status:'unknown',failure:'service',reason:'CONTROLLED UI ONLY — analysis service failed',checkedAt:new Date().toISOString()}});assert.equal(failure.journey.assessments[route.id].decision.kind,'hold');
 const pending=make('pending','running',{}),stopped=make('canceled','canceled',{});
 const other=seed.journey.routes.find(candidate=>candidate.id!==route.id&&!blocked(candidate,seed.journey)&&candidate.samples.length);assert.ok(other,'Overall-ready selected-pending coverage needs another actual complete candidate');
 const overall=derive({...structuredClone(completed),journey:{...structuredClone(completed.journey),routes:[structuredClone(route),structuredClone(other)],assessments:{...structuredClone(completed.journey.assessments),[other.id]:structuredClone(seed.journey.assessments[other.id])}}});
 assert.equal(overall.journey.status,'ready');assert.equal(overall.journey.assessments[other.id].decision.kind,'hold');
 return [{name:'pending',snapshot:pending,route,kind:'pending'},{name:'recommended-complete',snapshot:completed,route,kind:'recommended'},{name:'required-unknown',snapshot:requiredUnknown,route,kind:'required'},{name:'service-failure',snapshot:failure,route,kind:'error'},{name:'canceled',snapshot:stopped,route,kind:'required'},{name:'overall-ready-selected-pending',snapshot:overall,route:other,kind:'required'}];
}
async function fixturePage(snapshot){
 const view=await context.newPage(),gate=Promise.withResolvers();let advances=0;
 await view.route('**/api/action',async intercepted=>{const body=intercepted.request().postDataJSON();if(body.action==='journey'||body.action==='status')return intercepted.fulfill({json:snapshot});if(body.action==='advance'){advances++;await gate.promise;return intercepted.abort().catch(()=>{});}if(body.action==='cancel')return intercepted.fulfill({json:{...snapshot,phase:'canceled'}});return intercepted.continue();});
 await view.goto(base.href,{waitUntil:'domcontentloaded'});await realNaverTiles(view);await view.locator('.search-button').click();await view.locator('.route-card').first().waitFor();
 return {view,close:async()=>{gate.resolve();await view.close();},advances:()=>advances};
}
try{
 if(beforeDir){
  const beforeFiles=(await readdir(beforeDir)).filter(name=>name.endsWith('.png')||name==='report.json');assert.ok(beforeFiles.some(name=>name.endsWith('.png')),'A supplied baseline must contain actual preserved screenshots');
  report.before={directory:beforeDir,comparisonAvailable:true,files:await Promise.all(beforeFiles.map(async name=>({name,sha256:hash(await readFile(path.join(beforeDir,name)))})))};
 }else report.before={directory:null,comparisonAvailable:false,files:[],reason:'No pre-edit screenshots supplied; this run cannot assert a before/after comparison'};
 page=await context.newPage();
 await page.route('**/api/action',async intercepted=>{
  const body=intercepted.request().postDataJSON();if(body.action==='advance'){held++;await release.promise;return intercepted.abort().catch(()=>{});}
  if(body.action==='journey')inputs={start:body.start,end:body.end};
  const response=await intercepted.fetch();if(!['journey','status','cancel'].includes(body.action))return intercepted.fulfill({response});
  const data=journeySnapshotResponse.parse(await response.json());jobs.add(data.jobId);latest=data;if(body.action==='journey')initial=structuredClone(data);if(body.action==='cancel')canceled.add(data.jobId);
  return intercepted.fulfill({response,json:data});
 });
 await page.goto(base.href,{waitUntil:'domcontentloaded'});check('actual initial NAVER tiles',await realNaverTiles(page));
 check('desktop native window and CSS viewport',await page.evaluate(()=>window.__uxNativeInputBounds));
 assert.equal((await sdk(page)).installed,true);assert.ok((await sdk(page)).maps>0);
 await choosePlace(page,'출발지','경희대학교 국제캠퍼스 예술디자인대학관');await choosePlace(page,'도착지','맥도날드 경희대국제캠퍼스점');
 await exposedControl(page.getByRole('button',{name:'경로 찾기',exact:true}));await page.locator('.search-button').click();await page.locator('.route-card').first().waitFor({timeout:90000});
 await page.locator('.place-entrance [role=alert]').waitFor();assert.ok(entranceBoundary.requests>0,'Submitted trips must request entrance confirmation automatically');assert.equal(await page.locator('.place-entrance .entrance-photos').count(),0,'A controlled service failure must not invent entrance photos or a verdict');
 const modeBar=page.getByRole('group',{name:'이동 방법',exact:true});assert.equal(await modeBar.isVisible(),true);assert.equal(await modeBar.getByRole('button',{name:'도보',exact:true}).getAttribute('aria-pressed'),'true');assert.equal(await modeBar.getByRole('button',{name:'대중교통',exact:true}).isVisible(),true);
 check('compact mode bar and automatic entrance boundary',{mode:'walk',entranceFailure:'CONTROLLED TECHNICAL FAILURE',actualEntranceAnalysis:false});
 assert.ok(initial?.jobId&&initial.journey.routes.length);assert.equal(initial.phase,'running');assert.equal(Object.values(initial.journey.evidence).some(item=>item.finding),false);
 await writeFile(path.join(output,'live-initial-snapshot.json'),JSON.stringify(initial,null,2));await writeFile(path.join(output,'live-inputs.json'),JSON.stringify(inputs,null,2));
 const actual=initial.journey.routes;assert.equal(await page.locator('.route-card').count(),actual.length);
 report.defaultSelection=await page.locator('.route-card.selected').evaluate(element=>({routeId:element.dataset.routeId,name:element.querySelector('.route-card-top>b')?.textContent,reason:element.querySelector('.route-selection-reason')?.textContent}));
 await screenshot(page,'desktop-default-selection');
 const route=actual.filter(candidate=>!blocked(candidate,initial.journey)&&candidate.grade?.segments.length&&candidate.samples.some(sample=>sample.target==='crossing-entry')).sort((a,b)=>b.samples.filter(sample=>sample.target==='crossing-entry').length-a.samples.filter(sample=>sample.target==='crossing-entry').length)[0];assert.ok(route,'Real complete route with actual grade and crossing data is required');
 for(const candidate of actual){await chooseRoute(page,candidate);await page.waitForFunction(({coords,color})=>window.__uxSDK.snapshot().lines.some(line=>line.color===color&&line.zIndex===3&&JSON.stringify(line.coords)===JSON.stringify(coords)),{coords:candidate.coords,color:UNKNOWN_GRADE.color});const lines=(await sdk(page)).lines;assert.ok(lines.some(line=>sameCoords(line.coords,candidate.coords)&&line.color===UNKNOWN_GRADE.color&&line.weight===7&&line.zIndex===3),'Selected actual route keeps unknown gaps gray');for(const other of actual)assert.ok(lines.some(line=>sameCoords(line.coords,other.coords)),'Every route uses returned actual geometry');}
 await chooseRoute(page,route);check('real search and route geometry',{inputs,routes:actual.map(candidate=>({id:candidate.id,name:candidate.name,coordinates:candidate.coords.length,grade:candidate.grade?.status}))});
 await screenshot(page,'desktop-pending-results');
 const mapDetails=page.locator('.route-map-details');assert.equal(await mapDetails.getAttribute('open'),null,'Main grade and crossing detail is collapsed by default');assert.equal(await mapDetails.locator('.terrain-profile').isVisible(),false,'The main grade profile stays behind its compact disclosure');await mapDetails.locator(':scope > summary').filter({hasText:'경사·횡단 상세'}).click();assert.equal(await mapDetails.locator('.terrain-profile').isVisible(),true,'Opening grade and crossing detail exposes the actual profile');await mapDetails.locator('.map-display-options > summary').click();
 const threshold=page.getByRole('combobox',{name:'경사 통계 기준',exact:true});
 const expectedSegments=route.grade.segments.map(segment=>({coords:segment.coords,color:gradeBand(segment.gradePercent).color}));
 for(const value of [5,8,12]){
  await threshold.selectOption(String(value));
  await page.waitForFunction(expected=>{const lines=window.__uxSDK.snapshot().lines;return expected.every(segment=>lines.some(line=>line.color===segment.color&&line.weight===7&&line.zIndex===4&&JSON.stringify(line.coords)===JSON.stringify(segment.coords)));},expectedSegments);
  const lines=(await sdk(page)).lines;
  assert.ok(lines.some(line=>line.color===UNKNOWN_GRADE.color&&line.weight===7&&line.zIndex===3&&sameCoords(line.coords,route.coords)),'Selected base keeps unknown gaps gray');
  assert.equal(lines.filter(line=>line.zIndex===4).length,expectedSegments.length,'Only actual measured segments receive foreground grade colors');
  for(const segment of expectedSegments)assert.ok(lines.some(line=>sameCoords(line.coords,segment.coords)&&line.color===segment.color&&line.weight===7&&line.zIndex===4),'Statistics threshold cannot recolor the actual foreground segments');
  const expectedCount=route.grade.segments.filter(segment=>Math.abs(segment.gradePercent)>=value).length;
  assert.ok((await page.locator('.route-map-details .terrain-summary').innerText()).includes(expectedCount?`${expectedCount}구간`:`${value}% 이상 경사 없음`),'Statistics threshold changes the numeric summary');
 }
 await threshold.selectOption('8');
 if(!await page.locator('.legend-grade-line').first().isVisible())await page.getByRole('button',{name:'통행 상태 범례 보기',exact:true}).click();
 for(const band of [...GRADE_BANDS,UNKNOWN_GRADE]){
  const legend=page.locator(`.legend-grade-line.${band.className}`);assert.equal(await legend.isVisible(),true);
  const expectedRgb=`rgb(${[1,3,5].map(index=>parseInt(band.color.slice(index,index+2),16)).join(', ')})`;
  assert.equal(await legend.evaluate(element=>getComputedStyle(element).backgroundColor),expectedRgb,'Map legend matches the actual foreground grade color');
  assert.ok((await legend.locator('..').innerText()).includes(band.label),'Map legend states the exact range or unknown data');
 }
 check('shared foreground grade and range legend',{bands:GRADE_BANDS,unknown:UNKNOWN_GRADE});
 const profile=page.locator('.route-map-details .terrain-profile');await profile.waitFor();const profileControl=profile.locator('[data-grade-index="0"]');await profileControl.click();assert.equal(await profileControl.getAttribute('aria-pressed'),'true');
 await page.waitForFunction(segment=>window.__uxSDK.snapshot().lines.some(line=>line.color==='#213b34'&&line.weight>7&&JSON.stringify(line.coords)===JSON.stringify(segment.coords)),route.grade.segments[0]);
 // A real pointer lands on the SDK's projected grade path, not a fabricated React or SDK event.
 const point=await page.evaluate(segments=>{const map=window.__uxSDK.maps.at(-1).instance,box=document.querySelector('.map').getBoundingClientRect();for(let index=segments.length-1;index>0;index--)for(let vertex=1;vertex<segments[index].coords.length;vertex++){const a=segments[index].coords[vertex-1],b=segments[index].coords[vertex],coord=[(a[0]+b[0])/2,(a[1]+b[1])/2],offset=map.getProjection().fromCoordToOffset(new naver.maps.LatLng(coord[1],coord[0])),x=box.left+offset.x,y=box.top+offset.y,hit=document.elementFromPoint(x,y);if(x>box.left+60&&x<box.right-60&&y>box.top+60&&y<box.bottom-60&&hit?.closest('.map')&&!hit.closest('button,details,.map-legend'))return {x,y,index};}return null;},route.grade.segments);
 assert.ok(point,'A visible actual grade segment is required for map pointer selection');await page.mouse.click(point.x,point.y);
 await page.waitForFunction(()=>[...document.querySelectorAll('.route-map-details .terrain-profile [aria-pressed=true]')].some(element=>element.dataset.gradeIndex!=='0'));
 const selectedIndex=Number(await profile.locator('[aria-pressed=true]').getAttribute('data-grade-index'));assert.equal(selectedIndex,point.index,'Map pointer must select the matching profile segment');check('profile → map → profile grade selection',{initialIndex:0,mapPointer:point,selectedIndex,method:'Actual pointer at real SDK projection; no synthetic events'});
 await screenshot(page,'desktop-grade-and-band-legend');
 const crossings=route.samples.filter(sample=>sample.target==='crossing-entry').sort((a,b)=>a.along-b.along);assert.ok(crossings.length);
 const resetRoute=actual.find(candidate=>candidate.id!==route.id);assert.ok(resetRoute);await chooseRoute(page,resetRoute);await chooseRoute(page,route);await page.waitForFunction(()=>document.querySelectorAll('.crossing-map-cluster > summary').length>0);
 const clusters=page.locator('.crossing-map-cluster > summary');assert.ok(await clusters.count()>0,'Actual nearby crossing labels must cluster, not overlap');const clusterRect=await exposedControl(clusters.first());await clusters.first().click();const choices=page.locator('.map-popover-host .crossing-cluster-choices:visible button');await choices.first().waitFor();assert.ok(await choices.count()>1);check('actual crossing cluster expands to individual points',{clusterRect});
 for(const sample of crossings){
  const id=route.id+':'+sample.id;
  await openDetails(page,route);await page.locator('.detail-all-points > summary').click();await page.locator('.detail-all-points button[data-evidence-id='+JSON.stringify(id)+']').click();await back(page);
  const marker=await crossingPointControl(page,id);
  await marker.waitFor();const rect=await exposedControl(marker),before=(await sdk(page)).backgroundClicks;await marker.click();await page.locator('.detail-point.focused[data-evidence-id='+JSON.stringify(id)+']').waitFor();assert.equal(await marker.getAttribute('aria-pressed'),'true');assert.equal((await sdk(page)).backgroundClicks,before,'Point activation must not trigger background map selection');
  check('every real crossing synchronizes list, map and selected point',{id,rect,clustered:await marker.evaluate(element=>!!element.closest('.crossing-cluster-choices'))});await back(page);
 }
 await page.locator('.results-scroll').evaluate(element=>{element.scrollTop=element.scrollHeight;});await page.locator('.route-card.selected .route-detail-button').scrollIntoViewIfNeeded();const savedScroll=await page.locator('.results-scroll').evaluate(element=>element.scrollTop);
 await openDetails(page,route);assert.equal(await page.locator('.route-details .terrain-profile').isVisible(),true,'Route detail keeps the full grade profile visible');await detailActions(page,'desktop');await screenshot(page,'desktop-details');await page.locator('.detail-body').evaluate(element=>{element.scrollTop=0;});await screenshot(page,'desktop-details-top');await guide(page,'desktop-guide-only');assert.equal(await page.locator('.detail-body').isVisible(),true,'Review returns to the same detail context');await back(page);
 assert.ok(Math.abs((await page.locator('.results-scroll').evaluate(element=>element.scrollTop))-savedScroll)<3,'List scroll returns to its earlier position');
 for(const height of [844,480]){
  await page.setViewportSize({width:390,height});await noOverflow(page,'390x'+height);await onePanelScroll(page,'mobile-'+height+'-results');await realNaverTiles(page);await exposedControl(page.locator('.selected-route-actions button.primary'));
  check('mobile '+height+' native window and CSS viewport',await page.evaluate(()=>window.__uxNativeInputBounds));
  await screenshot(page,'mobile-'+height+'-results');await openDetails(page,route);await onePanelScroll(page,'mobile-'+height+'-details');await detailActions(page,'mobile-'+height);await screenshot(page,'mobile-'+height+'-details');await page.locator('.detail-body').evaluate(element=>{element.scrollTop=0;});await screenshot(page,'mobile-'+height+'-details-top');await guide(page,'mobile-'+height+'-guide-only');await back(page);
  const hitRects=await page.locator('.map [data-evidence-id],.map .crossing-map-cluster > summary').evaluateAll(elements=>elements.filter(element=>element.getClientRects().length).map(element=>{const rect=element.getBoundingClientRect();return {id:element.dataset.evidenceId??'cluster',width:rect.width,height:rect.height};}));assert.ok(hitRects.every(rect=>rect.width>=44&&rect.height>=44));check('mobile '+height+' map touch rectangles',hitRects);
  if(height===480)for(const sample of [...crossings].reverse()){
   await chooseRoute(page,resetRoute);await chooseRoute(page,route);
   await page.waitForFunction(()=>window.__uxSDK.maps.at(-1).instance.getZoom()<=14);
   const id=route.id+':'+sample.id,control=await crossingPointControl(page,id),rect=await exposedControl(control);
   const menu=await control.evaluate(element=>{const menu=element.closest('.crossing-cluster-choices');return menu?{scrollTop:menu.scrollTop,clientHeight:menu.clientHeight,scrollHeight:menu.scrollHeight}:null;});
   await control.tap();await page.locator('.detail-point.focused[data-evidence-id='+JSON.stringify(id)+']').waitFor();
   check('short map native wheel and touchscreen crossing choice',{id,rect,menu,method:'Actual Playwright mouse wheel and native touchscreen tap, no DOM scrolling'});
   await back(page);
  }
 }
 await page.getByRole('button',{name:'출발지·도착지 및 조건 변경',exact:true}).click();assert.equal(await page.getByRole('button',{name:'중지',exact:true}).isVisible(),true,'Analysis cancellation stays available while editing search conditions');
 const canceledResponse=page.waitForResponse(response=>response.url().endsWith('/api/action')&&response.request().postDataJSON()?.action==='cancel'&&response.ok());await page.getByRole('button',{name:'중지',exact:true}).click();await canceledResponse;await page.waitForFunction(()=>!document.querySelector('.progress button'));assert.equal(latest.phase,'canceled');assert.ok(canceled.has(initial.jobId));assert.ok(held>0);release.resolve();
 await writeFile(path.join(output,'live-canceled-snapshot.json'),JSON.stringify(latest,null,2));check('actual held analysis canceled',{held,forwarded:0,jobId:initial.jobId,phase:latest.phase});
 await noOverflow(page,'mobile short edit');await onePanelScroll(page,'mobile short edit');await exposedControl(page.getByRole('button',{name:'경로 찾기',exact:true}));await screenshot(page,'mobile-480-edit');await page.close();page=null;
 for(const fixture of phaseFixtures(initial)){
  await writeFile(path.join(output,'controlled-'+fixture.name+'.json'),JSON.stringify({scope:'CONTROLLED UI ONLY — fabricated observations, actual schema and evaluator; never live accessibility evidence',snapshot:fixture.snapshot},null,2));
  const replay=await fixturePage(fixture.snapshot);page=replay.view;
  try{await label(page,'CONTROLLED UI ONLY — '+fixture.name+'; not live analysis');await chooseRoute(page,fixture.route);const status=page.locator('.route-card.selected [data-analysis-kind]');assert.equal(await status.getAttribute('data-analysis-kind'),fixture.kind,fixture.name+' must describe the selected route, not global phase');assert.ok((await status.innerText()).trim());const activity=page.locator('.analysis-activity');assert.equal(await activity.getAttribute('aria-busy'),String(fixture.snapshot.phase==='running'));assert.doesNotMatch(await activity.innerText(),/\d+\s*%|\d+\s*분\s*(후|남)|예상\s*완료/,'No fabricated analysis percentage or ETA');await screenshot(page,'controlled-'+fixture.name);check('controlled '+fixture.name,{schemaValidated:true,decision:fixture.snapshot.journey.assessments[fixture.route.id].decision.kind,status:fixture.kind,globalPhase:fixture.snapshot.phase,globalStatus:fixture.snapshot.journey.status,notLiveEvidence:true});}finally{await replay.close();page=null;}
 }
 // Archive identity and byte/hash proof are separate from the fresh search above.
 const [saved,chosen,proof,photo]=await Promise.all([readFile(path.join(archiveDir,'route-job-canceled.json'),'utf8').then(JSON.parse),readFile(path.join(archiveDir,'chosen-source.json'),'utf8').then(JSON.parse),readFile(path.join(archiveDir,'report.json'),'utf8').then(JSON.parse),readFile(path.join(archiveDir,'archived-source.png'))]);
 assert.equal(hash(photo),proof.privateImage.sha256,'Archived photo must match genuine recorded proof exactly');
 const capture=saved.captures.find(item=>item.id===chosen.capture.id);assert.ok(capture);assert.deepEqual(saved.journey.evidence[capture.evidenceId],chosen.finding,'Photo and original observation identity cannot change');
 const archivedRoute=structuredClone(saved.journey.routes.find(candidate=>candidate.samples.some(sample=>candidate.id+':'+sample.id===capture.evidenceId)));assert.ok(archivedRoute);
 // Current-schema projection only removes retired POI-centroid diagnostics; no archived photo/finding/source is edited.
 const retiredConnections=archivedRoute.unverifiedConnections?.filter(connection=>!['station','underpass','elevator'].includes(connection.kind))??[];
 archivedRoute.unverifiedConnections=archivedRoute.unverifiedConnections?.filter(connection=>['station','underpass','elevator'].includes(connection.kind));
 check('archive schema migration',{retiredConnectionKinds:retiredConnections.map(connection=>connection.kind),preservedFinding:true,scope:'Earlier POI-centroid diagnostics retired by existing outdoor guidance policy; not access evidence'});
 const archivedCaptures=saved.captures.filter(item=>item.evidenceId.startsWith(archivedRoute.id+':'));
 const snapshot=derive({...saved,phase:'canceled',captures:archivedCaptures,journey:{...saved.journey,routes:[archivedRoute],assessments:{[archivedRoute.id]:saved.journey.assessments[archivedRoute.id]}}});
 page=await context.newPage();await page.route('**/api/action',async intercepted=>{const body=intercepted.request().postDataJSON();if(body.action==='journey'||body.action==='status')return intercepted.fulfill({json:snapshot});if(body.action==='cancel')return intercepted.fulfill({json:snapshot});if(body.action==='advance')throw Error('Genuine archive replay must never forward analysis');return intercepted.continue();});
 await page.route('**/api/journey-image?*',async intercepted=>{assert.equal(new URL(intercepted.request().url()).searchParams.get('id'),capture.id);return intercepted.fulfill({body:photo,contentType:'image/jpeg',headers:{'cache-control':'private, no-store'}});});
 await page.goto(base.href,{waitUntil:'domcontentloaded'});await realNaverTiles(page);await page.locator('.search-button').click();await page.locator('.route-card').first().waitFor();await label(page,'GENUINE EARLIER ARCHIVE REPLAY — not current route analysis');await openDetails(page,archivedRoute);
 await page.locator('.detail-all-points > summary').click();
 for(const point of archivedRoute.samples){const count=archivedCaptures.filter(item=>item.evidenceId===archivedRoute.id+':'+point.id).length;if(count)assert.match(await page.locator('.detail-all-points button[data-evidence-id='+JSON.stringify(archivedRoute.id+':'+point.id)+']').innerText(),new RegExp('보관 사진 '+count+'장'),'Every archived frame remains reachable from its original point');}
 await page.locator('.detail-all-points button[data-evidence-id='+JSON.stringify(capture.evidenceId)+']').click();
 const frame=page.locator('.capture-thumbnail img').first();await frame.waitFor();await frame.scrollIntoViewIfNeeded();await page.waitForFunction(()=>[...document.querySelectorAll('.capture-thumbnail img')].some(image=>image.complete&&image.naturalWidth>128));assert.equal(await frame.getAttribute('src'),capture.url);
 const bytes=Buffer.from(await frame.evaluate(async element=>Array.from(new Uint8Array(await(await fetch(element.src)).arrayBuffer()))));assert.deepEqual(bytes,photo);
 const row=frame.locator('xpath=ancestor::figure');const sourceLink=row.getByRole('link',{name:/촬영 위치 원본/});await row.locator('.evidence-photo-secondary > summary').click();assert.equal(await sourceLink.getAttribute('href'),capture.source.url);
 assert.match(await row.innerText(),/NAVER/);if(capture.source.capturedMonth)assert.ok((await row.innerText()).includes(capture.source.capturedMonth),'Recorded shooting month is preserved');
 const enlarge=row.getByRole('button',{name:'사진 크게 보기',exact:true});await enlarge.click();await page.locator('.evidence-photo-dialog').waitFor();assert.equal(await page.locator('.evidence-photo-dialog img').getAttribute('src'),capture.url);await screenshot(page,'archive-native-photo-dialog');await page.keyboard.press('Escape');assert.equal(await enlarge.evaluate(element=>document.activeElement===element),true);
 await screenshot(page,'archive-original-photo');const opener=row.locator('.roadview-open-btn');await opener.click();
 const source=new URL(capture.source.url),expected={panoId:capture.source.panoId,pan:Number(source.searchParams.get('heading')),tilt:Number(source.searchParams.get('tilt')),fov:Number(source.searchParams.get('fov'))};
 await page.waitForFunction(expected=>{const actual=window.__uxSDK.snapshot().panorama;return actual?.ready&&actual.panoId===expected.panoId&&Math.abs(((actual.pov.pan-expected.pan+540)%360)-180)<.01&&Math.abs(actual.pov.tilt-expected.tilt)<.01&&Math.abs(actual.pov.fov-expected.fov)<.01;},expected,{timeout:30000});
 await realNaverTiles(page,'.roadview-modal-viewport',30000);await screenshot(page,'archive-exact-source-native360');await page.keyboard.press('Escape');assert.equal(await opener.evaluate(element=>document.activeElement===element),true);assert.deepEqual(Buffer.from(await frame.evaluate(async element=>Array.from(new Uint8Array(await(await fetch(element.src)).arrayBuffer())))),photo,'360 exploration never replaces original source bytes');
 check('genuine archive exact photo, source link and native panorama',{archiveDir,sha256:hash(photo),captureId:capture.id,evidenceId:capture.evidenceId,expectedPose:expected,newAIInference:false});
 assert.deepEqual(errors,[]);report.status='passed';
}catch(error){report.failure=String(error.message??error);report.failureStack=String(error.stack??'');process.exitCode=1;if(page){report.failureSDK=await sdk(page).catch(()=>null);await screenshot(page,'failure').catch(()=>{});}}
finally{
 release.resolve();for(const jobId of jobs)if(!canceled.has(jobId))try{await cancel(jobId);}catch(error){errors.push(String(error.message));}
 report.jobs={created:jobs.size,canceled:canceled.size};report.analysisAdvancesHeld=held;if(errors.length||jobs.size!==canceled.size){report.status='failed';process.exitCode=1;}
 report.finishedAt=new Date().toISOString();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));await context.close();await browser.close();console.log(JSON.stringify({status:report.status,checks:checks.length,jobs:report.jobs,failure:report.failure,report:path.join(output,'report.json')}));
}
