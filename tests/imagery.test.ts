import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {streetImage,ImageryServiceError,type StreetImage} from '../lib/street-imagery.ts';
import type {ServerConfig} from '../lib/server-config.ts';
import type {Sample} from '../lib/domain.ts';
const sample:Sample={id:'s0',coord:[127,37],heading:0,along:0,critical:true};
const config:ServerConfig={routing:{kind:'kakao',restKey:'test'},ai:'test',model:'gemini-test',mapillary:'test',rendererUrl:'https://renderer.example/capture',rendererToken:'test'};
const image={mime:'image/jpeg',data:'/9j/AAAA'};
const naverSource=(panoId:string,changes:Partial<StreetImage['source']>={}):StreetImage['source']=>({
 provider:'naver',url:`https://viewer.map.naver.com/panorama?id=${panoId}&heading=0&tilt=0&fov=90`,panoId,capturedAt:null,coord:sample.coord,heading:0,tilt:0,fov:90,zoom:0,...changes,
});
for(const failure of ['transport','unavailable','misaligned','legacy-provider'])test(`configured NAVER renderer ${failure} is never hidden by Mapillary`,async t=>{
 let alternateCalls=0;
 t.mock.method(globalThis,'fetch',async(input:string|URL|Request)=>{
  if(String(input)!==config.rendererUrl){alternateCalls++;throw new Error('Unexpected alternate provider');}
  if(failure==='transport')throw new TypeError('fetch failed');
  if(failure==='unavailable')return new Response('',{status:502});
  return Response.json({image,source:failure==='legacy-provider'?{url:'https://map.kakao.com/?panoid=1',panoId:'1',capturedAt:null,coord:sample.coord,heading:0}:naverSource('misaligned',{coord:[127.1,37]})});
 });
 await assert.rejects(streetImage(sample,config,new AbortController().signal),error=>error instanceof ImageryServiceError&&error.status===(failure==='unavailable'?502:503));
 assert.equal(alternateCalls,0);
});
for(const status of [401,403,404])test(`renderer ${status} is not retried or hidden by a fallback`,async()=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response('',{status});};
 try{await assert.rejects(streetImage(sample,config,new AbortController().signal),error=>error instanceof ImageryServiceError&&error.status===status);assert.equal(calls,1);}finally{globalThis.fetch=original;}
});

