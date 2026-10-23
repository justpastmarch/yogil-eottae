import { z } from 'zod';

export type Coord = [
    number,
    number
]; // longitude, latitude
export type Place = {
    id: string;
    name: string;
    address: string;
    coord: Coord;
};
export const featureObservationSchema = z.object({
    state: z.enum(['present', 'not-observed', 'unobservable']),
    reason: z.string().min(1).max(1000),
});
export type FeatureObservation = z.infer<typeof featureObservationSchema>;
export const findingSchema = z.object({
    status: z.enum(['clear', 'caution', 'blocked', 'unknown']),
    reason: z.string(),
    evidence: z.array(z.string()),
    limitations: z.array(z.string()),
    pathVisible: z.boolean(),
    routeMatch: z.enum(['same-path', 'uncertain', 'different-path']).default('uncertain'),
    features: z.object({ stairs: featureObservationSchema, incline: featureObservationSchema }).optional(),
});
export type Finding = z.infer<typeof findingSchema>;
export type Sample = {
    id: string;
    coord: Coord;
    heading: number;
    along: number;
    critical: boolean;
};
export type Route = {
    id: string;
    name: string;
    options: string[];
    coords: Coord[];
    distance: number;
    seconds: number;
    steps: {
        text: string;
        coord: Coord;
    }[];
    samples: Sample[];
    fetchedAt: string;
    detourReason?: string;
};
export type BlockedPassage = {
    id: string;
    routeId: string;
    sampleId: string;
    fromAlong: number;
    toAlong: number;
    coords: Coord[];
};
export type RouteAssessments = Record<string, { blockedPassageIds: string[] }>;
export type Evidence = {
    stage?: 'reserved' | 'processed';
    sampleId: string;
    status: Finding['status'];
    reason: string;
    finding?: Finding;
    source?: {
        url: string;
        capturedAt: number | null;
        capturedMonth?: string;
        coord: Coord;
        distance: number;
    };
    checkedAt: string;
};
export type JourneyResult = {
    routes: Route[];
    evidence: Record<string, Evidence>;
    assessments: RouteAssessments;
    recommendedId: string | null;
    status: 'ready' | 'limited';
};
export function recommendedRoute(routes: Route[], evidence: Record<string, Evidence>, assessments?: RouteAssessments): string | null {
    return rankRoutes(routes, evidence).find(route => {
        const s = summary(route, evidence);
        return s.total > 0 && s.clear === s.total && (!assessments || assessments[route.id]?.blockedPassageIds.length === 0);
    })?.id ?? null;
}
export function inspectionOrder(routes: Route[]) {
    return routes.flatMap(route => [...route.samples]
        .sort((a, b) => Number(b.critical) - Number(a.critical) || a.along - b.along)
        .map(sample => ({route, sample})));
}
export function meters(a: Coord, b: Coord) { const r = Math.PI / 180, dp = (b[1] - a[1]) * r, dl = (b[0] - a[0]) * r; const v = Math.sin(dp / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dl / 2) ** 2; return 6371000 * 2 * Math.atan2(Math.sqrt(v), Math.sqrt(Math.max(0, 1 - v))); }
export function bearing(a: Coord, b: Coord) { const r = Math.PI / 180; return (Math.atan2(Math.sin((b[0] - a[0]) * r) * Math.cos(b[1] * r), Math.cos(a[1] * r) * Math.sin(b[1] * r) - Math.sin(a[1] * r) * Math.cos(b[1] * r) * Math.cos((b[0] - a[0]) * r)) * 180 / Math.PI + 360) % 360; }
export type RouteProjection = { coord: Coord; along: number; heading: number; distance: number; segmentIndex: number };
export function projectOnRoute(coords: Coord[], point: Coord): RouteProjection | null {
    let nearest: RouteProjection | null = null;
    let total = 0;
    for (let i = 1; i < coords.length; i++) {
        const a = coords[i - 1], b = coords[i], length = meters(a, b);
        if (!length) continue;
        const scale = Math.cos((a[1] + b[1]) / 2 * Math.PI / 180);
        const dx = (b[0] - a[0]) * scale, dy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, (((point[0] - a[0]) * scale * dx) + (point[1] - a[1]) * dy) / (dx * dx + dy * dy)));
        const coord: Coord = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        const distance = meters(point, coord);
        if (!nearest || distance < nearest.distance)
            nearest = { coord, along: total + length * t, heading: bearing(a, b), distance, segmentIndex: i - 1 };
        total += length;
    }
    return nearest;
}
export function samplesFor(coords: Coord[], critical: Coord[] = [], spacing = 50): Sample[] {
    if (!Number.isFinite(spacing) || spacing <= 0) throw new RangeError('Sample spacing must be positive.');
    const out: Sample[] = [];
    let total = 0, next = 0;
    for (let i = 1; i < coords.length; i++) {
        const a = coords[i - 1], b = coords[i], len = meters(a, b);
        if (!len)
            continue;
        while (next <= total + len) {
            const t = (next - total) / len;
            out.push({ id: 's' + out.length, coord: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], heading: bearing(a, b), along: next, critical: false });
            next += spacing;
        }
        total += len;
    }
    const end = coords.at(-1), beforeEnd = coords.at(-2), lastSample = out.at(-1);
    if (end && beforeEnd && total > 0) {
        if (lastSample && total - lastSample.along < 0.1) lastSample.critical = true;
        else out.push({ id: 'end', coord: end, heading: bearing(beforeEnd, end), along: total, critical: true });
    }
    for (const p of critical) {
        const projected = projectOnRoute(coords, p);
        if (!projected || projected.distance > 20) continue;
        const existing = out.find(s => Math.abs(s.along - projected.along) < 1);
        if (existing) Object.assign(existing, { coord: projected.coord, along: projected.along, heading: projected.heading, critical: true });
        else out.push({ id: 'c' + out.length, coord: projected.coord, heading: projected.heading, along: projected.along, critical: true });
    }
    return out.sort((a, b) => a.along - b.along).map((s, i) => ({ ...s, id: 's' + i }));
}
export function summary(route: Route, evidence: Record<string, Evidence>) { const items = route.samples.map(s => evidence[route.id + ':' + s.id]).map(e => e?.stage === 'reserved' ? undefined : e); const count = (status: string) => items.filter(e => e?.status === status).length; return { total: items.length, checked: items.filter(Boolean).length, clear: count('clear'), blocked: count('blocked'), caution: count('caution'), unknown: items.filter(e => !e || e.status === 'unknown').length }; }
export function rankRoutes(routes: Route[], evidence: Record<string, Evidence>) { return [...routes].sort((a, b) => { const x = summary(a, evidence), y = summary(b, evidence); return x.blocked - y.blocked || (x.unknown / x.total - y.unknown / y.total) || x.caution - y.caution || a.distance - b.distance; }); }
export function validateFinding(value: unknown): Finding {
    const parsed = findingSchema.safeParse(value);
    if (!parsed.success) throw new Error('AI 응답 형식을 확인할 수 없습니다.');
    const f = parsed.data;
    const observable=f.pathVisible&&f.routeMatch==='same-path';
    const observedFeature=f.features?.stairs.state==='present'||f.features?.incline.state==='present';
    const status = !observable ? 'unknown' : f.status==='clear'&&observedFeature?'caution':f.status;
    const reason=f.status==='clear'&&status==='caution'?'계단 또는 경사가 관찰되어 통행 가능 판정을 보류했습니다. '+f.reason:f.reason;
    const unobservable: FeatureObservation = { state: 'unobservable', reason: '사진에서 지정한 이동 통로의 해당 특징을 확인할 수 없습니다.' };
    return { ...f, ...(f.features && status === 'unknown' ? { features: { stairs: unobservable, incline: unobservable } } : {}), status, reason: reason.slice(0, 1000), evidence: f.evidence.slice(0, 8), limitations: f.limitations.slice(0, 8) };
}
