import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTransitResponse, TransitError } from '../lib/transit.ts';
import { runWithServerEnv } from '../lib/server-config.ts';
import { POST } from '../app/api/transit/route.ts';

// Synthetic provider payload exercises the documented ODsay v1.8 urban response shape.
const payload = { result: { searchType: 0, path: [{ info: { totalTime: 30, totalWalk: 400, payment: 1500 }, subPath: [
  { trafficType: 3, distance: 100, sectionTime: 2 },
  { trafficType: 2, distance: 4000, sectionTime: 12, startName: 'A', endName: 'B', startX: 127.1, startY: 37.2, endX: 127.2, endY: 37.3, lane: [{ busNo: '1' }] },
  { trafficType: 3, distance: 200, sectionTime: 4 },
  { trafficType: 1, distance: 3000, sectionTime: 10, startName: 'B', endName: 'C', lane: [{ name: '2호선' }], startExitNo: '1' },
  { trafficType: 3, distance: 100, sectionTime: 2 },
] }] } };
const start = { id: 'start', name: '출발', address: '', coord: [127, 37] as [number, number] };
const end = { id: 'end', name: '도착', address: '', coord: [127.1, 37.1] as [number, number] };

test('preserves ordered walks and transit without inventing accessibility', () => {
  const result = parseTransitResponse(payload);
  assert.deepEqual(result.candidates[0].legs.map(leg => leg.kind), ['walk', 'bus', 'walk', 'subway', 'walk']);
  assert.ok(result.candidates[0].legs.every(leg => leg.accessibility === 'unknown'));
  assert.deepEqual(result.candidates[0].legs[1].startCoord, [127.1, 37.2]);
  assert.deepEqual(result.candidates[0].legs[1].lines, ['1']);
  assert.deepEqual(result.candidates[0].legs[3].lines, ['2호선']);
});
test('accepts the provider guide subway lane object without losing its name',()=>{
 const source=structuredClone(payload);
 const subway=source.result.path[0].subPath[3];
 const original=subway.lane?.[0];
 assert.ok(original);
 const modified={...source,result:{...source.result,path:source.result.path.map(path=>({...path,subPath:path.subPath.map((leg,index)=>index===3?{...leg,lane:original}:leg)}))}};
 assert.deepEqual(parseTransitResponse(modified).candidates[0].legs[3].lines,['2호선']);
});

test('rejects unsupported intercity responses and distinguishes no results from provider failure', () => {
  assert.throws(() => parseTransitResponse({ result: { searchType: 1, path: [] } }), TransitError);
  assert.throws(() => parseTransitResponse({ error: [{ code: '-99' }] }), (error: unknown) => error instanceof TransitError && error.status === 404);
  assert.throws(() => parseTransitResponse({ error: [{ code: '500', message: 'secret' }] }), (error: unknown) => error instanceof TransitError && error.status === 502 && !error.message.includes('secret'));
  assert.throws(() => parseTransitResponse({ result: { searchType: 0, path: [{ info: {}, subPath: [] }] } }), TransitError);
});

test('provider failures do not expose credentials or upstream details to the user',async t=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json({error:[{code:'500',message:'private-key'}]}));
 const request=new Request('https://example.test/api/transit',{method:'POST',headers:{origin:'https://example.test','oai-authenticated-user-id':'user'},body:JSON.stringify({start,end})});
 const result=await runWithServerEnv({ODSAY_API_KEY:'private-key'},()=>POST(request));
 assert.equal(result.status,502);
 assert.ok(!(await result.text()).includes('private-key'));
});

test('endpoint requires authenticated same-origin requests and server key', async () => {
  const request = (body: unknown, origin = 'https://example.test') => new Request('https://example.test/api/transit', { method: 'POST', headers: { origin, 'oai-authenticated-user-id': 'user' }, body: JSON.stringify(body) });
  assert.equal((await runWithServerEnv({}, () => POST(request({ start, end }, 'https://other.test')))).status, 403);
  assert.equal((await runWithServerEnv({}, () => POST(request({ start, end })))).status, 503);
  assert.equal((await runWithServerEnv({}, () => POST(request({ start: {}, end })))).status, 400);
});
