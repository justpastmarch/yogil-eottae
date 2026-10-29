import test from 'node:test';
import assert from 'node:assert/strict';
import {authorized,assertFramedState,captureMonth,parseCapture,parseOrigin,parseState,sameFrame,targetHeading,texturePanoId,texturesReady,viewerUrl} from './contract.mjs';

const frame={status:'ready',panoId:'1wo1KkbslxgmTWAI88_T7w',coord:[127.0756348,37.247666],heading:194,tilt:7,fov:90,capturedMonth:'2026-06'};

test('capture defaults to a 20 metre radius and downward tilt without accepting arbitrary controls',()=>{
  assert.deepEqual(parseCapture({coord:[127,37],heading:359.9}),{coord:[127,37],heading:359.9,tilt:7,zoom:0,maxDistance:20});
  assert.deepEqual(parseCapture({coord:[127,37],heading:70,tilt:25,zoom:1,maxDistance:60}),{coord:[127,37],heading:70,tilt:25,zoom:1,maxDistance:60});
  for(const value of [null,{coord:[127,37]},{coord:[181,37],heading:0},{coord:[127,37],heading:360},{coord:['127',37],heading:0},
    ...[{url:'http://169.254.169.254/'},{tilt:-46},{tilt:46},{tilt:'25'},{zoom:-1},{zoom:3},{zoom:.5},{zoom:Infinity},{maxDistance:300},{maxDistance:'60'},{pan:90}].map(camera=>({coord:[127,37],heading:0,...camera}))]){
    assert.throws(()=>parseCapture(value));
  }
});

test('private app origin rejects credentials, paths, and nonlocal HTTP',()=>{
  assert.equal(parseOrigin('http://localhost:3000'),'http://localhost:3000');
  assert.equal(parseOrigin('https://private.example'),'https://private.example');
  for(const origin of ['http://internal.example','https://user:secret@example.com','https://example.com/path','file:///etc/passwd'])assert.throws(()=>parseOrigin(origin));
});

test('bearer authentication is exact and SDK authentication differs from lookup failure',()=>{
  assert.equal(authorized('Bearer sample','sample'),true);
  assert.equal(authorized('Bearer other','sample'),false);
  assert.equal(authorized(undefined,'sample'),false);
  assert.throws(()=>parseState({status:'error',code:'auth'}),{status:403});
  assert.throws(()=>parseState({status:'error',code:'lookup'}),{status:502});
  assert.throws(()=>parseState({status:'missing'}));
  assert.equal(parseState({status:'missing',reason:'distance'}),null);
});

test('native opaque panorama IDs and actual camera metadata survive the state boundary',()=>{
  assert.deepEqual(parseState(frame),{panoId:frame.panoId,coord:frame.coord,heading:194,tilt:7,fov:90,capturedMonth:'2026-06'});
  for(const changed of [{panoId:''},{panoId:123},{panoId:'bad\nid'},{heading:360},{coord:[NaN,37]},{fov:0},{fov:101},{tilt:46},{capturedMonth:'2026-02-30'},{fov:undefined}]){
    assert.throws(()=>parseState({...frame,...changed}));
  }
});

test('shooting month accepts only observed valid dates or an unambiguous month and excludes future dates',()=>{
  const now=new Date('2026-10-29T12:00:00Z');
  assert.equal(captureMonth('2026-06-19 13:08:07',now),'2026-06');
  assert.equal(captureMonth('2020-03',now),'2020-03');
  assert.equal(captureMonth('2024-02-29 00:00:00',now),'2024-02');
  for(const value of ['2026-02-30 13:08:07','2025-02-29 00:00:00','2026-06-19 24:00:00','2026-13','2026-11','2026-10-30 00:00:00','2026년 07월','2026-06-19','capture 2026-06','2026-06-19T13:08:07Z',null]){
    assert.equal(captureMonth(value,now),null);
  }
});

test('target aiming uses the actual camera rather than the requested coordinate',()=>{
  const request=parseCapture({coord:[127,37],heading:90,target:[127,37.0001]});
  assert.deepEqual(request.target,[127,37.0001]);
  for(const target of [null,[127,37.01],['127',37],[127],[Infinity,37]])assert.throws(()=>parseCapture({coord:[127,37],heading:90,target}));
  assert.ok(targetHeading([127,37],[127,37.0001],90)<1);
  assert.ok(Math.abs(targetHeading([127,37],[127.0001,37],0)-90)<1);
  assert.equal(targetHeading([127,37],[127,37],45),45);
  const actual={panoId:'opaque',coord:[127,37.00005],heading:0,tilt:7,fov:90};
  assert.doesNotThrow(()=>assertFramedState(request,actual));
  assert.throws(()=>assertFramedState(request,{...actual,heading:90}));
});

test('actual camera distance is enforced and request zoom selects a field of view, not native zoom',()=>{
  const route=parseCapture({coord:[127,37],heading:0});
  const actual={panoId:'opaque',coord:[127,37.0003],heading:0,tilt:7,fov:90};
  assert.throws(()=>assertFramedState(route,actual));
  assert.doesNotThrow(()=>assertFramedState({...route,maxDistance:60},actual));
  for(const [zoom,fov] of [[0,90],[1,60],[2,40]]){
    assert.doesNotThrow(()=>assertFramedState({...route,zoom},{...actual,coord:route.coord,fov}));
    assert.throws(()=>assertFramedState({...route,zoom},{...actual,coord:route.coord,fov:80}));
  }
});

test('original viewer URLs use actual native pan, tilt, fov, and opaque ID',()=>{
  assert.equal(viewerUrl(frame),'https://viewer.map.naver.com/panorama?id=1wo1KkbslxgmTWAI88_T7w&heading=-166&tilt=-7&fov=90');
  assert.equal(sameFrame(frame,{...frame}),true);
  for(const changed of [{panoId:'other'},{coord:[127.076,37.247666]},{heading:195},{tilt:8},{fov:60},{capturedMonth:'2026-05'}])assert.equal(sameFrame(frame,{...frame,...changed}),false);
});

test('capture requires multiple decoded full-size textures for the selected panorama after requests settle',()=>{
  assert.equal(texturePanoId('https://panorama.pstatic.net/image/opaque/cube/front.jpg'),'opaque');
  assert.equal(texturePanoId('https://ssl.pstatic.net/ui/logo.png'),null);
  assert.equal(texturePanoId('https://panorama.pstatic.net/ui/image/opaque/front.jpg'),null);
  const textures=[{panoId:'opaque',width:512,height:512},{panoId:'opaque',width:1024,height:512}];
  assert.equal(texturesReady(textures,0,'opaque',1000,1500),true);
  assert.equal(texturesReady(textures,1,'opaque',1000,1500),false);
  assert.equal(texturesReady(textures,0,'opaque',1000,1499),false);
  assert.equal(texturesReady(textures,0,'other',1000,1500),false);
  assert.equal(texturesReady(textures.slice(0,1),0,'opaque',1000,1500),false);
  assert.equal(texturesReady(textures.map(value=>({...value,height:256})),0,'opaque',1000,1500),false);
});

test('a failed selected panorama texture cannot be hidden by other decoded tiles',()=>{
  const loaded=[{panoId:'selected',width:512,height:512},{panoId:'selected',width:512,height:512}];
  assert.equal(texturesReady([...loaded,{panoId:'selected',failed:true}],0,'selected',1000,1500),false);
  assert.equal(texturesReady([...loaded,{panoId:'selected',width:512,height:512}],0,'selected',1000,1500),true);
  assert.equal(texturesReady([...loaded,{panoId:'unrelated',failed:true}],0,'selected',1000,1500),true);
});
