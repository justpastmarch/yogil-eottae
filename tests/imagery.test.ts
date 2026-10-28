import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {streetImage,ImageryServiceError} from '../lib/street-imagery.ts';
import type {ServerConfig} from '../lib/server-config.ts';
import type {Sample} from '../lib/domain.ts';
const sample:Sample={id:'s0',coord:[127,37],heading:0,along:0,critical:true};
const config:ServerConfig={routing:{kind:'kakao',restKey:'test'},ai:'test',model:'gemini-test',mapillary:'test',rendererUrl:'https://renderer.example/capture',rendererToken:'test'};
const image={mime:'image/jpeg',data:'/9j/AAAA'};
for(const failure of ['transport','unavailable','misaligned','missing'])test(`Mapillary remains available when renderer imagery is ${failure}`,async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async(input)=>{
  const url=String(input);
  if(url===config.rendererUrl){
   if(failure==='transport')throw new TypeError('fetch failed');
   if(failure==='unavailable')return new Response('',{status:502});
   return Response.json(failure==='missing'?null:{image,source:{url:'https://map.kakao.com/',capturedAt:Date.now()-1000,coord:failure==='misaligned'?[127.1,37]:sample.coord,heading:0}});
  }
  if(url.startsWith('https://graph.mapillary.com/images?'))return Response.json({data:[{id:'actual-external-contract-fixture',geometry:{coordinates:sample.coord},captured_at:Date.now()-1000,thumb_1024_url:'https://images.mapillary.com/test.jpg',compass_angle:0,is_pano:false}]});
  return new Response(Uint8Array.from([255,216,255,0,0,0]),{headers:{'content-type':'image/jpeg'}});
 };
 try{const result=await streetImage(sample,config,new AbortController().signal);assert.match(result?.source.url??'',/mapillary.com/);}finally{globalThis.fetch=original;}
});
for(const status of [401,403,404])test(`renderer ${status} is not retried or hidden by a fallback`,async()=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response('',{status});};
 try{await assert.rejects(streetImage(sample,config,new AbortController().signal),error=>error instanceof ImageryServiceError&&error.status===status);assert.equal(calls,1);}finally{globalThis.fetch=original;}
});

for(const failure of ['transport','server-error'])test(`renderer ${failure} without fallback reports an outage rather than absent coverage`,async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async()=>{if(failure==='transport')throw new TypeError('fetch failed');return new Response('',{status:502});};
 try{await assert.rejects(streetImage(sample,{...config,mapillary:''},new AbortController().signal),error=>error instanceof ImageryServiceError&&error.status===503);}finally{globalThis.fetch=original;}
});
test('a successful renderer null means absent local coverage, not a service outage',async()=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>Response.json(null);
 try{assert.equal(await streetImage(sample,{...config,mapillary:''},new AbortController().signal),null);}finally{globalThis.fetch=original;}
});
test('older renderer imagery remains available for dated historical observation',async t=>{
 const capturedAt=Date.now()-400*86400000;
 t.mock.method(globalThis,'fetch',async()=>Response.json({image,source:{url:'https://map.kakao.com/?panoid=older',panoId:'older',capturedAt,coord:sample.coord,heading:0}}));
 const result=await streetImage(sample,{...config,mapillary:''},new AbortController().signal);
 assert.equal(result?.source.capturedAt,capturedAt);
 assert.equal(result?.source.panoId,'older');
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
  return Response.json({image,source:{url:'https://map.kakao.com/?panoid=123',panoId:'123',capturedAt:Date.now()-1000,coord:sample.coord,heading:0}});
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
  return Response.json({image,source:{url:'https://map.kakao.com/?panoid=456',panoId:'456',capturedAt:Date.now()-1000,coord:sample.coord,heading:0}});
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
  return Response.json({image,source:{url:'https://map.kakao.com/?panoid=789',panoId:'789',capturedAt:Date.now()-1000,coord:sample.coord,heading:0}});
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
