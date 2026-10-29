import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeImageContext } from '../lib/route-context.ts';
import { meters, samplesFor, type Route, type Coord } from '../lib/domain.ts';

const start: Coord = [127, 37], corner: Coord = [127, 37.001], end: Coord = [127.001, 37.001];
const route: Route = { id: 'turn', name: 'turn', options: [], coords: [start, corner, end], distance: meters(start, corner) + meters(corner, end), seconds: 0, steps: [{ coord: corner, text: '횡단 후 오른쪽으로 이동' }], samples: samplesFor([start, corner, end], [corner]), fetchedAt: '' };
const source = { url: 'https://map.kakao.com/', capturedAt: null, capturedMonth: '2026-07', coord: corner, heading: 0 };
function geometry(text: string) {
    return JSON.parse(text.split('경로 대응 보조 정보: ')[1].split('\n')[0]);
}
test('turn context follows ordered geometry rather than camera heading or nearest road segment', () => {
    const sample = route.samples.find(sample => meters(sample.coord, corner) < 0.1);
    assert.ok(sample);
    const context = routeImageContext({ route, sample, source });
    const data = geometry(context);
    assert.ok(Math.abs(data.routeTravel.entryHeadingDegrees) < 0.1);
    assert.ok(Math.abs(data.routeTravel.exitHeadingDegrees - 90) < 0.1);
    assert.ok(Math.abs(data.routeTravel.turnDegrees - 90) < 0.1);
    assert.deepEqual(data.positions.map((point: { relativeAlongMeters: number }) => point.relativeAlongMeters), [-25, -10, 0, 10, 25]);
    assert.equal(data.positions[2].cameraRelativeBearingDegrees, null);
    assert.ok(data.positions[3].cameraRelativeBearingDegrees > 89);
    assert.match(context, /사진 픽셀 위치를 보정한 투영이 아니다/);
    assert.match(context, /좌우 보도나 횡단 위치를 확정하지 마라/);
});
test('context locates the requested target relative to the actual camera without equating road and sidewalk',()=>{
    const sample={...route.samples[0],target:'crossing-entry' as const};
    const context=routeImageContext({route,sample,source:{...source,coord:[start[0],start[1]-0.0001],heading:90}});
    const target=geometry(context).target;
    assert.equal(target.kind,'crossing-entry');
    assert.deepEqual(target.coord,start);
    assert.ok(target.cameraDistanceMeters>10);
    assert.ok(Math.abs(target.cameraRelativeBearingDegrees+90)<0.1);
    assert.match(context,/도로가 평탄하다는 이유로 보도를 clear로 판정하지 마라/);
    assert.match(context,/현재 상태라고 단정하지 마라/);
});
test('route endpoints do not invent an entry or exit outside route geometry', () => {
    const first = route.samples[0], last = route.samples.at(-1);
    assert.ok(last);
    const initial = geometry(routeImageContext({ route, sample: first, source: { ...source, coord: start } }));
    const final = geometry(routeImageContext({ route, sample: last, source: { ...source, coord: end, heading: 90 } }));
    assert.equal(initial.routeTravel.entryHeadingDegrees, null);
    assert.equal(final.routeTravel.exitHeadingDegrees, null);
    assert.ok(initial.positions.every((point: { relativeAlongMeters: number }) => point.relativeAlongMeters >= 0));
    assert.ok(final.positions.every((point: { relativeAlongMeters: number }) => point.relativeAlongMeters <= 0));
    assert.equal(initial.positions[3].cameraRelativeBearingDegrees, 0);
});
test('analysis context distinguishes actual angular FOV and downward-positive tilt from request presets',()=>{
    const camera=geometry(routeImageContext({route,sample:route.samples[0],source:{...source,heading:194,tilt:7,fov:60,zoom:2}})).camera;
    assert.equal(camera.headingDegrees,194);
    assert.equal(camera.tiltDegreesPositiveDown,7);
    assert.equal(camera.fovDegrees,60);
    assert.equal(camera.requestedFramingPreset,2);
    assert.equal(camera.zoom,undefined);
});
