import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {deflateSync,inflateSync} from 'node:zlib';
import {Miniflare} from 'miniflare';
import {saveJourneyCapture,listJourneyCaptures,readJourneyCapture} from '../lib/journey-captures.ts';
import {imageInput,MAX_IMAGE_BYTES} from '../lib/khu.ts';
import type {CapturedJourneyView} from '../lib/capture-contract.ts';
import {runWithServerEnv} from '../lib/server-config.ts';
import {GET} from '../app/api/journey-image/route.ts';

const lease={revision:7,token:'current-lease'};
const smallPng=imageInput.parse({mime:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='});
function view(viewId='initial'):CapturedJourneyView{
    return {evidenceId:'route:point',viewId,image:{image:smallPng,source:{url:'https://map.kakao.com/?panoid=actual-source',panoId:'actual-source',capturedAt:null,capturedMonth:'2026-10',coord:[127,37.0001],heading:165,tilt:25,zoom:1}},target:{id:'point',coord:[127,37],along:582,heading:90,critical:true}};
}
async function insertJob(db:D1Database,id='job',now=1000,owner='owner'){
    await db.prepare('INSERT INTO journey_jobs (id,owner_id,state,phase,revision,lease_token,lease_until,expires_at,updated_at) VALUES (?,?,?,\'running\',?,?,?,?,?)').bind(id,owner,JSON.stringify({evidence:{'route:point':{stage:'reserved'}}}),lease.revision,lease.token,now+90_000,now+30*60_000,now).run();
}
async function withDatabase(run:(db:D1Database)=>Promise<void>){
    const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-01-01',d1Databases:['DB']});
    try{
        const db=await mf.getD1Database('DB');
        for(const name of ['0000_aromatic_skullbuster.sql','0001_journey_captures.sql']){
            const sql=await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8');
            for(const statement of sql.split('--> statement-breakpoint'))await db.prepare(statement).run();
        }
        await run(db);
    }finally{await mf.dispose();}
}
function pngChunk(type:string,data:Buffer):Buffer{
    const body=Buffer.concat([Buffer.from(type),data]),chunk=Buffer.alloc(data.length+12);
    chunk.writeUInt32BE(data.length,0);
    body.copy(chunk,4);
    let crc=0xffffffff;
    for(const byte of body){
        crc^=byte;
        for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);
    }
    chunk.writeUInt32BE((crc^0xffffffff)>>>0,chunk.length-4);
    return chunk;
}
function maximumPng(){
    const width=1024,height=1023,stride=width*4+1,rows=Buffer.alloc(stride*height);
    for(let y=0;y<height;y++)for(let x=0;x<width*4;x++)rows[y*stride+x+1]=(x*73+y*29)%256;
    const header=Buffer.alloc(13);
    header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
    const signature=Buffer.from([137,80,78,71,13,10,26,10]);
    const ihdr=pngChunk('IHDR',header),idat=pngChunk('IDAT',deflateSync(rows,{level:0})),iend=pngChunk('IEND',Buffer.alloc(0));
    const padding=Buffer.alloc(MAX_IMAGE_BYTES-signature.length-ihdr.length-idat.length-iend.length-12,65);
    padding.write('padding\0');
    return {bytes:Buffer.concat([signature,ihdr,idat,pngChunk('tEXt',padding),iend]),rows};
}

test('real D1 publishes actual capture metadata and bytes while analysis remains reserved, retaining them after failure',async()=>{
    await withDatabase(async db=>{
        await insertJob(db);
        const capture=await saveJourneyCapture(db,{jobId:'job',ownerId:'owner',lease,view:view()},1001);
        assert.ok(capture);
        assert.match(capture.id,/^[0-9a-f-]{36}$/);
        assert.equal(capture.url,'/api/journey-image?id='+capture.id);
        assert.deepEqual(capture.source,{...view().image.source,distance:11});
        assert.equal(capture.evidenceId,'route:point');assert.equal(capture.viewId,'initial');
        assert.equal(capture.createdAt,new Date(1001).toISOString());
        const listed=await listJourneyCaptures(db,'job','owner',1002);
        assert.deepEqual(listed,[capture]);
        assert.equal('bytes' in listed[0],false);assert.equal('data' in listed[0],false);
        const stored=await db.prepare('SELECT state FROM journey_jobs WHERE id=?').bind('job').first('state');
        assert.equal(stored,JSON.stringify({evidence:{'route:point':{stage:'reserved'}}}));
        assert.deepEqual(await readJourneyCapture(db,capture.id,'owner',1002),{mime:'image/png',bytes:Uint8Array.from(Buffer.from(smallPng.data,'base64'))});
        const review=view('review-look-left');review.image.source.heading=105;
        const rotated=await saveJourneyCapture(db,{jobId:'job',ownerId:'owner',lease,view:review},1003);
        assert.ok(rotated);assert.notEqual(rotated.id,capture.id);
        await db.prepare("UPDATE journey_jobs SET phase='limited',state=?,lease_token=NULL,lease_until=0,revision=revision+1 WHERE id='job'").bind(JSON.stringify({evidence:{'route:point':{status:'unknown',failure:'analysis'}}})).run();
        assert.deepEqual(await listJourneyCaptures(db,'job','owner',1004),[capture,rotated]);
        assert.deepEqual((await readJourneyCapture(db,rotated.id,'owner',1004))?.bytes,Uint8Array.from(Buffer.from(smallPng.data,'base64')));
    });
});

test('real D1 owner, current revision, lease, running phase and expiry fence every capture write',async()=>{
    await withDatabase(async db=>{
        await insertJob(db);
        const input={jobId:'job',ownerId:'owner',lease,view:view()};
        assert.equal(await saveJourneyCapture(db,{...input,ownerId:'other'},1001),null);
        assert.equal(await saveJourneyCapture(db,{...input,jobId:'missing'},1001),null);
        assert.equal(await saveJourneyCapture(db,{...input,lease:{...lease,revision:6}},1001),null);
        assert.equal(await saveJourneyCapture(db,{...input,lease:{...lease,token:'stale-token'}},1001),null);
        assert.equal(await saveJourneyCapture(db,input,91_000),null);
        assert.equal(await saveJourneyCapture(db,input,1_801_000),null);
        await db.prepare("UPDATE journey_jobs SET lease_token='replacement',revision=8,lease_until=200000 WHERE id='job'").run();
        assert.equal(await saveJourneyCapture(db,input,91_001),null);
        const replacement={...input,lease:{revision:8,token:'replacement'}};
        const captured=await saveJourneyCapture(db,replacement,91_002);assert.ok(captured);
        await db.prepare("UPDATE journey_jobs SET phase='canceled' WHERE id='job'").run();
        assert.equal(await saveJourneyCapture(db,replacement,91_003),null);
        assert.deepEqual(await listJourneyCaptures(db,'job','owner',91_004),[captured]);
        assert.equal(await readJourneyCapture(db,captured.id,'other',91_004),null);
        assert.deepEqual(await listJourneyCaptures(db,'job','other',91_004),[]);
        assert.deepEqual(await listJourneyCaptures(db,'job','owner',1_801_000),[]);
        assert.equal(await readJourneyCapture(db,captured.id,'owner',1_801_000),null);
        assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM journey_captures').first<{count:number}>())?.count,1);
        assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM journey_capture_parts').first<{count:number}>())?.count,1);
    });
});

test('real D1 reconstructs the exact 4MiB submitted PNG and its pixels from at-most-1MiB parts',async()=>{
    await withDatabase(async db=>{
        await insertJob(db);
        const png=maximumPng();assert.equal(png.bytes.length,MAX_IMAGE_BYTES);
        const capturedView=view();capturedView.image.image={mime:'image/png',data:png.bytes.toString('base64')};
        const capture=await saveJourneyCapture(db,{jobId:'job',ownerId:'owner',lease,view:capturedView},1001);assert.ok(capture);
        const sizes=await db.prepare('SELECT part_index,length(bytes) AS length FROM journey_capture_parts WHERE capture_id=? ORDER BY part_index').bind(capture.id).all();
        assert.deepEqual(sizes.results,[{part_index:0,length:1048576},{part_index:1,length:1048576},{part_index:2,length:1048576},{part_index:3,length:1048576}]);
        const result=await readJourneyCapture(db,capture.id,'owner',1002);assert.ok(result);
        assert.equal(result.mime,'image/png');assert.deepEqual(result.bytes,Uint8Array.from(png.bytes));
        const reconstructed=Buffer.from(result.bytes),compressed:Buffer[]=[];
        for(let offset=8;offset<reconstructed.length;){
            const length=reconstructed.readUInt32BE(offset),type=reconstructed.toString('ascii',offset+4,offset+8);
            if(type==='IDAT')compressed.push(reconstructed.subarray(offset+8,offset+8+length));
            offset+=length+12;
        }
        assert.deepEqual(inflateSync(Buffer.concat(compressed)),png.rows);
    });
});

test('real D1 rolls back metadata and earlier parts if a later image part cannot commit',async()=>{
    await withDatabase(async db=>{
        await insertJob(db);
        await db.prepare("CREATE TRIGGER reject_second_part BEFORE INSERT ON journey_capture_parts WHEN NEW.part_index=1 BEGIN SELECT RAISE(ABORT,'part failure'); END").run();
        const capturedView=view();capturedView.image.image={mime:'image/png',data:maximumPng().bytes.toString('base64')};
        await assert.rejects(saveJourneyCapture(db,{jobId:'job',ownerId:'owner',lease,view:capturedView},1001));
        assert.deepEqual(await listJourneyCaptures(db,'job','owner',1002),[]);
        assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM journey_capture_parts').first<{count:number}>())?.count,0);
    });
});

test('real D1 expiry cleanup cascades through capture metadata and all image parts',async()=>{
    await withDatabase(async db=>{
        await insertJob(db);
        const capturedView=view();capturedView.image.image={mime:'image/png',data:maximumPng().bytes.toString('base64')};
        const capture=await saveJourneyCapture(db,{jobId:'job',ownerId:'owner',lease,view:capturedView},1001);assert.ok(capture);
        await db.prepare('DELETE FROM journey_jobs WHERE expires_at<=?').bind(1_801_000).run();
        assert.equal(await readJourneyCapture(db,capture.id,'owner',1002),null);
        assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM journey_captures').first<{count:number}>())?.count,0);
        assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM journey_capture_parts').first<{count:number}>())?.count,0);
    });
});

test('private image GET authenticates owner and origin, returns exact submitted bytes, and never proxies URLs',async()=>{
    await withDatabase(async db=>{
        const now=Date.now();await insertJob(db,'job',now);
        const capture=await saveJourneyCapture(db,{jobId:'job',ownerId:'owner',lease,view:view()},now);assert.ok(capture);
        const url='https://app.example'+capture.url;
        const get=(request:Request)=>runWithServerEnv({DB:db},()=>GET(request));
        const response=await get(new Request(url,{headers:{'oai-authenticated-user-id':'owner',origin:'https://app.example'}}));
        assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');
        assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');
        assert.equal(response.headers.get('access-control-allow-origin'),null);
        assert.deepEqual(new Uint8Array(await response.arrayBuffer()),Uint8Array.from(Buffer.from(smallPng.data,'base64')));
        assert.equal((await get(new Request(url))).status,401);
        assert.equal((await get(new Request(url,{headers:{'oai-authenticated-user-id':'other'}}))).status,404);
        assert.equal((await get(new Request(url,{headers:{'oai-authenticated-user-id':'owner',origin:'https://other.example'}}))).status,403);
        assert.equal((await get(new Request('https://app.example/api/journey-image?url=https://remote.example/private',{headers:{'oai-authenticated-user-id':'owner'}}))).status,404);
        assert.equal((await get(new Request('https://app.example/api/journey-image?id=invalid',{headers:{'oai-authenticated-user-id':'owner'}}))).status,404);
        await db.prepare('UPDATE journey_jobs SET expires_at=? WHERE id=?').bind(now-1,'job').run();
        assert.equal((await get(new Request(url,{headers:{'oai-authenticated-user-id':'owner'}}))).status,404);
    });
});
