import { meters, projectOnRoute, samplesFor, type BlockedPassage, type Coord, type Route, type Sample } from './domain.ts';

const SAME_PATH_METERS = 0.1;
const PASSAGE_METERS = 0.25;

function lengthOf(coords: Coord[]) {
    return coords.slice(1).reduce((total, coord, i) => total + meters(coords[i], coord), 0);
}

function pointAt(coords: Coord[], along: number): Coord | undefined {
    let traversed = 0;
    for (let i = 1; i < coords.length; i++) {
        const a = coords[i - 1], b = coords[i], length = meters(a, b);
        if (length > 0 && traversed + length >= along) {
            const t = Math.max(0, (along - traversed) / length);
            return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        }
        traversed += length;
    }
    return coords.at(-1);
}

function followsGeometry(coords: Coord[], reference: Coord[]) {
    return [...coords, ...samplesFor(coords, [], 8).map(sample => sample.coord)].every(coord => {
        const projection = projectOnRoute(reference, coord);
        return projection !== null && projection.distance <= SAME_PATH_METERS;
    });
}

export function routeIsDistinct(candidate: Route, accepted: Route[]): boolean {
    const length = lengthOf(candidate.coords);
    return !accepted.some(route => Math.abs(length - lengthOf(route.coords)) <= Math.max(3, length * 0.005)
        && followsGeometry(candidate.coords, route.coords) && followsGeometry(route.coords, candidate.coords));
}

export function blockedPassageFor(route: Route, sample: Sample): BlockedPassage {
    const along = Math.max(0, Math.min(lengthOf(route.coords), sample.along));
    const fromAlong = Math.max(0, along - 15), toAlong = Math.min(lengthOf(route.coords), along + 15);
    const start = pointAt(route.coords, fromAlong), end = pointAt(route.coords, toAlong);
    const coords: Coord[] = start ? [start] : [];
    let traversed = 0;
    for (let i = 1; i < route.coords.length; i++) {
        traversed += meters(route.coords[i - 1], route.coords[i]);
        if (traversed > fromAlong && traversed < toAlong) coords.push(route.coords[i]);
    }
    if (end && toAlong > fromAlong) coords.push(end);
    return { id: route.id + ':' + sample.id, routeId: route.id, sampleId: sample.id, fromAlong, toAlong, coords };
}

function aligned(a: number, b: number) {
    const difference = Math.abs(a - b) % 180;
    return Math.min(difference, 180 - difference) <= 25;
}

export function routeTouchesPassage(route: Route, passage: BlockedPassage): boolean {
    const length = lengthOf(passage.coords);
    if (length < 1) return false;
    const requiredOverlap = Math.min(10, length * 0.6);
    let overlap = 0;
    let previous: Sample | undefined;
    for (const sample of samplesFor(route.coords, [], 2)) {
        const projection = projectOnRoute(passage.coords, sample.coord);
        const matches = projection !== null && projection.distance <= PASSAGE_METERS && aligned(sample.heading, projection.heading);
        if (matches && previous) {
            overlap += sample.along - previous.along;
            if (overlap >= requiredOverlap) return true;
        } else overlap = 0;
        previous = matches ? sample : undefined;
    }
    return false;
}

function offset(coord: Coord, heading: number, distance: number): Coord {
    const radians = heading * Math.PI / 180;
    return [coord[0] + Math.sin(radians) * distance / (111195 * Math.cos(coord[1] * Math.PI / 180)), coord[1] + Math.cos(radians) * distance / 111195];
}

export function detourViaPlans(route: Route, passage: BlockedPassage): Coord[][] {
    const before = pointAt(route.coords, Math.max(0, passage.fromAlong - 35));
    const after = pointAt(route.coords, Math.min(lengthOf(route.coords), passage.toAlong + 35));
    if (!before || !after) return [];
    const entry = projectOnRoute(route.coords, before), exit = projectOnRoute(route.coords, after);
    if (!entry || !exit) return [];
    return [50, -50, 100, -100].map(distance => [offset(before, entry.heading + 90, distance), offset(after, exit.heading + 90, distance)]);
}

function hasBacktracking(coords: Coord[]) {
    const origin = coords[0];
    if (!origin) return false;
    const scale = 111195 * Math.cos(origin[1] * Math.PI / 180);
    const cells = new Map<string, Sample[]>();
    for (const sample of samplesFor(coords, [], 5)) {
        const x = Math.floor((sample.coord[0] - origin[0]) * scale / 4);
        const y = Math.floor((sample.coord[1] - origin[1]) * 111195 / 4);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const prior = cells.get(`${x + dx},${y + dy}`) || [];
                if (prior.some(point => sample.along - point.along >= 50 && meters(point.coord, sample.coord) <= 4)) return true;
            }
        }
        const key = `${x},${y}`;
        const bucket = cells.get(key) || [];
        bucket.push(sample);
        cells.set(key, bucket);
    }
    return false;
}

export type CandidateValidation = { ok: true } | {
    ok: false;
    reason: 'invalid-geometry' | 'disconnected' | 'duplicate' | 'backtracking' | 'excessive-detour' | 'excluded-passage';
};

export function validateCandidate(candidate: Route, baseline: Route, exclusions: BlockedPassage[]): CandidateValidation {
    const first = candidate.coords[0], last = candidate.coords.at(-1);
    const baselineFirst = baseline.coords[0], baselineLast = baseline.coords.at(-1);
    const length = lengthOf(candidate.coords);
    if (!first || !last || !baselineFirst || !baselineLast || length < 1 || !Number.isFinite(candidate.distance)
        || candidate.distance <= 0 || candidate.coords.some(coord => !coord.every(Number.isFinite) || Math.abs(coord[0]) > 180 || Math.abs(coord[1]) > 90))
        return { ok: false, reason: 'invalid-geometry' };
    if (meters(first, baselineFirst) > 20 || meters(last, baselineLast) > 20) return { ok: false, reason: 'disconnected' };
    if (!routeIsDistinct(candidate, [baseline])) return { ok: false, reason: 'duplicate' };
    if (hasBacktracking(candidate.coords)) return { ok: false, reason: 'backtracking' };
    const limit = Math.min(20000, Math.max(lengthOf(baseline.coords) * 2.5, lengthOf(baseline.coords) + 400));
    if (Math.max(length, candidate.distance) > limit) return { ok: false, reason: 'excessive-detour' };
    if (exclusions.some(passage => routeTouchesPassage(candidate, passage))) return { ok: false, reason: 'excluded-passage' };
    return { ok: true };
}
