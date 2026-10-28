import http from 'node:http';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {streetImage} from '../lib/street-imagery.ts';

const token=process.env.ROADVIEW_RENDERER_TOKEN;
if(!token)throw new Error('ROADVIEW_RENDERER_TOKEN is required');
const upstream=process.env.RETRY_RENDERER_URL??'http://127.0.0.1:3101/capture';
let attempts=0;
const proxy=http.createServer(async(req,res)=>{
 attempts++;
 if(attempts===1){res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({error:'injected transient failure'}));return;}
 const chunks=[];
 for await(const chunk of req)chunks.push(chunk);
 try{
  const response=await fetch(upstream,{method:'POST',headers:{authorization:req.headers.authorization??'','content-type':'application/json'},body:Buffer.concat(chunks)});
  res.writeHead(response.status,{'content-type':response.headers.get('content-type')??'application/json'});
  res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(503);res.end();}
});
proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
try{
 const address=proxy.address();
 assert.ok(address&&typeof address==='object');
 const config={routing:{kind:'kakao',restKey:'unused'},ai:'unused',model:'gemini-test',mapillary:'',rendererUrl:`http://127.0.0.1:${address.port}/capture`,rendererToken:token};
 const sample={id:'crossing',coord:[127.07560235,37.24781289],heading:193.7914910652162,along:198,critical:true};
 const image=await streetImage(sample,config,AbortSignal.timeout(90000),{target:sample.coord});
 assert.equal(attempts,2,'The initial injected 502 should be followed by one successful request');
 assert.ok(image,'The real renderer must return an image');
 const bytes=Buffer.from(image.image.data,'base64').length;
 assert.ok(bytes>10000,'The renderer response must contain actual image bytes');
 console.log(JSON.stringify({injectedFirstStatus:502,attempts,realRenderer:true,panoId:image.source.panoId,capturedMonth:image.source.capturedMonth,bytes}));
}finally{
 proxy.closeAllConnections();proxy.close();
}
