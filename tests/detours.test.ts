import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meters, samplesFor, type Coord, type Place, type Route } from '../lib/domain.ts';
import { blockedPassageFor, detourViaPlans, routeIsDistinct, routeTouchesPassage, validateCandidate } from '../lib/detours.ts';
import { reroute, routes } from '../lib/providers.ts';

function point(east: number, north = 0): Coord {
    return [127 + east / (111195 * Math.cos(37 * Math.PI / 180)), 37 + north / 111195];
}
function route(points: Coord[], id = 'r'): Route {
    return { id, name: id, options: [], coords: points, distance: points.slice(1).reduce((n, p, i) => n + meters(points[i], p), 0), seconds: 600, steps: [], samples: samplesFor(points), fetchedAt: '' };
}
const straight = route([point(0), point(300)]);
const midpoint = { id: 'middle', coord: point(150), along: 150, heading: 90, critical: true };
const passage = blockedPassageFor(straight, midpoint);

test('equivalent routes dedupe across vertex density and reversed direction', () => {
    const dense = route(Array.from({ length: 61 }, (_, i) => point(i * 5)));
    assert.equal(routeIsDistinct(dense, [straight]), false);
    assert.equal(routeIsDistinct(route([...dense.coords].reverse()), [straight]), false);
    assert.equal(routeIsDistinct(route([point(0), point(100), point(100, 30), point(200, 30), point(200), point(300)]), [straight]), true);
    assert.equal(routeIsDistinct(route([point(0, 5), point(300, 5)]), [straight]), true);
});

test('passages retain bends and match shared travel in either direction', () => {
    const bent = route([point(0), point(50), point(50, 100)]);
    const bend = blockedPassageFor(bent, { ...midpoint, coord: point(50), along: 50 });
    assert.equal(bend.coords.length, 3);
    assert.ok(Math.abs(bend.toAlong - bend.fromAlong - 30) < 0.01);
    assert.equal(routeTouchesPassage(bent, bend), true);
    assert.equal(routeTouchesPassage(route([...bent.coords].reverse()), bend), true);
    assert.equal(routeTouchesPassage(straight, passage), true);
    assert.equal(routeTouchesPassage(route([point(300), point(0)]), passage), true);
});

test('nearby parallel paths, perpendicular crossings and endpoint approaches do not share a passage', () => {
    assert.equal(routeTouchesPassage(route([point(0, 5), point(300, 5)]), passage), false);
    assert.equal(routeTouchesPassage(route([point(150, -80), point(150, 80)]), passage), false);
    assert.equal(routeTouchesPassage(route([point(0), point(130), point(130, 80)]), passage), false);
});

test('detour proposals supply two distinct waypoints on each side at bounded offsets', () => {
    const plans = detourViaPlans(straight, passage);
    assert.equal(plans.length, 4);
    assert.ok(plans.every(plan => plan.length === 2));
    assert.ok(plans[0][0][1] < 37 && plans[1][0][1] > 37);
    for (const plan of plans) {
        assert.ok(plan[0][0] < point(150)[0] && plan[1][0] > point(150)[0]);
        assert.ok(meters(plan[0], point(100)) <= 101);
    }
});

test('candidate validation accepts a connected bypass and rejects duplicates, disconnection and re-entry', () => {
    const bypass = route([point(0), point(100), point(100, 50), point(200, 50), point(200), point(300)]);
    assert.deepEqual(validateCandidate(bypass, straight, [passage]), { ok: true });
    assert.deepEqual(validateCandidate(straight, straight, []), { ok: false, reason: 'duplicate' });
    assert.deepEqual(validateCandidate(route([point(50), point(300)]), straight, []), { ok: false, reason: 'disconnected' });
    const reentry = route([point(0), point(50, 30), point(100), point(300)]);
    assert.deepEqual(validateCandidate(reentry, straight, [passage]), { ok: false, reason: 'excluded-passage' });
});

