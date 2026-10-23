import { bearing, meters, type Coord, type Route, type Sample } from './domain.ts';
import type { StreetImage } from './street-imagery.ts';

type ContextInput = { route: Route; sample: Sample; source: StreetImage['source'] };
const rounded = (value: number) => Math.round(value * 10) / 10;
const relativeAngle = (heading: number, camera: number) => rounded(((heading - camera + 540) % 360) - 180);

export function pointAt(coords: Coord[], along: number): Coord | undefined {
    let traversed = 0;
    for (let index = 1; index < coords.length; index++) {
        const from = coords[index - 1], to = coords[index], length = meters(from, to);
        if (!length) continue;
        if (traversed + length >= along) {
            const fraction = Math.max(0, (along - traversed) / length);
            return [from[0] + (to[0] - from[0]) * fraction, from[1] + (to[1] - from[1]) * fraction];
        }
        traversed += length;
    }
    return coords.at(-1);
}

export function baselineRouteContext({ route, sample, source }: ContextInput): string {
    const step = route.steps.reduce<typeof route.steps[number] | undefined>((nearest, candidate) => !nearest || meters(candidate.coord, sample.coord) < meters(nearest.coord, sample.coord) ? candidate : nearest, undefined);
    return `진행 방향 ${Math.round(sample.heading)}도. 촬영 방향 ${Math.round(source.heading)}도. 촬영 위치 차이 ${Math.round(meters(sample.coord, source.coord))}m. 경로 좌표 ${JSON.stringify(sample.coord)}. 주변 안내: ${step?.text ?? '보행 이동'}. 지정한 진행 방향의 동일 보행 통로임이 사진에서 명확할 때만 same-path로 판정하라. 옆 건물 입구 계단과 현재 이동 통로를 혼동하지 마라.`;
}

export function routeImageContext(input: ContextInput): string {
    const { route, sample, source } = input;
    const length = route.coords.slice(1).reduce((total, coord, index) => total + meters(route.coords[index], coord), 0);
    const positions = [-25, -10, 0, 10, 25].map(offset => {
        const along = Math.max(0, Math.min(length, sample.along + offset));
        const coord = pointAt(route.coords, along);
        if (!coord) return null;
        const distance = meters(source.coord, coord);
        return { relativeAlongMeters: rounded(along - sample.along), coord, cameraDistanceMeters: rounded(distance), cameraRelativeBearingDegrees: distance < 0.5 ? null : relativeAngle(bearing(source.coord, coord), source.heading) };
    }).filter(position => position !== null);
    const before = pointAt(route.coords, Math.max(0, sample.along - 10));
    const after = pointAt(route.coords, Math.min(length, sample.along + 10));
    const entry = before && meters(before, sample.coord) > 0.5 ? bearing(before, sample.coord) : null;
    const exit = after && meters(sample.coord, after) > 0.5 ? bearing(sample.coord, after) : null;
    const nearby = route.steps.map(step => ({ text: step.text, distanceMeters: rounded(meters(step.coord, sample.coord)) })).filter(step => step.distanceMeters <= 40).sort((a, b) => a.distanceMeters - b.distanceMeters).slice(0, 4);
    return baselineRouteContext(input) + '\n경로 대응 보조 정보: ' + JSON.stringify({
        camera: { coord: source.coord, headingDegrees: rounded(source.heading) },
        routeTravel: { entryHeadingDegrees: entry === null ? null : rounded(entry), exitHeadingDegrees: exit === null ? null : rounded(exit), turnDegrees: entry === null || exit === null ? null : relativeAngle(exit, entry) },
        positions, nearbyGuidance: nearby,
    }) + '\nrelativeAlongMeters는 이동 순서상 현재 점의 전후 거리이며 음수는 지나온 방향, 양수는 앞으로 갈 방향이다. cameraRelativeBearingDegrees는 카메라 정면 대비 방위차이며 음수는 왼쪽, 양수는 오른쪽, ±180도는 뒤쪽이다. 이는 지도 좌표의 방위 관계일 뿐 사진 픽셀 위치를 보정한 투영이 아니다. 실제 사진의 교차로·횡단보도·연결부와 대조해 앞으로 이어지는 이동 통로만 관찰하라. 도로 중심선 좌표만으로 좌우 보도나 횡단 위치를 확정하지 마라. 좌표와 안내가 있어도 사진에 그 통로가 보이지 않으면 uncertain이다. 건물 진입 계단은 실제 경로가 그 입구로 이어질 때만 경로 장애로 판단하라. 경로 형상과 단일 영상에서 경사도 수치를 산출하지 마라.';
}
