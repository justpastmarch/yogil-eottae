import assert from 'node:assert/strict';

// Browser-only instrumentation delegates to the actual NAVER constructors and events.
export function instrumentNaverSDK(){
 const state={maps:[],lines:[],markers:[],panoramas:[],backgroundClicks:0,installed:false};
 Object.defineProperty(window,'__uxSDK',{value:state});
 const coord=point=>[point?.lng?.(),point?.lat?.()];
 const seen=new WeakSet();
 function install(){
  const sdk=window.naver?.maps;if(!sdk?.Map||!sdk.Polyline||!sdk.Marker||!sdk.Panorama||!sdk.Event||seen.has(sdk))return;
  seen.add(sdk);state.installed=true;
  for(const [name,bucket] of [['Map','maps'],['Polyline','lines'],['Marker','markers'],['Panorama','panoramas']]){
   const Original=sdk[name];if(!Original)continue;
   sdk[name]=new Proxy(Original,{construct(target,args,newTarget){
    const instance=Reflect.construct(target,args,newTarget),options=args[name==='Map'||name==='Panorama'?1:0]??{},record={instance,options,map:name==='Map'?instance:options.map,ready:false};
    state[bucket].push(record);
    if(name==='Panorama')sdk.Event.addListener(instance,'init',()=>{record.ready=true;});
    if(name!=='Map'&&instance.setMap){const original=instance.setMap;instance.setMap=function(map){record.map=map;return Reflect.apply(original,this,[map]);};}
    return instance;
   }});
  }
  const original=sdk.Event.addListener;
  sdk.Event.addListener=function(target,name,callback,...rest){
   const wrapped=name==='click'&&state.maps.some(record=>record.instance===target)?function(...args){state.backgroundClicks++;return Reflect.apply(callback,this,args);}:callback;
   return Reflect.apply(original,this,[target,name,wrapped,...rest]);
  };
 }
 const callbacks=new Set();
 function scripts(script){
  if(!(script instanceof HTMLScriptElement))return;
  let url;try{url=new URL(script.src);}catch{return;}
  if(!/(^|\.)map\.naver\.com$/.test(url.hostname))return;
  const name=url.searchParams.get('callback');if(!name||name.includes('.')||callbacks.has(name))return;
  callbacks.add(name);const callback=window[name];if(typeof callback==='function')window[name]=function(...args){install();return Reflect.apply(callback,this,args);};
 }
 new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes){scripts(node);node.querySelectorAll?.('script[src]').forEach(scripts);}install();}).observe(document,{childList:true,subtree:true});
 window.addEventListener('load',install,true);
 state.snapshot=()=>({installed:state.installed,maps:state.maps.length,backgroundClicks:state.backgroundClicks,center:coord(state.maps.at(-1)?.instance.getCenter()),lines:state.lines.filter(record=>record.map).map(record=>({coords:(Array.isArray(record.options.path)?record.options.path:record.options.path?.getArray?.()??[]).map(coord),color:record.options.strokeColor,weight:record.options.strokeWeight,zIndex:record.options.zIndex,style:record.options.strokeStyle})),panorama:(()=>{const record=state.panoramas.at(-1);return record?{ready:record.ready,panoId:record.instance.getPanoId(),pov:record.instance.getPov()}:null;})()});
}