for(const failure of ['transport','server-error'])test(`renderer ${failure} without fallback reports an outage rather than absent coverage`,async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async()=>{if(failure==='transport')throw new TypeError('fetch failed');return new Response('',{status:502});};
 try{await assert.rejects(streetImage(sample,{...config,mapillary:''},new AbortController().signal),error=>error instanceof ImageryServiceError&&error.status===(failure==='server-error'?502:503));}finally{globalThis.fetch=original;}
});
test('a successful renderer null means absent local coverage, not a service outage',async()=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json(null);};
 try{assert.equal(await streetImage(sample,config,new AbortController().signal),null);assert.equal(calls,1);}finally{globalThis.fetch=original;}
});
test('actual NAVER camera metadata survives the renderer boundary for archived observation',async t=>{
 const source=naverSource('opaque-old-camera',{capturedMonth:'2024-06'});
 t.mock.method(globalThis,'fetch',async()=>Response.json({image,source}));
 const result=await streetImage(sample,{...config,mapillary:''},new AbortController().signal);
 assert.deepEqual(result?.source,source);
});
for(const changes of [
 {provider:undefined},{fov:undefined},{tilt:undefined},
 {url:'https://viewer.map.naver.com/panorama?id=wrong&heading=0&tilt=0&fov=90'},
 {url:'https://viewer.map.naver.com/panorama?id=actual&heading=0&tilt=0&fov=60'},
])test('configured capture rejects incomplete or contradictory NAVER camera provenance',async t=>{
 let requests=0;
 t.mock.method(globalThis,'fetch',async()=>{requests++;return Response.json({image,source:naverSource('actual',changes)});});
 await assert.rejects(streetImage(sample,config,new AbortController().signal),ImageryServiceError);
 assert.equal(requests,1);
});
test('older Mapillary imagery is retained when it is the available source',async t=>{
 const capturedAt=Date.now()-400*86400000;
 t.mock.method(globalThis,'fetch',async(input:string|URL|Request)=>{
  const url=String(input);
  if(url.startsWith('https://graph.mapillary.com/images?'))return Response.json({data:[{id:'older-mapillary',geometry:{coordinates:sample.coord},captured_at:capturedAt,thumb_1024_url:'https://images.mapillary.com/test.jpg',compass_angle:0,is_pano:false}]});
  return new Response(Uint8Array.from([255,216,255,0,0,0]),{headers:{'content-type':'image/jpeg'}});
 });
 const result=await streetImage(sample,{...config,rendererUrl:undefined},new AbortController().signal);
 assert.match(result?.source.url??'',/pKey=older-mapillary/);
 assert.equal(result?.source.capturedAt,capturedAt);
});
test('a temporary renderer failure is retried and returns the real renderer image',async t=>{
 let attempts=0;
 t.mock.method(globalThis,'fetch',async()=>{
  attempts++;
  if(attempts===1)return new Response('',{status:502});
  return Response.json({image,source:naverSource('123')});
 });
 const result=await streetImage(sample,{...config,mapillary:''},new AbortController().signal);
 assert.equal(result?.source.panoId,'123');
 assert.deepEqual(result?.image,image);
 assert.equal(attempts,2);
});
test('a disconnected response body is retried instead of being reported as a route obstacle',async t=>{
 let attempts=0;
 t.mock.method(globalThis,'fetch',async()=>{
  attempts++;
  if(attempts===1)return new Response(new ReadableStream({start(controller){controller.error(new TypeError('connection lost'));}}));
  return Response.json({image,source:naverSource('456')});
 });
 const result=await streetImage(sample,{...config,mapillary:''},new AbortController().signal);
 assert.equal(result?.source.panoId,'456');
 assert.equal(attempts,2);
});
test('canceling during retry delay prevents another renderer request',async t=>{
 const controller=new AbortController(),started=Promise.withResolvers<void>();let attempts=0;
 t.mock.timers.enable({apis:['setTimeout']});
 t.mock.method(globalThis,'fetch',async()=>{attempts++;started.resolve();return new Response('',{status:502});});
 const pending=streetImage(sample,{...config,mapillary:''},controller.signal);
 await started.promise;await setImmediate();controller.abort();
 await assert.rejects(pending,error=>error instanceof DOMException&&error.name==='AbortError');
 assert.equal(attempts,1);
});
for(const status of [429,503])test(`renderer ${status} is retried after capacity returns`,async t=>{
 let attempts=0;const started=Promise.withResolvers<void>();
 t.mock.timers.enable({apis:['setTimeout']});
 t.mock.method(globalThis,'fetch',async()=>{
  attempts++;
  if(attempts===1){started.resolve();return new Response('',{status});}
  return Response.json({image,source:naverSource('789')});
 });
 const pending=streetImage(sample,{...config,mapillary:''},new AbortController().signal);
 await started.promise;await setImmediate();t.mock.timers.tick(5000);
 const result=await pending;
 assert.equal(result?.source.panoId,'789');
 assert.equal(attempts,2);
});
test('a co-located target preserves the route heading for fallback photos',async t=>{
 const eastbound={...sample,heading:90};
 t.mock.method(globalThis,'fetch',async(input:string|URL|Request)=>{
  const url=String(input);
  if(url.startsWith('https://graph.mapillary.com/images?'))return Response.json({data:[{id:'eastbound',geometry:{coordinates:eastbound.coord},captured_at:Date.now()-1000,thumb_1024_url:'https://images.mapillary.com/east.jpg',compass_angle:90,is_pano:false}]});
  return new Response(Uint8Array.from([255,216,255,0,0,0]),{headers:{'content-type':'image/jpeg'}});
 });
 const image=await streetImage(eastbound,{...config,rendererUrl:undefined},new AbortController().signal,{target:eastbound.coord});
 assert.equal(image?.source.heading,90);
 assert.match(image?.source.url??'',/pKey=eastbound/);
});

