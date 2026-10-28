import test from 'node:test';
import assert from 'node:assert/strict';
import { authorized, captureMonth, parseCapture, parseOrigin, parseState, targetHeading } from './contract.mjs';

test('capture boundary accepts only known camera controls and coordinates', () => {
  assert.deepEqual(parseCapture({coord:[127,37],heading:359.9}), {coord:[127,37],heading:359.9});
  for (const input of [null, {coord:[127,37]}, {coord:[181,37],heading:0}, {coord:[127,37],heading:360},
    {coord:[127,37],heading:0,url:'http://169.254.169.254/'}, {coord:['127',37],heading:0}]) {
    assert.throws(() => parseCapture(input));
  }
});
test('private app origin cannot point to arbitrary HTTP or embed credentials', () => {
  assert.equal(parseOrigin('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(parseOrigin('https://private.example'), 'https://private.example');
  for (const origin of ['http://internal.example', 'https://user:secret@example.com', 'https://example.com/path', 'file:///etc/passwd']) {
    assert.throws(() => parseOrigin(origin));
  }
});
test('authentication and missing imagery are explicit', () => {
  assert.equal(authorized('Bearer sample', 'sample'), true);
  assert.equal(authorized('Bearer other', 'sample'), false);
  assert.equal(authorized(undefined, 'sample'), false);
  assert.equal(parseState({status:'missing'}), null);
  assert.throws(() => parseState({status:'ready',panoId:'oops',coord:[127,37],heading:0}));
});
test('capture date includes only the month present in visible text', () => {
  assert.equal(captureMonth('선택내용 :\n2026년 07월\n과거사진'), '2026-07');
  assert.equal(captureMonth('2020년 3월'), '2020-03');
  assert.equal(captureMonth('로드뷰 날짜 없음'), null);
});

test('target is a bounded coordinate and viewer heading uses actual panorama location',()=>{
 assert.deepEqual(parseCapture({coord:[127,37],heading:90,target:[127,37.0001]}).target,[127,37.0001]);
 for(const target of [null,[127,37.01],['127',37],[127],[Infinity,37]])assert.throws(()=>parseCapture({coord:[127,37],heading:90,target}));
 assert.ok(targetHeading([127,37],[127,37.0001],90)<1);
 assert.ok(Math.abs(targetHeading([127,37],[127.0001,37],0)-90)<1);
 assert.equal(targetHeading([127,37],[127,37],45),45);
});
test('camera recovery permits bounded tilt and zoom without arbitrary viewer inputs',()=>{
 assert.deepEqual(parseCapture({coord:[127,37],heading:70,tilt:25,zoom:1}),{coord:[127,37],heading:70,tilt:25,zoom:1});
 for(const camera of [{tilt:-46},{tilt:46},{tilt:'25'},{zoom:-1},{zoom:3},{zoom:.5},{zoom:Infinity},{pan:90}])assert.throws(()=>parseCapture({coord:[127,37],heading:70,...camera}));
});
