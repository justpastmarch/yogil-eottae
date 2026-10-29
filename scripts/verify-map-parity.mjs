import {assessRouteAdmission} from '../lib/domain.ts';
import {gradeBand,UNKNOWN_GRADE} from '../app/grade-colors.ts';
import {chromium} from '../services/roadview-renderer/node_modules/playwright/index.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {crossingPointControl,ensureNativeInputBounds} from './ux-refresh-driver-utils.mjs';

// Run against the corresponding real provider checkout/server; this does not switch production providers.
const provider=process.env.MAP_PROVIDER??'naver';
assert.ok(['kakao','naver'].includes(provider),'MAP_PROVIDER must be kakao or naver');
const base=new URL(process.env.MAP_BASE_URL??'http://localhost:3000/');
assert.ok(['localhost','127.0.0.1','[::1]'].includes(base.hostname),'MAP_BASE_URL must be a real localhost server');
assert.equal(base.username+base.password+base.search+base.hash,'','Do not put credentials in MAP_BASE_URL');
const output=process.env.MAP_REPORT_DIR??fileURLToPath(new URL(`../.sites-runtime/naver-migration/${provider}-parity/`,import.meta.url));
await mkdir(output,{recursive:true});
const entranceBoundary={mode:'CONTROLLED TECHNICAL FAILURE',httpStatus:503,requests:0,actualEntranceAnalysis:false};
const report={provider,base:base.origin,startedAt:new Date().toISOString(),status:'failed',scope:'Real SDK, real provider tiles and real local routing. Analysis advance held, automatic entrance requests receive a controlled technical failure, and real jobs canceled; no AI/accessibility findings asserted.',checks:[],errors:[],syntheticUIOnly:null,entranceBoundary};
let browser,context,page,latest,journeyInputs,synthetic=false,syntheticRouteId,syntheticRouteName,releaseAdvance=Promise.withResolvers();
const jobs=new Set(),canceled=new Set();
const redact=value=>String(value).replace(/https?:\/\/[^\s<>"']+/g,raw=>{try{const url=new URL(raw);return `${url.origin}/[url-redacted]`;}catch{return '[url-redacted]';}}).replace(/((?:client[_-]?id|ncpKeyId|appkey|api[_-]?key|authorization)\s*[:=]\s*)[^\s,;]+/gi,'$1[redacted]');
const check=(name,evidence)=>report.checks.push({name,evidence});

// All instrumentation delegates to the real constructors and event system. It lives only in this browser.
function instrumentRealSDK(expectedProvider){
 const state={maps:[],lines:[],overlays:[],clicks:0,lastClick:null,installed:[]};
 Object.defineProperty(window,'__mapParity',{value:state});
 const coord=point=>[typeof point?.lng==='function'?point.lng():point?.getLng?.(),typeof point?.lat==='function'?point.lat():point?.getLat?.()];
 const points=value=>{const array=Array.isArray(value)?value:value?.getArray?.()??[];return array.map(coord);};
 const seen=new WeakSet();
 function install(sdk,kind){
  if(!sdk||!sdk.Map||!sdk.Polyline||!(kind==='naver'?sdk.Event:sdk.event)?.addListener||!sdk[kind==='naver'?'Marker':'CustomOverlay']||seen.has(sdk))return;
  seen.add(sdk);state.installed.push(kind);
  for(const [name,bucket] of [['Map','maps'],['Polyline','lines'],[kind==='naver'?'Marker':'CustomOverlay','overlays']]){
   const Original=sdk[name];if(typeof Original!=='function')continue;
   sdk[name]=new Proxy(Original,{construct(target,args,newTarget){
    const instance=Reflect.construct(target,args,newTarget),options=args[name==='Map'?1:0]??{};
    const record={instance,options,map:name==='Map'?instance:options.map};state[bucket].push(record);
    if(name!=='Map'&&typeof instance.setMap==='function'){
     const setMap=instance.setMap;instance.setMap=function(map){record.map=map;return Reflect.apply(setMap,this,[map]);};
    }
    return instance;
   }});
  }
  const events=kind==='naver'?sdk.Event:sdk.event,add=events.addListener,remove=events.removeListener,wrapped=new WeakMap();
  events.addListener=function(target,name,callback,...rest){
   let listener=callback;
   if(name==='click'&&state.maps.some(record=>record.instance===target)&&typeof callback==='function'){
    listener=function(event){state.clicks++;state.lastClick=coord(event?.coord??event?.latLng);return Reflect.apply(callback,this,arguments);};
    wrapped.set(callback,listener);
   }
   return Reflect.apply(add,this,[target,name,listener,...rest]);
  };
  if(kind==='kakao')events.removeListener=function(target,name,callback,...rest){return Reflect.apply(remove,this,[target,name,wrapped.get(callback)??callback,...rest]);};
 }
 function discover(){
  install(window.naver?.maps,'naver');install(window.kakao?.maps,'kakao');
  const sdk=window.kakao?.maps;
  if(sdk?.load&&!sdk.load.__parityWrapped){
   const load=sdk.load;const wrapper=function(callback){return Reflect.apply(load,this,[function(){discover();return Reflect.apply(callback,this,arguments);}]);};
   wrapper.__parityWrapped=true;sdk.load=wrapper;
  }
 }
 const callbacks=new Set();
 function watchScript(script){
  if(!(script instanceof HTMLScriptElement))return;
  let url;try{url=new URL(script.src);}catch{return;}
  if(!/(?:map\.naver\.com|dapi\.kakao\.com)$/.test(url.hostname))return;
  const name=url.searchParams.get('callback');
  if(name&&!name.includes('.')&&!callbacks.has(name)){
   callbacks.add(name);const callback=window[name];
   if(typeof callback==='function')window[name]=function(){discover();queueMicrotask(discover);return Reflect.apply(callback,this,arguments);};
  }
 }
 new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes){watchScript(node);node.querySelectorAll?.('script[src]').forEach(watchScript);}discover();}).observe(document,{childList:true,subtree:true});
 window.addEventListener('load',event=>{if(event.target instanceof HTMLScriptElement)discover();},true);
 state.snapshot=()=>({provider:expectedProvider,installed:state.installed,clicks:state.clicks,lastClick:state.lastClick,maps:state.maps.length,center:coord(state.maps.at(-1)?.instance.getCenter?.()),lines:state.lines.filter(record=>record.map).map(record=>({coords:points(record.options.path),color:record.options.strokeColor,weight:record.options.strokeWeight,style:record.options.strokeStyle,zIndex:record.options.zIndex})),overlays:state.overlays.filter(record=>record.map).map(record=>({coord:coord(record.options.position),label:(record.options.icon?.content??record.options.content)?.getAttribute?.('aria-label')??(record.options.icon?.content??record.options.content)?.querySelector?.('[aria-label]')?.getAttribute('aria-label')}))});
}

