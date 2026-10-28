import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPedestrianGraph } from '../lib/osm-data.ts';
import type { Route } from '../lib/domain.ts';

const route: Route = { id: 'r', name: 'r', options: [], coords: [[127, 37], [127.001, 37]], distance: 100, seconds: 0, steps: [], samples: [], fetchedAt: '' };

test('aborting all waiters cancels the fetch and does not poison a later request', async t => {
  let calls = 0;
  let firstSignal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async (_input: string|URL|Request, init?: RequestInit) => {
    calls++;
    if (calls === 1) {
      firstSignal = init?.signal ?? undefined;
      const pending = Promise.withResolvers<Response>();
      firstSignal?.addEventListener('abort', () => pending.reject(new Error('aborted')), { once: true });
      return pending.promise;
    }
    return Response.json({ osm3s: { timestamp_osm_base: '2026-01-01T00:00:00Z' }, elements: [] });
  });
  const controller = new AbortController();
  const endpoint = 'https://osm.example/cancel-all';
  const canceled = loadPedestrianGraph(route, controller.signal, endpoint);
  controller.abort();
  assert.deepEqual(await canceled, { kind: 'unavailable', reason: 'network' });
  assert.equal(firstSignal?.aborted, true);
  assert.deepEqual(await loadPedestrianGraph(route, new AbortController().signal, endpoint), { kind: 'unavailable', reason: 'no-data' });
  assert.equal(calls, 2);
});