test('candidate validation rejects an out-and-back and a closed loop even when the provider reports a short distance', () => {
    const backtracking = route([point(0), point(100), point(100, 80), point(100), point(300)]);
    assert.deepEqual(validateCandidate(backtracking, straight, []), { ok: false, reason: 'backtracking' });
    const loop = route([point(0), point(100), point(100, 70), point(170, 70), point(170), point(100), point(300)]);
    assert.deepEqual(validateCandidate(loop, straight, []), { ok: false, reason: 'backtracking' });
    const excessive = { ...route([point(0), point(0, 700), point(300, 700), point(300)]), distance: 350 };
    assert.deepEqual(validateCandidate(excessive, straight, []), { ok: false, reason: 'excessive-detour' });
    assert.deepEqual(validateCandidate(route([point(0), [NaN, 37], point(300)]), straight, []), { ok: false, reason: 'invalid-geometry' });
});

function response(coords: Coord[]) {
    return Response.json({ status: 'OK', route: { properties: { totalDistance: 300, totalTime: 240 }, legs: [{ steps: [{ properties: { x: coords[0][0], y: coords[0][1], guidance: '직진', distance: 300, time: 240 }, path: { points: coords } }] }] } });
}
const start: Place = { id: 'a', name: '출발', address: '', coord: point(0) };
const end: Place = { id: 'b', name: '도착', address: '', coord: point(300) };
const config = { kind: 'kakao', restKey: 'test-only' } satisfies Parameters<typeof routes>[2];

test('Kakao requests all three real modes and retains labels when returned paths coincide', async t => {
    const requested: string[] = [];
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
        const url = new URL(String(input));
        const mode = url.searchParams.get('route_mode') || '';
        requested.push(mode);
        const coords = mode === 'SHORTEST' ? [point(0), point(100), point(200), point(300)]
            : mode === 'ACCESSIBLE' ? [point(0), point(100, 30), point(200, 30), point(300)] : straight.coords;
        return response(coords);
    });
    const result = await routes(start, end, config);
    assert.deepEqual(requested, ['BROAD_FIRST', 'SHORTEST', 'ACCESSIBLE']);
    assert.equal(result.routes.length, 2);
    assert.deepEqual(result.routes[0].options, ['넓은 길', '최단 경로']);
    assert.equal(result.routes[1].name, '편안한 길');
});

test('a failed mode preserves genuine results while caller cancellation propagates', async t => {
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
        const url = new URL(String(input));
        return url.searchParams.get('route_mode') === 'SHORTEST' ? new Response('', { status: 503 }) : response(straight.coords);
    });
    const result = await routes(start, end, config);
    assert.equal(result.routes.length, 1);
    assert.equal(result.warnings.length, 1);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(routes(start, end, config, controller.signal), { name: 'AbortError' });
});

test('rerouting submits actual ACCESSIBLE waypoints and returns only provider geometry with stable distinct ids', async t => {
    const requests: URL[] = [];
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
        requests.push(new URL(String(input)));
        return response(straight.coords);
    });
    const via = [point(100, 50), point(200, 50)];
    const first = await reroute(start, end, config, via);
    const repeated = await reroute(start, end, config, via);
    const other = await reroute(start, end, config, [point(100, -50), point(200, -50)]);
    assert.equal(requests[0].searchParams.get('route_mode'), 'ACCESSIBLE');
    assert.equal(requests[0].searchParams.get('via_x'), via.map(p => p[0]).join(','));
    assert.equal(requests[0].searchParams.get('via_y'), via.map(p => p[1]).join(','));
    assert.deepEqual(first.coords, straight.coords);
    assert.equal(first.id, repeated.id);
    assert.notEqual(first.id, other.id);
    await assert.rejects(reroute(start, end, config, Array.from({ length: 6 }, () => point(100))));
    assert.equal(requests.length, 3);
});

test('a separate ramp one meter beside stairs remains a distinct inspectable candidate',()=>{
    const ramp=route([point(0),point(100,1),point(200,1),point(300)]);
    assert.equal(routeIsDistinct(ramp,[straight]),true);
    assert.equal(routeTouchesPassage(ramp,passage),false);
});
test('a blocked sample at a later self crossing retains its actual traversal distance',()=>{
    const crossed=route([point(0),point(300),point(300,-100),point(150,-100),point(150,100)]);
    const later={...midpoint,coord:point(150),along:650,heading:0};
    const block=blockedPassageFor(crossed,later);
    assert.equal(block.fromAlong,635);
    assert.ok(block.coords.every(c=>Math.abs(c[0]-point(150)[0])<1e-8));
});
