import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const endpoint=process.env.ROADVIEW_RENDERER_URL,token=process.env.ROADVIEW_RENDERER_TOKEN;
assert.ok(endpoint&&token,'Run with the configured renderer URL and bearer token');
const output=fileURLToPath(new URL('../.sites-runtime/naver-migration/capture-smoke/',import.meta.url));
await mkdir(output,{recursive:true});
const coord=[127.07560235,37.24781289],heading=194,tilt=7;
const report={scope:'Actual authenticated renderer, genuine Naver panorama pixels and native camera metadata; no AI or physical-access verdict.',status:'failed',captures:[]};
function meters(a,b){const r=Math.PI/180,p=(b[1]-a[1])*r,l=(b[0]-a[0])*r,v=Math.sin(p/2)**2+Math.cos(a[1]*r)*Math.cos(b[1]*r)*Math.sin(l/2)**2;return 6371000*2*Math.atan2(Math.sqrt(v),Math.sqrt(Math.max(0,1-v)));}
try{
 const denied=await fetch(endpoint,{method:'POST',headers:{authorization:'Bearer controlled-invalid-token','content-type':'application/json'},body:JSON.stringify({coord,heading})});
 assert.equal(denied.status,401,'Unauthenticated capture must be rejected');await denied.body?.cancel();
 for(const [zoom,wantedFov] of [90,60,40].entries()){
  const started=Date.now();
  const response=await fetch(endpoint,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({coord,heading,tilt,zoom,maxDistance:20}),signal:AbortSignal.timeout(35000)});
  assert.equal(response.status,200,`Actual Naver capture failed with HTTP ${response.status}`);
  const capture=await response.json();assert.ok(capture,'The selected real Yeongtong scene must be available');
  const source=capture.source;assert.equal(source.provider,'naver');assert.ok(typeof source.panoId==='string'&&source.panoId.length>0);
  assert.ok(meters(coord,source.coord)<=20,'Actual panorama must be within the route camera radius');
  assert.ok(Math.abs(((source.heading-heading+540)%360)-180)<=0.1,'Source heading must match the actual requested view');
  assert.ok(Math.abs(source.tilt-tilt)<=0.1,'Canonical positive-down tilt must survive native capture');
  assert.ok(Math.abs(source.fov-wantedFov)<=0.1,'Native FOV must match the explicit framing preset');
  assert.equal(source.zoom,zoom,'Request framing must not be confused with native zoom');
  assert.equal(source.capturedAt,null,'A timezone-free imagery date must not become a fabricated timestamp');
  if(source.capturedMonth)assert.match(source.capturedMonth,/^20\d{2}-(0[1-9]|1[0-2])$/);
  const original=new URL(source.url);assert.equal(original.origin,'https://viewer.map.naver.com');assert.equal(original.pathname,'/panorama');assert.equal(original.searchParams.get('id'),source.panoId);assert.equal(original.username+original.password,'');
  assert.equal(capture.image.mime,'image/jpeg');const bytes=Buffer.from(capture.image.data,'base64');assert.equal(bytes[0],0xff);assert.equal(bytes[1],0xd8);assert.ok(bytes.length>15000,'A real panorama screenshot must contain usable image bytes');
  await writeFile(output+`/framing-${zoom}.jpg`,bytes);
  report.captures.push({zoom,bytes:bytes.length,elapsedMs:Date.now()-started,source});
 }
 report.status='passed';
}catch(error){report.failure=String(error.message).replace(/https?:\/\/[^\s<>"']+/g,'[url-redacted]');process.exitCode=1;}
finally{await writeFile(output+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,captures:report.captures.length,failure:report.failure,report:output+'/report.json'}));}
