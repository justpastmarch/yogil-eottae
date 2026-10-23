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
export type Finding = {
    status: 'clear' | 'caution' | 'blocked' | 'unknown';
    reason: string;
    evidence: string[];
    limitations: string[];
    pathVisible: boolean;
};
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
};
export type Evidence = {
    sampleId: string;
    status: Finding['status'];
    reason: string;
    finding?: Finding;
    source?: {
        url: string;
        capturedAt: number;
        coord: Coord;
        distance: number;
    };
    checkedAt: string;
};
export type JourneyResult = {
    routes: Route[];
    evidence: Record<string, Evidence>;
    recommendedId: string | null;
    status: 'ready' | 'limited';
};
export function recommendedRoute(routes: Route[], evidence: Record<string, Evidence>): string | null {
    return rankRoutes(routes, evidence).find(route => { const s = summary(route, evidence); return s.total > 0 && s.checked === s.total && s.unknown === 0 && s.blocked === 0; })?.id ?? null;
}
export function meters(a: Coord, b: Coord) { const r = Math.PI / 180, dp = (b[1] - a[1]) * r, dl = (b[0] - a[0]) * r; const v = Math.sin(dp / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dl / 2) ** 2; return 6371000 * 2 * Math.atan2(Math.sqrt(v), Math.sqrt(Math.max(0, 1 - v))); }
export function bearing(a: Coord, b: Coord) { const r = Math.PI / 180; return (Math.atan2(Math.sin((b[0] - a[0]) * r) * Math.cos(b[1] * r), Math.cos(a[1] * r) * Math.sin(b[1] * r) - Math.sin(a[1] * r) * Math.cos(b[1] * r) * Math.cos((b[0] - a[0]) * r)) * 180 / Math.PI + 360) % 360; }
export function samplesFor(coords: Coord[], critical: Coord[] = [], spacing = 50): Sample[] {
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
    if (coords.length > 1)
        out.push({ id: 'end', coord: coords.at(-1)!, heading: bearing(coords.at(-2)!, coords.at(-1)!), along: total, critical: true });
    for (const p of critical) {
        let nearest = out[0];
        for (const s of out)
            if (!nearest || meters(s.coord, p) < meters(nearest.coord, p))
                nearest = s;
        if (nearest && meters(nearest.coord, p) < 15)
            nearest.critical = true;
        else if (nearest)
            out.push({ id: 'c' + out.length, coord: p, heading: nearest.heading, along: nearest.along, critical: true });
    }
    return out.sort((a, b) => a.along - b.along).map((s, i) => ({ ...s, id: 's' + i }));
}
export function summary(route: Route, evidence: Record<string, Evidence>) { const items = route.samples.map(s => evidence[route.id + ':' + s.id]); const count = (status: string) => items.filter(e => e?.status === status).length; return { total: items.length, checked: items.filter(Boolean).length, clear: count('clear'), blocked: count('blocked'), caution: count('caution'), unknown: items.filter(e => !e || e.status === 'unknown').length }; }
export function rankRoutes(routes: Route[], evidence: Record<string, Evidence>) { return [...routes].sort((a, b) => { const x = summary(a, evidence), y = summary(b, evidence); return x.blocked - y.blocked || (x.unknown / x.total - y.unknown / y.total) || x.caution - y.caution || a.distance - b.distance; }); }
export function validateFinding(value: unknown): Finding {
    if (!value || typeof value !== 'object')
        throw new Error('AI 응답 형식을 확인할 수 없습니다.');
    const v = value as Record<string, unknown>;
    if (!['clear', 'caution', 'blocked', 'unknown'].includes(String(v.status)) || typeof v.reason !== 'string' || typeof v.pathVisible !== 'boolean' || !Array.isArray(v.evidence) || !Array.isArray(v.limitations) || ![...v.evidence, ...v.limitations].every(x => typeof x === 'string'))
        throw new Error('AI 응답 형식을 확인할 수 없습니다.');
    const f = v as Finding;
    return { ...f, status: !f.pathVisible ? 'unknown' : f.status, reason: f.reason.slice(0, 1000), evidence: f.evidence.slice(0, 8), limitations: f.limitations.slice(0, 8) };
}