export async function realNaverTiles(page,selector='.map',timeout=45000){
 await ensureNativeInputBounds(page);
 const handle=await page.waitForFunction(selector=>{
  const root=document.querySelector(selector);if(!root)return false;const area=root.getBoundingClientRect();
  const tiles=[...root.querySelectorAll('img')].flatMap(image=>{
   let url;try{url=new URL(image.currentSrc||image.src);}catch{return [];}
   const box=image.getBoundingClientRect();
   if(!/(^|\.)(?:pstatic\.net|naver\.com|naver\.net|navermaps\.com)$/.test(url.hostname)||/(?:logo|copyright)/i.test(url.pathname)||!image.complete||image.naturalWidth<128||image.naturalHeight<128||box.width<100||box.height<100||box.right<=area.left||box.left>=area.right||box.bottom<=area.top||box.top>=area.bottom)return [];
   if(selector==='.map'&&!/(?:tile|basemap|maptile|\/(?:nrb[^/]*\/)?styles\/|\/get\/)/i.test(url.pathname))return [];
   return [{host:url.hostname,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight,width:box.width,height:box.height}];
  });return tiles.length>=2?tiles:false;
 },selector,{timeout}).catch(()=>{throw Error('Real NAVER tiles unavailable: actual SDK credentials, domain authorization and network are required; constructors alone do not pass.');});
 const result=await handle.jsonValue();await handle.dispose();return result;
}
export async function choosePlace(page,field,query){
 await page.getByRole('combobox',{name:field,exact:true}).fill(query);
 await page.getByRole('button',{name:field+' 검색',exact:true}).click();
 await page.getByRole('option').filter({hasText:query}).first().click();
}
export async function chooseRoute(page,route){
 const select=page.getByRole('button',{name:route.name+' 선택',exact:true});await select.click();assert.equal(await select.getAttribute('aria-pressed'),'true');
}
export async function exposedControl(locator,{minSize=44}={}){
 assert.equal(await locator.count(),1,'Control must resolve uniquely');
 const box=await locator.evaluate(element=>{
  const rect=element.getBoundingClientRect(),hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
  return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,exposed:hit===element||element.contains(hit),inViewport:rect.left>=-1&&rect.top>=-1&&rect.right<=innerWidth+1&&rect.bottom<=innerHeight+1};
 });
 assert.ok(box.width>=minSize&&box.height>=minSize,`Control must have a ${minSize}px hit rectangle: ${JSON.stringify(box)}`);
 assert.ok(box.inViewport&&box.exposed,`Control must be inside viewport and uncovered before scrolling: ${JSON.stringify(box)}`);return box;
}
export function sameCoords(actual,expected){return actual.length===expected.length&&actual.every((coord,index)=>coord.every((value,axis)=>Math.abs(value-expected[index][axis])<1e-8));}
export const chromeArgs=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--enable-webgl','--ignore-gpu-blocklist'];

export async function crossingPointControl(page,id){
 const selector='.map-area .crossing-map-label[data-evidence-id='+JSON.stringify(id)+']',control=page.locator(selector);
 await control.waitFor({state:'attached'});
 const menuId=await control.evaluate(element=>element.closest('.crossing-cluster-choices')?.id??null);
 if(menuId){
  if(!await control.isVisible())await page.locator('.crossing-map-cluster > summary[aria-controls='+JSON.stringify(menuId)+']').click();
  await control.waitFor({state:'visible'});
  await control.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>resolve())));
  const region=await control.evaluate(element=>{
   const menu=element.closest('.crossing-cluster-choices'),box=menu.getBoundingClientRect(),target=element.getBoundingClientRect();
   return {x:box.x+box.width/2,y:box.y+box.height/2,width:box.width,height:box.height,delta:target.bottom>box.bottom-1?target.bottom-box.bottom+8:target.top<box.top+1?target.top-box.top-8:0};
  });
  if(region.delta){
   assert.ok(region.width>0&&region.height>0,'Native wheel must target a rendered popup, not a deferred disclosure');
   await ensureNativeInputBounds(page);
   await page.mouse.move(region.x,region.y);
   await page.mouse.wheel(0,region.delta);
   await page.waitForFunction(selector=>{
    const element=document.querySelector(selector),menu=element?.closest('.crossing-cluster-choices');
    if(!element||!menu)return false;
    const target=element.getBoundingClientRect(),box=menu.getBoundingClientRect();
    return target.top>=box.top+1&&target.bottom<=box.bottom-1;
   },selector,{timeout:5000});
  }
 }
 return control;
}

export async function ensureNativeInputBounds(page){
 const viewport=page.viewportSize();assert.ok(viewport,'Native-input verification requires an explicit CSS viewport');
 const session=await page.context().newCDPSession(page);
 try{
  const current=await session.send('Browser.getWindowForTarget');
  const width=Math.max(current.bounds.width,viewport.width+200,800),height=Math.max(current.bounds.height,viewport.height+300,900);
  if(current.bounds.windowState!=='normal')await session.send('Browser.setWindowBounds',{windowId:current.windowId,bounds:{windowState:'normal'}});
  if(current.bounds.width<width||current.bounds.height<height)await session.send('Browser.setWindowBounds',{windowId:current.windowId,bounds:{width,height}});
  const after=await session.send('Browser.getWindowBounds',{windowId:current.windowId});
  const css=await page.evaluate(()=>({width:innerWidth,height:innerHeight,devicePixelRatio,outerWidth,outerHeight}));
  assert.equal(css.width,viewport.width,'Native window correction must not change the requested CSS viewport');
  assert.equal(css.height,viewport.height,'Native window correction must not change the requested CSS viewport');
  const result={cssViewport:css,nativeBounds:after.bounds};
  await page.evaluate(result=>{window.__uxNativeInputBounds=result;},result);
  return result;
 }finally{await session.detach();}
}