async function snapshot(){return page.evaluate(()=>window.__mapParity.snapshot());}
function sameCoords(actual,expected){return actual.length===expected.length&&actual.every((coord,index)=>coord.every((value,axis)=>Math.abs(value-expected[index][axis])<1e-8));}
async function tiles(label){
 check('native window and CSS viewport',await ensureNativeInputBounds(page));
 // Logos, panorama/source photographs, tracking pixels, and unloaded image placeholders cannot satisfy this check.
 const inspect=({provider})=>{const loaded=[...document.querySelectorAll('.map img')].flatMap(image=>{
  const url=(()=>{try{return new URL(image.currentSrc||image.src);}catch{return null;}})(),box=image.getBoundingClientRect(),map=image.closest('.map').getBoundingClientRect();
  const source=url&&(provider==='naver'?/(^|\.)(?:pstatic\.net|naver\.com|naver\.net|navermaps\.com)$/.test(url.hostname)&&/(?:tile|basemap|maptile|\/(?:nrb[^/]*\/)?styles\/|\/get\/)/i.test(url.pathname):/(^|\.)(?:daumcdn\.net|kakaocdn\.net|daum\.net|kakao\.com)$/.test(url.hostname)&&/(?:map_2d|maptile|tile|map_skyview)/i.test(url.pathname));
  if(!source||/(?:logo|copyright|roadview|panorama|streetview)/i.test(url.pathname)||!image.complete||image.naturalWidth<128||image.naturalHeight<128||box.width<100||box.height<100||box.right<=map.left||box.left>=map.right||box.bottom<=map.top||box.top>=map.bottom)return [];
  return [{host:url.hostname,width:image.naturalWidth,height:image.naturalHeight,displayWidth:Math.round(box.width),displayHeight:Math.round(box.height)}];
 });return loaded.length>=2?loaded:false;};
 const handle=await page.waitForFunction(inspect,{provider},{timeout:45000}).catch(()=>{throw new Error(`${provider} real map tiles unavailable: valid provider credentials/domain authorization and network access are prerequisites (SDK constructors alone do not pass)`);});
 const loaded=await handle.jsonValue();await handle.dispose();check(label,{loadedTiles:loaded.length,tiles:loaded.slice(0,6)});
}
async function waitCenter(expected){
 await page.waitForFunction(coord=>{const center=window.__mapParity.snapshot().center;return center.every((value,index)=>Math.abs(value-coord[index])<0.00002);},expected,{timeout:10000});
}
function syntheticIssues(data){
 const clone=structuredClone(data),route=clone.journey.routes.find(candidate=>candidate.id===syntheticRouteId)??clone.journey.routes.find(candidate=>candidate.name===syntheticRouteName);
 if(route)syntheticRouteId=route.id;
 assert.ok(route?.samples.length>=2,'Real route must have two sample locations for controlled marker UI coverage');
 const samples=[route.samples[Math.floor((route.samples.length-1)/3)],route.samples[Math.ceil((route.samples.length-1)*2/3)]];
 const issues=samples.map((sample,index)=>({id:`${route.id}:${sample.id}`,sampleId:sample.id,coord:sample.coord,along:sample.along,status:['caution','blocked'][index],source:'imagery',reason:'CONTROLLED UI ONLY: marker interaction exercise; not an imagery observation.',action:'CONTROLLED UI ONLY: not travel or accessibility evidence.'}));
 const assessment=clone.journey.assessments[route.id];
 assessment.decision={...assessment.decision,issues:[...assessment.decision.issues.filter(issue=>!issues.some(item=>item.id===issue.id)),...issues]};
 assessment.admission=assessRouteAdmission({route,decision:assessment.decision,blockedPassageIds:assessment.blockedPassageIds,maxSlope:clone.journey.maxSlope});
 return clone;
}
async function startJourney(){
 if(!await page.locator('.search-button').isVisible())await page.locator('.results-controls button').click();
 await page.locator('.search-button').click();
 await page.locator('.route-card').first().waitFor({timeout:90000});
 await page.locator('.place-entrance [role=alert]').waitFor();assert.ok(entranceBoundary.requests>0,'Submitted trips must request entrance confirmation automatically');assert.equal(await page.locator('.place-entrance .entrance-photos').count(),0,'A controlled service failure must not invent entrance photos or a verdict');
 const stop=page.getByRole('button',{name:'중지',exact:true});
 await stop.waitFor({timeout:10000});await stop.click();
 await page.waitForFunction(()=>!document.querySelector('.progress button'));
 releaseAdvance.resolve();
 assert.ok(latest?.journey?.routes.length,'A real journey response must contain route candidates');
}
async function selectRoute(route){
 await page.getByRole('button',{name:route.name+' 선택',exact:true}).click();
 await page.waitForFunction(expected=>window.__mapParity.snapshot().lines.some(line=>line.weight===7&&JSON.stringify(line.coords)===JSON.stringify(expected)),route.coords,{timeout:10000});
}
async function screenshot(name){await page.screenshot({path:path.join(output,name+'.png')});}
async function exerciseMarker(markerId,scope){
 const marker=page.locator('.map .map-evidence-hit[data-evidence-id='+JSON.stringify(markerId)+']');
 await marker.focus();
 const beforeRedraw=await page.evaluate(()=>window.__mapParity.overlays.length);
 assert.equal(await page.evaluate(()=>document.activeElement?.dataset.evidenceId),markerId);
 await page.locator('.route-map-details .terrain-profile [data-grade-index="0"]').dispatchEvent('click');
 await page.waitForFunction(({id,before})=>window.__mapParity.overlays.length>before&&document.activeElement?.dataset.evidenceId===id,{id:markerId,before:beforeRedraw},{timeout:5000});
 check('marker focus survives grade overlay redraw',{evidenceId:markerId,scope});
 for(const activation of ['mouse','Enter','Space','touch']){
  const target=page.locator('.map .map-evidence-hit[data-evidence-id='+JSON.stringify(markerId)+']'),before=(await snapshot()).clicks;
  if(activation==='mouse')await target.click();else if(activation==='touch')await target.tap();else{await target.focus();await target.press(activation);}
  await page.locator('.route-details').waitFor();
  await page.locator('.detail-point.focused,.action-issue.focused').first().waitFor();
  assert.equal(await page.locator('.map .map-evidence-hit[data-evidence-id='+JSON.stringify(markerId)+']').getAttribute('aria-pressed'),'true');
  assert.equal((await snapshot()).clicks,before,`${activation} evidence activation must not invoke app background map callback`);
  check('isolated evidence activation',{activation,evidenceId:markerId,scope});
  await page.getByRole('button',{name:'경로 목록으로',exact:true}).click();
  assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('route-detail-button')),true,'Back restores focus to route detail opener');
 }
}
async function backgroundClick(){
 const point=await page.locator('.map').evaluate(element=>{
  const box=element.getBoundingClientRect();
  for(const [x,y] of [[.74,.6],[.5,.5],[.8,.35],[.3,.7],[.9,.7]]){
   const point={x:box.left+box.width*x,y:box.top+box.height*y},target=document.elementFromPoint(point.x,point.y);
   if(target?.closest('.map')&&!target.closest('button,[data-map-overlay],a'))return point;
  }
  return null;
 });
 assert.ok(point,'A real map background must be exposed for click calibration');
 const before=(await snapshot()).clicks;await page.mouse.click(point.x,point.y);
 await page.waitForFunction(count=>window.__mapParity.clicks>count,before,{timeout:5000});
 const after=await snapshot();assert.equal(after.clicks,before+1,'Exactly one actual app map-click callback must fire per background click');
 return after.lastClick;
}

