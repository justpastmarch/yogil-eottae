import {chromium} from '../services/roadview-renderer/node_modules/playwright/index.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

// Run against the corresponding real provider checkout/server; this does not switch production providers.
const provider=process.env.MAP_PROVIDER??'naver';
assert.ok(['kakao','naver'].includes(provider),'MAP_PROVIDER must be kakao or naver');
const base=new URL(process.env.MAP_BASE_URL??'http://localhost:3000/');
assert.ok(['localhost','127.0.0.1','[::1]'].includes(base.hostname),'MAP_BASE_URL must be a real localhost server');
assert.equal(base.username+base.password+base.search+base.hash,'','Do not put credentials in MAP_BASE_URL');
const output=fileURLToPath(new URL(`../.sites-runtime/naver-migration/${provider}-parity/`,import.meta.url));
await mkdir(output,{recursive:true});
const report={provider,base:base.origin,startedAt:new Date().toISOString(),status:'failed',scope:'Real SDK, real provider tiles and real local routing. Analysis advance held and real jobs canceled; no AI/accessibility findings asserted.',checks:[],errors:[],syntheticUIOnly:null};
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
 assert.ok(route?.samples.length>=3,'Real route must have three sample locations for synthetic color UI coverage');
 const samples=[route.samples[0],route.samples[Math.floor((route.samples.length-1)/2)],route.samples.at(-1)];
 assert.equal(new Set(samples.map(sample=>sample.id)).size,3,'Synthetic UI markers need distinct real samples');
 const issues=samples.map((sample,index)=>({id:`${route.id}:${sample.id}`,sampleId:sample.id,coord:sample.coord,along:sample.along,status:['clear','caution','blocked'][index],source:'imagery',reason:'SYNTHETIC UI-ONLY: marker color exercise; no imagery observation or access evidence.',action:'SYNTHETIC UI-ONLY: do not use for travel or accessibility guidance.'}));
 const assessment=clone.journey.assessments[route.id];
 assessment.decision={...assessment.decision,kind:'hold',reason:'SYNTHETIC UI-ONLY: no real access finding.',action:'Do not navigate using these synthetic UI states.',issues:[...assessment.decision.issues.filter(issue=>!issues.some(item=>item.id===issue.id)),...issues]};
 clone.journey.recommendedId=null;
 return clone;
}
async function startJourney(){
 if(!await page.locator('.search-button').isVisible())await page.locator('.results-controls button').click();
 await page.locator('.search-button').click();
 await page.locator('.route-card').first().waitFor({timeout:90000});
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
 await page.locator('#from').fill('수원시 영통구 영통동 992-1');
 await page.locator('#to').fill('경희대학교 국제캠퍼스 학생회관');
 await startJourney();
 const real=structuredClone(latest),routes=real.journey.routes;
 check('actual resolved endpoints',{start:journeyInputs.start.coord,end:journeyInputs.end.coord});
 assert.equal(await page.locator('.route-card').count(),routes.length,'Every actual candidate must remain available');
 check('real routing inputs and cancellation',{routes:routes.map(route=>({id:route.id,name:route.name,coords:route.coords.length,samples:route.samples.length,grade:route.grade?.status??'unavailable',graphSegment:!!route.graphSegment})),phase:real.phase,analysis:'advance never forwarded; actual cancellation, no model calls'});
 let crossingCount=0,gradeSegments=0;
 for(const route of routes){
  await selectRoute(route);
  const rendered=await snapshot();
  for(const candidate of routes)assert.ok(rendered.lines.some(line=>sameCoords(line.coords,candidate.coords)&&line.color==='#8b95a3'&&line.weight===(candidate.id===route.id?7:5)),`Actual route geometry/selected width missing: ${candidate.id}`);
  for(const [label,place] of [['출발지',journeyInputs.start],['도착지',journeyInputs.end]]){
   assert.ok(rendered.overlays.some(overlay=>overlay.label===label&&sameCoords([overlay.coord],[place.coord])),`${label} marker must use the actual resolved place coordinate`);
   assert.equal(await page.locator('.map [aria-label='+JSON.stringify(label)+']').count(),1);
  }
  const crossings=route.samples.filter(sample=>sample.target==='crossing-entry').sort((a,b)=>a.along-b.along);
  assert.equal(await page.locator('.crossing-map-label').count(),crossings.length,'Every actual crossing entry gets its numbered label');
  for(let index=0;index<crossings.length;index++){
   const badge=page.getByRole('button',{name:`횡단 진입점 ${index+1}, 출발 후 ${Math.round(crossings[index].along)}m, 지도 위치`,exact:true});
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
 await page.locator('.route-map-details > summary').click();
 const threshold=page.getByRole('combobox',{name:'경사 강조 기준',exact:true});
 for(const value of [5,8,12]){
  await threshold.selectOption(String(value));
  await page.waitForFunction(({segments,value})=>{
   const lines=window.__mapParity.snapshot().lines.filter(line=>line.weight===9);
   return lines.length===segments.length&&segments.every(segment=>lines.some(line=>JSON.stringify(line.coords)===JSON.stringify(segment.coords)&&line.color===(Math.abs(segment.gradePercent)>=value?'#9f1239':'#0f766e')&&line.style===(segment.gradePercent<0?'shortdash':'solid')));
  },{segments:chosen.grade.segments,value},{timeout:10000});
  check('real estimated grade threshold',{threshold:value,segments:chosen.grade.segments.length,meaning:'30m terrain estimate, not access/passability evidence'});
 }
 await threshold.selectOption('8');
 const markerId=await page.locator('.map [data-evidence-id]').evaluateAll(elements=>elements.find(element=>{
  const box=element.getBoundingClientRect(),target=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);
  return box.width>0&&target?.closest('[data-evidence-id]')===element;
 })?.dataset.evidenceId);
 assert.ok(markerId,'A real decision marker must be visible and pointer-accessible');
 const marker=page.locator('.map [data-evidence-id='+JSON.stringify(markerId)+']');await marker.focus();
 assert.equal(await page.evaluate(()=>document.activeElement?.dataset.evidenceId),markerId);
 await threshold.selectOption('12');
 await page.waitForFunction(id=>document.activeElement?.dataset.evidenceId===id,markerId,{timeout:5000});
 check('marker focus survives actual grade overlay redraw',{evidenceId:markerId});
 await screenshot('desktop-real-routes');
 // Exercise all native button activation paths and verify the instrumented app background listener stays silent.
 for(const activation of ['mouse','Enter','Space','touch']){
  const target=page.locator('.map [data-evidence-id='+JSON.stringify(markerId)+']'),before=(await snapshot()).clicks;
  if(activation==='mouse')await target.click();else if(activation==='touch')await target.tap();else{await target.focus();await target.press(activation);}
  await page.locator('.route-details').waitFor();
  await page.locator('.detail-point.focused,.action-issue.focused').first().waitFor();
  assert.equal(await page.locator('.map [data-evidence-id='+JSON.stringify(markerId)+']').getAttribute('aria-pressed'),'true');
  assert.equal((await snapshot()).clicks,before,`${activation} evidence activation must not invoke app background map callback`);
  check('isolated evidence activation',{activation,evidenceId:markerId});
  await page.getByRole('button',{name:'경로 목록으로',exact:true}).click();
  assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('route-detail-button')),true,'Back restores focus to route detail opener');
 }
 const crossing=chosen.samples.filter(sample=>sample.target==='crossing-entry').sort((a,b)=>a.along-b.along)[0];
 await page.locator('.route-map-details').getByRole('button',{name:`횡단 1 · 출발 후 ${Math.round(crossing.along)}m 위치 보기`,exact:true}).click();
 await waitCenter(crossing.coord);
 for(const activation of ['mouse','Enter','Space','touch']){
  const before=(await snapshot()).clicks,badge=page.locator('.crossing-map-label').first();
  if(activation==='mouse')await badge.click();else if(activation==='touch')await badge.tap();else{await badge.focus();await badge.press(activation);}
  await waitCenter(crossing.coord);
  assert.equal((await snapshot()).clicks,before,`${activation} crossing activation must not invoke app background callback`);
  check('isolated real crossing focus',{activation,coord:crossing.coord});
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
 // Controlled issues exercise colors only. Original real route geometry/grades/evidence are not replaced.
 await page.setViewportSize({width:1440,height:960});synthetic=true;releaseAdvance=Promise.withResolvers();
 await startJourney();
 const syntheticRoute=latest.journey.routes.find(route=>route.id===syntheticRouteId);assert.ok(syntheticRoute);
 const alternate=latest.journey.routes.find(route=>route.id!==syntheticRoute.id);
 if(alternate)await selectRoute(alternate);
 await selectRoute(syntheticRoute);
 await page.evaluate(()=>{const banner=document.createElement('div');banner.dataset.syntheticUiOnly='true';banner.textContent='SYNTHETIC UI-ONLY marker colors — no real imagery finding, access or travel recommendation';banner.style.cssText='position:fixed;bottom:0;left:0;right:0;z-index:99999;background:#fff3cd;color:#402800;font:14px sans-serif;padding:10px;text-align:center';document.body.append(banner);});
 const colored=latest.journey.assessments[syntheticRoute.id].decision.issues.filter(issue=>issue.reason.startsWith('SYNTHETIC UI-ONLY:'));
 for(const issue of colored){
  const dot=page.locator('.map [data-evidence-id='+JSON.stringify(issue.id)+']');
  assert.match(await dot.getAttribute('aria-label'),/SYNTHETIC UI-ONLY/);
  const background=await dot.evaluate(element=>getComputedStyle(element).backgroundColor),expected={clear:'rgb(37, 132, 100)',caution:'rgb(221, 107, 32)',blocked:'rgb(229, 62, 62)'}[issue.status];
  assert.equal(background,expected,'Synthetic issue color parity');
 }
 report.syntheticUIOnly={label:'SYNTHETIC UI-ONLY, not real access evidence',states:colored.map(issue=>({id:issue.id,status:issue.status,coord:issue.coord})),findingsInjected:false,gradesInjected:false,recommendationInjected:false};
 await screenshot('synthetic-ui-only-marker-colors');
 // Finish with a genuine coordinate pick through the actual app map click, never an internal React setter.
 await page.locator('.results-controls button').click();
 await page.getByRole('button',{name:'출발지 지도에서 선택',exact:true}).click();
 const picked=await backgroundClick();await page.waitForFunction(()=>document.querySelector('#from')?.value.startsWith('선택한 출발지'));
 assert.match(await page.locator('#from').inputValue(),new RegExp(picked[1].toFixed(5).replace('.','\\.')+', '+picked[0].toFixed(5).replace('.','\\.')));
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