const kartaConfig:ServerConfig={...config,imageryProvider:'kartaview'};
const kartaPhoto={lat:'37',lng:'127',heading:'0',projection:'PLANE',status:'active',visibility:'public',autoImgProcessingResult:'BLURRED',autoImgProcessingStatus:'FINISHED',sequenceId:'111',sequenceIndex:'9',shotDate:'2018-01-19 05:55:31.000',imageProcUrl:'https://cdn.kartaview.org/photo.jpg'};
test('KartaView returns a dated, credited source without falling back to another provider',async t=>{
 const calls:string[]=[];
 t.mock.method(globalThis,'fetch',async(input:string|URL|Request)=>{
  const url=String(input);calls.push(url);
  if(url.startsWith('https://api.kartaview.org/'))return Response.json({status:{apiCode:600},result:{data:[kartaPhoto]}});
  assert.equal(url,'https://cdn.kartaview.org/photo.jpg');
  return new Response(Uint8Array.from([255,216,255,0,0,0]),{headers:{'content-type':'image/jpeg'}});
 });
 const result=await streetImage(sample,kartaConfig,new AbortController().signal,{target:sample.coord});
 assert.equal(result?.source.url,'https://kartaview.org/details/111/9');
 assert.equal(result?.source.capturedMonth,'2018-01');
 assert.equal(result?.source.capturedAt,null);
 assert.equal(result?.source.heading,0);
 assert.equal(result?.source.tilt,undefined);
 assert.equal(calls.length,2);
});
test('KartaView retains usable photos with an unknown capture date',async t=>{
 t.mock.method(globalThis,'fetch',async(input:string|URL|Request)=>String(input).startsWith('https://api.kartaview.org/')?Response.json({status:{apiCode:600},result:{data:[{...kartaPhoto,shotDate:undefined}]}}):new Response(Uint8Array.from([255,216,255,0,0,0]),{headers:{'content-type':'image/jpeg'}}));
 const result=await streetImage(sample,kartaConfig,new AbortController().signal);
 assert.equal(result?.source.capturedAt,null);
 assert.equal(result?.source.capturedMonth,undefined);
});
test('KartaView excludes unblurred, distant, wrong-direction and spherical photos',async t=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json({status:{apiCode:600},result:{data:[
  {...kartaPhoto,autoImgProcessingResult:'ORIGINAL'},
  {...kartaPhoto,lat:'37.001'},
  {...kartaPhoto,heading:'180'},
  {...kartaPhoto,projection:'SPHERICAL'},
  {...kartaPhoto,visibility:'private'},
  {...kartaPhoto,status:'deleted'},
 ]}}));
 assert.equal(await streetImage(sample,kartaConfig,new AbortController().signal),null);
});
test('KartaView never fetches an image from an untrusted host or pretends to rotate a fixed photo',async t=>{
 let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({status:{apiCode:600},result:{data:[{...kartaPhoto,imageProcUrl:'https://untrusted.example/image.jpg'}]}});});
 await assert.rejects(streetImage(sample,kartaConfig,new AbortController().signal),/Invalid image host/);
 assert.equal(calls,1);
 assert.equal(await streetImage(sample,kartaConfig,new AbortController().signal,{tilt:20}),null);
 assert.equal(calls,1);
});

