import {chromium} from '../services/roadview-renderer/node_modules/playwright/index.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const base=new URL(process.env.MAP_BASE_URL??'http://localhost:3000/');
assert.ok(['localhost','127.0.0.1','[::1]'].includes(base.hostname),'Use a local development server');
assert.equal(base.username+base.password+base.search+base.hash,'','Do not include credentials in MAP_BASE_URL');
const output=fileURLToPath(new URL('../.sites-runtime/naver-migration/loader-failure-proof/',import.meta.url));
await mkdir(output,{recursive:true});
const report={scope:'Controlled configuration/SDK failures against the actual app. No successful map, provider tile or accessibility judgment is simulated.',checks:[],status:'failed'};
const browser=await chromium.launch({channel:'chrome',headless:true});
const sdkPattern='https://oapi.map.naver.com/openapi/v3/maps.js?**';

async function exercise(kind){
 const context=await browser.newContext(),page=await context.newPage();
 let sdkRequests=0,moduleURL;
 const browserErrors=[];
 page.on('pageerror',error=>browserErrors.push(error.message));
 page.on('request',request=>{if(new URL(request.url()).pathname.endsWith('/lib/naver-map-sdk.ts'))moduleURL=request.url();});
 await context.addInitScript(()=>{
  window.__loaderDocument=crypto.randomUUID();
  const original=setTimeout;
  window.setTimeout=(fn,ms,...args)=>original(fn,ms===15000?500:ms,...args);
 });
 await page.route('**/api/map-config',route=>kind==='configuration'
  ?route.fulfill({status:503,json:{error:'Controlled missing map configuration'}})
  :route.fulfill({json:{clientId:'controlled-failure-only'}}));
 await page.route(sdkPattern,route=>{
  sdkRequests++;
  const callback=new URL(route.request().url()).searchParams.get('callback');
  assert.ok(callback,'The actual loader must provide its readiness callback');
  return route.fulfill({contentType:'text/javascript',body:kind==='timeout'
   ?'window.__retiredAuth=()=>window.navermap_authFailure?.();'
   :`window.naver={maps:{Map:function(){window.__unexpectedMapConstruction=true;throw Error('Unexpected construction after auth failure')},LatLng:function(){},Polyline:function(){},Marker:function(){},Panorama:function(){},Event:{addListener:function(){},removeListener:function(){}},Position:{BOTTOM_RIGHT:1}}};window[${JSON.stringify(callback)}]();window.navermap_authFailure();window.__authSent=true;`});
 });
 try{
  await page.goto(base.href,{waitUntil:'domcontentloaded'});
  await page.locator('.tile-error button').waitFor();
  const documentToken=await page.evaluate(()=>window.__loaderDocument);
  if(kind==='configuration'){
   const retryResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/map-config');
   await page.locator('.tile-error button').click();assert.equal((await retryResponse).status(),503);
   await page.locator('.tile-error button').waitFor();
   assert.equal(await page.evaluate(()=>window.__loaderDocument),documentToken,'A pre-SDK configuration retry must not discard the current document');
   assert.equal(sdkRequests,0,'Missing configuration must not start the provider SDK');
  }else if(kind==='timeout'){
   const navigation=page.waitForNavigation({waitUntil:'domcontentloaded'});
   await page.locator('.tile-error button').click();await navigation;
   assert.notEqual(await page.evaluate(()=>window.__loaderDocument),documentToken,'Retry must leave the document containing the obsolete SDK');
  }else{
   await page.waitForFunction(()=>window.__authSent);
   assert.equal(await page.evaluate(()=>Boolean(window.__unexpectedMapConstruction)),false,'An auth failure before the ready continuation must prevent map construction');
   assert.ok(moduleURL,'This smoke needs the actual development loader module');
   const cached=await page.evaluate(async url=>{
    const sdk=await import(url);
    try{await sdk.loadNaverMaps();return {rejected:false,reload:sdk.naverMapReloadRequired()};}
    catch{return {rejected:true,reload:sdk.naverMapReloadRequired()};}
   },moduleURL);
   assert.deepEqual(cached,{rejected:true,reload:true},'Authentication failure must invalidate a previously fulfilled readiness promise');
  }
  assert.deepEqual(browserErrors,[],'Controlled failures must not escape as uncaught browser errors');
  await page.screenshot({path:output+'/'+kind+'.png'});
  report.checks.push({kind,status:'passed'});
 }finally{await context.close();}
}

try{
 await exercise('configuration');await exercise('timeout');await exercise('ready-then-auth');
 report.status='passed';
}catch(error){report.failure=String(error.message).replace(/https?:\/\/[^\s<>"']+/g,'[url-redacted]');process.exitCode=1;}
finally{
 await browser.close();await writeFile(output+'/report.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
}
