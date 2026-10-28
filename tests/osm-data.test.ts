import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPedestrianGraph } from '../lib/osm-data.ts';
import type { Coord, Route } from '../lib/domain.ts';

const route = (coords: Coord[] = [[127, 37], [127.001, 37]]): Route => ({ id: 'r', name: 'r', options: [], coords, distance: 100, seconds: 0, steps: [], samples: [], fetchedAt: '' });
const timestamp = '2026-01-01T00:00:00Z';
const node1 = { type: 'node', id: 1, lat: 37, lon: 127 };
const node2 = { type: 'node', id: 2, lat: 37, lon: 127.001 };
const way = { type: 'way', id: 3, nodes: [1, 2], tags: { highway: 'footway' } };
const data = (elements: unknown[]) => ({ osm3s: { timestamp_osm_base: timestamp }, elements });
const signal = () => new AbortController().signal;

test('retrieves complete topology, deduplicates corridors and caches successful responses', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_input: string|URL|Request, init?: RequestInit) => {
    calls++;
    const query = new URLSearchParams(String(init?.body)).get('data');
    assert.match(query ?? '', /way\["highway"/);
    assert.match(query ?? '', /\(\._;>;\);out body/);
    return Response.json(data([node1, node2, way, { ...way, tags: { highway: 'footway' } }, node1]));
  });
  const endpoint = 'https://osm.example/normal';
  const result = await loadPedestrianGraph(route(), signal(), endpoint);
  assert.equal(result.kind, 'available');
  if (result.kind === 'available') {
    assert.equal(result.graph.snapshotAt, timestamp);
    assert.equal(result.graph.edges.length, 2);
    assert.equal(result.graph.edges[0].access, 'unknown');
  }
  assert.deepEqual(await loadPedestrianGraph(route(), signal(), endpoint), result);
  assert.equal(calls, 1);
});

test('splits a sparse long route into bounded corridors and rejects excessive routes', async t => {
  let query = '';
  t.mock.method(globalThis, 'fetch', async (_input: string|URL|Request, init?: RequestInit) => {
    query = new URLSearchParams(String(init?.body)).get('data') ?? '';
    return Response.json(data([]));
  });
  assert.deepEqual(await loadPedestrianGraph(route([[127, 37], [127.1, 37.1]]), signal(), 'https://osm.example/long'), { kind: 'unavailable', reason: 'no-data' });
  const boxes = [...query.matchAll(/\((-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\);/g)];
  assert.ok(boxes.length > 1);
  for (const box of boxes) {
    assert.ok(Number(box[3]) - Number(box[1]) < 0.02);
    assert.ok(Number(box[4]) - Number(box[2]) < 0.02);
  }
  assert.deepEqual(await loadPedestrianGraph(route([[127, 37], [129, 39]]), signal(), 'https://osm.example/huge'), { kind: 'unavailable', reason: 'too-large' });
});

test('fails closed for conflicting duplicates, missing nodes, remarks and malformed snapshots', async t => {
  const cases = [
    data([node1, node2, way, { ...way, nodes: [2, 1] }]),
    data([node1, way]),
    { ...data([node1, node2, way]), remark: 'runtime error: Query timed out' },
    { elements: [node1, node2, way] },
    data([node1, node2, way, { type: 'node', id: 1, lat: 38, lon: 127 }]),
    data([node1, node2, { ...way, nodes: [1, 'bad'] }]),
  ];
  let index = 0;
  t.mock.method(globalThis, 'fetch', async () => Response.json(cases[index++]));
  for (let i = 0; i < cases.length; i++) {
    assert.deepEqual(await loadPedestrianGraph(route(), signal(), `https://osm.example/partial-${i}`), { kind: 'unavailable', reason: 'incomplete' });
  }
});

test('handles network, invalid endpoint, response size and empty results', async t => {
  assert.deepEqual(await loadPedestrianGraph(route(), signal()), { kind: 'unavailable', reason: 'not-configured' });
  assert.deepEqual(await loadPedestrianGraph(route(), signal(), 'file:///tmp/osm'), { kind: 'unavailable', reason: 'not-configured' });
  t.mock.method(globalThis, 'fetch', async (input: string|URL|Request) => {
    const url = String(input);
    if (url.endsWith('/network')) throw new Error('offline');
    if (url.endsWith('/large')) return new Response('x', { headers: { 'content-length': String(9 * 1024 * 1024) } });
    return Response.json(data([]));
  });
  for (const [path, reason] of [['network', 'network'], ['large', 'too-large'], ['empty', 'no-data']] as const) {
    assert.deepEqual(await loadPedestrianGraph(route(), signal(), `https://osm.example/${path}`), { kind: 'unavailable', reason });
  }
});

test('one canceled caller does not cancel another caller sharing an in-flight request', async t => {
  const pending = Promise.withResolvers<Response>();
  let calls = 0;
  let fetchSignal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async (_input: string|URL|Request, init?: RequestInit) => {
    calls++;
    fetchSignal = init?.signal ?? undefined;
    return pending.promise;
  });
  const first = new AbortController(), second = new AbortController();
  const endpoint = 'https://osm.example/shared';
  const a = loadPedestrianGraph(route(), first.signal, endpoint);
  const b = loadPedestrianGraph(route(), second.signal, endpoint);
  first.abort();
  assert.deepEqual(await a, { kind: 'unavailable', reason: 'network' });
  assert.equal(fetchSignal?.aborted, false);
  pending.resolve(Response.json(data([node1, node2, way])));
  assert.equal((await b).kind, 'available');
  assert.equal(calls, 1);
});