try{
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--enable-webgl','--ignore-gpu-blocklist']});
 context=await browser.newContext({viewport:{width:1440,height:960},hasTouch:true});
 await context.route('**/api/entrance',route=>{entranceBoundary.requests++;return route.fulfill({status:503,json:{error:'CONTROLLED TECHNICAL FAILURE: entrance service withheld; no image analysis performed'}});});
 await context.addInitScript(instrumentRealSDK,provider);page=await context.newPage();
 page.on('pageerror',error=>report.errors.push(redact(error.message)));
 await page.route('**/api/action',async route=>{
  let body;try{body=route.request().postDataJSON();}catch{return route.continue();}
  if(body.action==='journey')journeyInputs={start:body.start,end:body.end};
  if(body.action==='advance'){const held=releaseAdvance.promise;await held;return route.abort().catch(()=>{});}
  if(!['journey','cancel','status'].includes(body.action))return route.continue();
  const response=await route.fetch(),data=await response.json();
  if(data.jobId){jobs.add(data.jobId);if(body.action==='cancel')canceled.add(data.jobId);latest=synthetic?syntheticIssues(data):data;}
  return route.fulfill({response,json:data.jobId?latest:data});
 });
 await page.goto(base.href,{waitUntil:'domcontentloaded'});
 await page.locator('.map').waitFor();
 const configuration=await page.request.get(new URL('/api/map-config',base).href);
 if(!configuration.ok()){
  await page.locator('.tile-error').waitFor({timeout:10000});
  await screenshot('configuration-error');
  throw new Error(`Map configuration HTTP ${configuration.status()}; set ${provider==='naver'?'NAVER_MAP_CLIENT_ID':'KAKAO_JAVASCRIPT_KEY'} and restart the app before real-SDK verification`);
 }
 const publicConfiguration=await configuration.json();
 assert.ok(typeof publicConfiguration[provider==='naver'?'clientId':'javascriptKey']==='string',`The running map configuration must belong to ${provider}`);
 await tiles('initial real provider tiles');
 const initial=await snapshot();assert.ok(initial.installed.includes(provider)&&initial.maps>0,`Expected actual ${provider} SDK map instrumentation; wrong provider/server is a failure`);
 check('real SDK instance',{provider,maps:initial.maps});
 const calibration=await backgroundClick();assert.ok(calibration.every(Number.isFinite),'Actual map click callback must expose geographic coordinates');
 check('actual map callback positive calibration',{coord:calibration});
 await page.locator('#from').fill('경희대학교 국제캠퍼스 예술디자인대학관');
 await page.locator('#to').fill('맥도날드 경희대국제캠퍼스점');
 await startJourney();
 const real=structuredClone(latest),routes=real.journey.routes;
 check('actual resolved endpoints',{start:journeyInputs.start.coord,end:journeyInputs.end.coord});
 assert.equal(await page.locator('.route-card').count(),routes.length,'Every actual candidate must remain available');
 check('real routing inputs and cancellation',{routes:routes.map(route=>({id:route.id,name:route.name,coords:route.coords.length,samples:route.samples.length,grade:route.grade?.status??'unavailable',graphSegment:!!route.graphSegment})),phase:real.phase,analysis:'advance never forwarded; actual cancellation, no model calls'});
 let crossingCount=0,gradeSegments=0;
 for(const route of routes){
  await selectRoute(route);
  const rendered=await snapshot();
  for(const candidate of routes)assert.ok(rendered.lines.some(line=>sameCoords(line.coords,candidate.coords)&&line.color===UNKNOWN_GRADE.color&&line.weight===(candidate.id===route.id?7:5)),`Actual route geometry/selected width missing: ${candidate.id}`);
  const endpoints=route.graphSegment?[['출발지',journeyInputs.start.coord],['도착지',journeyInputs.end.coord]]:[['도보 출발점',route.coords[0]],['도보 도착점',route.coords.at(-1)]];
  for(const [label,coord] of endpoints){
   assert.ok(rendered.overlays.some(overlay=>overlay.label===label&&sameCoords([overlay.coord],[coord])),`${label} marker must use the returned walk path endpoint, not the POI centroid`);
   assert.equal(await page.locator('.map [aria-label='+JSON.stringify(label)+']').count(),1);
  }
  const crossings=route.samples.filter(sample=>sample.target==='crossing-entry').sort((a,b)=>a.along-b.along);
  assert.equal(await page.locator('.crossing-map-label').count(),crossings.length,'Every actual crossing entry remains available individually, including clustered labels');
  for(let index=0;index<crossings.length;index++){
   const badge=page.getByRole('button',{name:`횡단 진입점 ${index+1}, 출발 후 ${Math.round(crossings[index].along)}m, 지점 근거 보기`,exact:true,includeHidden:true});
   assert.equal(await badge.count(),1);crossingCount++;
  }
  gradeSegments+=route.grade&&route.grade.status!=='unavailable'?route.grade.segments.length:0;
  check('actual route overlay geometry',{routeId:route.id,coords:route.coords,crossings:crossings.map(sample=>({coord:sample.coord,along:sample.along})),grades:route.grade?.status??'unavailable'});
 }
 assert.ok(crossingCount>0,'The actual scenario must include crossing-entry samples; missing real crossing data is a failed prerequisite, not synthetic coverage');
 assert.ok(gradeSegments>0,'Real estimated grade segments are required; unavailable grades must not be invented');
 const chosen=routes.find(route=>!route.graphSegment&&route.samples.length>=3&&route.samples.some(sample=>sample.target==='crossing-entry')&&route.grade?.segments.length);
 assert.ok(chosen,'Need a complete real route with crossing samples, grade segments and three sample locations');
 syntheticRouteId=chosen.id;syntheticRouteName=chosen.name;await selectRoute(chosen);
 const mapDetails=page.locator('.route-map-details');assert.equal(await mapDetails.getAttribute('open'),null,'Main grade and crossing detail is collapsed by default');assert.equal(await mapDetails.locator('.terrain-profile').isVisible(),false);await mapDetails.locator(':scope > summary').filter({hasText:'경사·횡단 상세'}).click();assert.equal(await mapDetails.locator('.terrain-profile').isVisible(),true,'The disclosed profile uses the real route terrain');
 await page.locator('.map-display-options > summary').click();
 const threshold=page.getByRole('combobox',{name:'경사 통계 기준',exact:true});
 const expectedSegments=chosen.grade.segments.map(segment=>({coords:segment.coords,color:gradeBand(segment.gradePercent).color}));
 for(const value of [5,8,12]){
  await threshold.selectOption(String(value));
  await page.waitForFunction(expected=>{const lines=window.__mapParity.snapshot().lines;return expected.every(segment=>lines.some(line=>line.color===segment.color&&line.weight===7&&line.zIndex===4&&JSON.stringify(line.coords)===JSON.stringify(segment.coords)));},expectedSegments,{timeout:10000});
  const lines=(await snapshot()).lines;
  assert.ok(lines.some(line=>sameCoords(line.coords,chosen.coords)&&line.color===UNKNOWN_GRADE.color&&line.weight===7&&line.zIndex===3),'Selected base keeps gaps gray');
  assert.equal(lines.filter(line=>line.zIndex===4).length,expectedSegments.length,'Only actual measured segments receive foreground grade colors');
  for(const segment of expectedSegments)assert.ok(lines.some(line=>sameCoords(line.coords,segment.coords)&&line.color===segment.color&&line.weight===7&&line.zIndex===4),'Actual foreground grade color remains fixed when the statistics threshold changes');
  const expectedCount=chosen.grade.segments.filter(segment=>Math.abs(segment.gradePercent)>=value).length;
  assert.ok((await page.locator('.route-map-details .terrain-summary').innerText()).includes(expectedCount?`${expectedCount}구간`:`${value}% 이상 경사 없음`),'Statistics threshold still changes the numeric summary');
  check('fixed foreground grade colors and configurable statistics',{threshold:value,segments:expectedSegments.length,meaning:'Absolute-grade 10/20 display bands, not access/passability evidence'});
 }
 await threshold.selectOption('8');
 if(await page.locator('.map .map-evidence-hit').count()){
  await page.locator('.route-card.selected .route-detail-button').click();await page.locator('.detail-all-points > summary').click();
  const id=await page.locator('.map .map-evidence-hit').first().getAttribute('data-evidence-id');
  const point=page.locator('.detail-all-points button[data-evidence-id='+JSON.stringify(id)+']');assert.equal(await point.count(),1);await point.click();await page.getByRole('button',{name:'경로 목록으로',exact:true}).click();
 }
 const markerId=await page.locator('.map .map-evidence-hit').evaluateAll(elements=>elements.find(element=>{
  const box=element.getBoundingClientRect(),target=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);
  return box.width>=44&&box.height>=44&&target?.closest('.map-evidence-hit')===element;
 })?.dataset.evidenceId);
 assert.ok(markerId||await page.locator('.map .map-evidence-hit').count()===0,'Actual meaningful issue markers must retain 44px usable hit areas; controlled coverage cannot hide a broken real marker');
 if(markerId)await exerciseMarker(markerId,'actual routing issue metadata; no AI inference');
 else check('pending photos do not require map markers',{markers:0,meaning:'No meaningful obstacle/facility issue is a normal map state, not a missing-data failure'});
 await screenshot('desktop-real-routes');
 const crossing=chosen.samples.filter(sample=>sample.target==='crossing-entry').sort((a,b)=>a.along-b.along)[0];
 await page.locator('.route-map-details .terrain-crossings > summary').click();
 await page.locator('.route-map-details .terrain-crossing-points button[data-evidence-id='+JSON.stringify(chosen.id+':'+crossing.id)+']').click();await page.locator('.route-details').waitFor();await waitCenter(crossing.coord);await page.getByRole('button',{name:'경로 목록으로',exact:true}).click();
 for(const activation of ['mouse','Enter','Space','touch']){
  const id=chosen.id+':'+crossing.id,badge=await crossingPointControl(page,id);
  const before=(await snapshot()).clicks,rect=await badge.boundingBox();assert.ok(rect&&rect.width>=44&&rect.height>=44);
  if(activation==='mouse')await badge.click();else if(activation==='touch')await badge.tap();else{await badge.focus();await badge.press(activation);}
  await waitCenter(crossing.coord);await page.locator('.detail-point.focused[data-evidence-id='+JSON.stringify(id)+']').waitFor();
  assert.equal((await snapshot()).clicks,before,`${activation} crossing activation must not invoke app background callback`);
  check('isolated real crossing detail activation',{activation,coord:crossing.coord,rect});await page.getByRole('button',{name:'경로 목록으로',exact:true}).click();
 }
 // Resizing must preserve explicit location focus, not refit route bounds.
 const centerBefore=(await snapshot()).center;
 await page.getByRole('button',{name:'검색 패널 접기',exact:true}).click();
 await page.getByRole('button',{name:'검색 패널 열기',exact:true}).waitFor();await tiles('sidebar collapsed tiles');await waitCenter(centerBefore);await screenshot('desktop-sidebar-collapsed');
 await page.getByRole('button',{name:'검색 패널 열기',exact:true}).click();await waitCenter(centerBefore);
 await page.setViewportSize({width:390,height:844});await tiles('mobile real tiles');await waitCenter(centerBefore);
 const mobileMap=await page.locator('.map-area').boundingBox();assert.ok(mobileMap&&mobileMap.height>=180,'Mobile real map remains usable');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'No mobile horizontal overflow');
 await screenshot('mobile-real-routes');
 await page.locator('.route-card.selected .route-detail-button').click();await page.locator('.detail-body').waitFor();await screenshot('mobile-real-details');
 await page.getByRole('button',{name:'경로 목록으로',exact:true}).click();
 check('sidebar mobile resize and detail back',{mobileMapHeight:mobileMap.height,preservedFocusCenter:centerBefore});
 // Only absent real meaningful markers require a controlled state. Geometry, grades and SDK stay real.
 if(!markerId){
  await page.setViewportSize({width:1440,height:960});synthetic=true;releaseAdvance=Promise.withResolvers();
  await startJourney();
  const syntheticRoute=latest.journey.routes.find(route=>route.id===syntheticRouteId);assert.ok(syntheticRoute);
  await selectRoute(syntheticRoute);
  await page.evaluate(()=>{const banner=document.createElement('div');banner.dataset.syntheticUiOnly='true';banner.textContent='CONTROLLED UI ONLY — marker interactions, not imagery findings or accessibility evidence';banner.style.cssText='position:fixed;bottom:0;left:0;right:0;z-index:99999;background:#fff3cd;color:#402800;font:14px sans-serif;padding:10px;text-align:center';document.body.append(banner);});
  const colored=latest.journey.assessments[syntheticRoute.id].decision.issues.filter(issue=>issue.reason.startsWith('CONTROLLED UI ONLY:'));
  for(const issue of colored){
   const dot=page.locator('.map .map-evidence-hit[data-evidence-id='+JSON.stringify(issue.id)+'] .map-evidence-dot');
   const background=await dot.evaluate(element=>getComputedStyle(element).backgroundColor),expected={caution:'rgb(221, 107, 32)',blocked:'rgb(229, 62, 62)'}[issue.status];
   assert.equal(background,expected,'Controlled meaningful issue color parity');
  }
  if(await mapDetails.getAttribute('open')===null)await mapDetails.locator(':scope > summary').click();
  if(await page.locator('.map-display-options').getAttribute('open')===null)await page.locator('.map-display-options > summary').click();
  await exerciseMarker(colored[0].id,'CONTROLLED UI ONLY; no imagery findings injected');
  report.syntheticUIOnly={label:'CONTROLLED UI ONLY, not real access evidence',states:colored.map(issue=>({id:issue.id,status:issue.status,coord:issue.coord})),findingsInjected:false,gradesInjected:false};
  await screenshot('controlled-ui-only-marker-interactions');
 }
 // Finish with a genuine coordinate pick through the actual app map click, never an internal React setter.
 await page.locator('.results-controls button').click();
 await page.getByRole('button',{name:'출발지 지도에서 선택',exact:true}).click();
 const picked=await backgroundClick();await page.waitForFunction(expected=>window.__mapParity.snapshot().overlays.some(overlay=>overlay.label==='출발지'&&overlay.coord.every((value,index)=>Math.abs(value-expected[index])<1e-8)),picked,{timeout:10000});
 assert.equal(await page.getByRole('button',{name:'경로 찾기',exact:true}).isVisible(),true,'Picking a coordinate must return to an actionable search form');
 check('actual coordinate picking',{coord:picked});
 assert.deepEqual(report.errors,[],'Browser errors must not be ignored');report.status='passed';
}catch(error){
 report.failure=redact(error?.message??error);process.exitCode=1;
 if(page)await screenshot('failure').catch(()=>{});
}finally{
 releaseAdvance.resolve();
 if(context){for(const jobId of jobs){try{const response=await context.request.post(new URL('/api/action',base).href,{data:{action:'cancel',jobId}});if(response.ok())canceled.add(jobId);else report.errors.push(`Cleanup cancellation HTTP ${response.status()}`);}catch(error){report.errors.push(redact(error.message));}}}
 report.jobs={created:jobs.size,canceled:canceled.size};
 if(canceled.size!==jobs.size||report.errors.length){report.status='failed';process.exitCode=1;}
 await context?.close().catch(()=>{});await browser?.close().catch(()=>{});
 report.finishedAt=new Date().toISOString();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({provider,status:report.status,checks:report.checks.length,jobs:report.jobs,failure:report.failure,report:path.relative(process.cwd(),path.join(output,'report.json'))}));
}