const googleConfig:ServerConfig={...config,imageryProvider:'google',googleStreetViewKey:'private-google-key'};
const googleMetadata={status:'OK',pano_id:'real-pano-id',location:{lat:37,lng:127.0001},date:'2014-03'};
const jpeg=()=>new Response(Uint8Array.from([255,216,255,0,0,0]),{headers:{'content-type':'image/jpeg'}});
test('Google returns the real panorama and frames the target from its camera',async t=>{
 const requests:URL[]=[];
 t.mock.method(globalThis,'fetch',async(input:string|URL|Request)=>{
  const url=new URL(String(input));requests.push(url);
  assert.equal(url.origin,'https://maps.googleapis.com');
  return url.pathname.endsWith('/metadata')?Response.json(googleMetadata):jpeg();
 });
 const result=await streetImage(sample,googleConfig,new AbortController().signal,{target:[127.001,37],tilt:15,zoom:2});
 assert.ok(result);
 assert.deepEqual(result.source.coord,[127.0001,37]);
 assert.ok(result.source.heading>89&&result.source.heading<91);
 assert.equal(result.source.panoId,'real-pano-id');
 assert.equal(result.source.capturedAt,null);
 assert.equal(result.source.capturedMonth,'2014-03');
 assert.equal(result.source.tilt,15);
 assert.equal(result.source.zoom,2);
 assert.equal(new URL(result.source.url).hostname,'www.google.com');
 assert.equal(new URL(result.source.url).searchParams.get('pano'),'real-pano-id');
 assert.ok(!JSON.stringify(result).includes('private-google-key'));
 assert.equal(requests.length,2);
 assert.equal(requests[1].searchParams.get('pano'),'real-pano-id');
 assert.equal(requests[1].searchParams.get('return_error_code'),'true');
 assert.equal(requests[1].searchParams.get('pitch'),'-15');
 assert.equal(requests[1].searchParams.get('fov'),'45');
 assert.ok(Number(requests[1].searchParams.get('heading'))>89&&Number(requests[1].searchParams.get('heading'))<91);
});
test('Google uses the requested heading without a target and never invents capture dates',async t=>{
 t.mock.method(globalThis,'fetch',async(input:string|URL|Request)=>String(input).includes('/metadata')?Response.json({...googleMetadata,date:'2014-13'}):jpeg());
 const result=await streetImage({...sample,heading:210},googleConfig,new AbortController().signal);
 assert.equal(result?.source.heading,210);
 assert.equal(result?.source.capturedAt,null);
 assert.equal(result?.source.capturedMonth,undefined);
});
test('Google imagery retries a transient metadata failure before returning the image',async t=>{
 let attempts=0;
 t.mock.method(globalThis,'fetch',async(input:string|URL|Request)=>{
  if(String(input).includes('/metadata'))return ++attempts===1?new Response('',{status:502}):Response.json(googleMetadata);
  return jpeg();
 });
 const result=await streetImage(sample,googleConfig,new AbortController().signal);
 assert.equal(result?.source.panoId,'real-pano-id');
 assert.equal(attempts,2);
});
for(const metadata of [{status:'ZERO_RESULTS'},{...googleMetadata,location:{lat:37.001,lng:127}}])test('Google reports absent coverage without falling back',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json(metadata);});
 assert.equal(await streetImage(sample,googleConfig,new AbortController().signal),null);
 assert.equal(calls,1);
});
for(const [status,expected] of [['REQUEST_DENIED',403],['OVER_QUERY_LIMIT',429],['OVER_DAILY_LIMIT',429],['UNKNOWN_ERROR',502]] as const)test(`Google ${status} is a service error`,async t=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json({status}));
 await assert.rejects(streetImage(sample,googleConfig,new AbortController().signal),error=>error instanceof ImageryServiceError&&error.status===expected&&!error.message.includes('private-google-key'));
});
test('Google requires its own key and never falls back',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('unexpected request');});
 await assert.rejects(streetImage(sample,{...googleConfig,googleStreetViewKey:undefined},new AbortController().signal),error=>error instanceof ImageryServiceError&&error.status===401);
 assert.equal(calls,0);
});
for(const metadata of [{...googleMetadata,pano_id:''},{...googleMetadata,location:{lat:95,lng:127}}])test('Google rejects invalid panorama metadata',async t=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json(metadata));
 await assert.rejects(streetImage(sample,googleConfig,new AbortController().signal),ImageryServiceError);
});
for(const response of [
 ()=>new Response('forbidden',{status:403}),
 ()=>new Response('not an image',{headers:{'content-type':'image/jpeg'}}),
 ()=>new Response(Uint8Array.from([255,216,255,0,0,0]),{headers:{'content-type':'text/html'}}),
 ()=>new Response(new Uint8Array(4*1024*1024+1),{headers:{'content-type':'image/jpeg'}}),
])test('Google image failures are errors, not missing coverage',async t=>{
 t.mock.method(globalThis,'fetch',async(input:string|URL|Request)=>String(input).includes('/metadata')?Response.json(googleMetadata):response());
 await assert.rejects(streetImage(sample,googleConfig,new AbortController().signal),ImageryServiceError);
});
test('Google respects cancellation',async t=>{
 const controller=new AbortController();controller.abort();
 t.mock.method(globalThis,'fetch',async(_input:string|URL|Request,init?:RequestInit)=>{init?.signal?.throwIfAborted();return Response.json(googleMetadata);});
 await assert.rejects(streetImage(sample,googleConfig,controller.signal));
});

test('storefront search can use a camera beyond the route observation radius without loosening route matching',async t=>{
 const coord:[number,number]=[127,37.0002];
 const distances:number[]=[];
 t.mock.method(globalThis,'fetch',async(_input:string|URL|Request,init?:RequestInit)=>{
  distances.push(JSON.parse(String(init?.body)).maxDistance);
  return Response.json({image,source:naverSource('789',{url:'https://viewer.map.naver.com/panorama?id=789&heading=180&tilt=0&fov=60',coord,heading:180,fov:60,zoom:1})});
 });
 const options={target:sample.coord,tilt:0,zoom:1};
 await assert.rejects(streetImage(sample,{...config,mapillary:''},new AbortController().signal,options),ImageryServiceError);
 const result=await streetImage(sample,{...config,mapillary:''},new AbortController().signal,{...options,purpose:'place-entrance'});
 assert.equal(result?.source.panoId,'789');
 assert.deepEqual(distances,[20,60]);
});
