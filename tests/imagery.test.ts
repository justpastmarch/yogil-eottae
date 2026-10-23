import {test} from 'node:test';
import assert from 'node:assert/strict';
import {streetImage,ImageryServiceError} from '../lib/street-imagery.ts';
import type {ServerConfig} from '../lib/server-config.ts';
import type {Sample} from '../lib/domain.ts';
const sample:Sample={id:'s0',coord:[127,37],heading:0,along:0,critical:true};
const config:ServerConfig={routing:{kind:'kakao',restKey:'test'},ai:'test',model:'gemini-test',mapillary:'test',rendererUrl:'https://renderer.example/capture',rendererToken:'test'};
const image={mime:'image/jpeg',data:'/9j/AAAA'};
for(const failure of ['unavailable','stale','misaligned','missing'])test(`Mapillary remains available when renderer imagery is ${failure}`,async()=>{
 const original=globalThis.fetch;
 const calls:string[]=[];
 globalThis.fetch=async(input)=>{
  const url=String(input);calls.push(url);
  if(url===config.rendererUrl){
   if(failure==='unavailable')return new Response('',{status:502});
   return Response.json(failure==='missing'?null:{image,source:{url:'https://map.kakao.com/',capturedAt:failure==='stale'?0:Date.now()-1000,coord:failure==='misaligned'?[127.1,37]:sample.coord,heading:0}});
  }
  if(url.startsWith('https://graph.mapillary.com/images?'))return Response.json({data:[{id:'actual-external-contract-fixture',geometry:{coordinates:sample.coord},captured_at:Date.now()-1000,thumb_1024_url:'https://images.mapillary.com/test.jpg',compass_angle:0,is_pano:false}]});
  return new Response(Uint8Array.from([255,216,255,0,0,0]),{headers:{'content-type':'image/jpeg'}});
 };
 try{const result=await streetImage(sample,config,new AbortController().signal);assert.match(result?.source.url??'',/mapillary.com/);assert.equal(calls.length,3);}finally{globalThis.fetch=original;}
});
test('renderer authentication failures are not hidden by a fallback',async()=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response('',{status:401});};
 try{await assert.rejects(streetImage(sample,config,new AbortController().signal),error=>error instanceof ImageryServiceError&&error.status===401);assert.equal(calls,1);}finally{globalThis.fetch=original;}
});
