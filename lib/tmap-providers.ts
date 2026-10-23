import { meters, samplesFor, type Coord, type Place, type Route } from './domain.ts';
type Keys = { tmap: string };
const TMAP = 'https://apis.openapi.sk.com/tmap';
export class ServiceError extends Error {
    status: number;
    constructor(message: string, status = 400) { super(message); this.status = status; }
}
function required(value: string, name: string) { if (!value?.trim())
    throw new ServiceError('길찾기 서비스를 잠시 이용할 수 없습니다.', 503); return value.trim(); }
async function json(url: string, init: RequestInit = {}, service = '외부 서비스'): Promise<any> {
    const r = await fetch(url, { ...init, redirect: 'manual', signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
    if (!r.ok)
        throw new ServiceError(`${service} 요청 실패 (${r.status}). 키의 권한·사용량·서비스 활성화 상태를 확인해 주세요.`, 502);
    try {
        return await r.json();
    }
    catch {
        throw new ServiceError(service + '에서 올바른 응답을 받지 못했습니다.', 502);
    }
}
export async function search(query: string, keys: Keys, signal?: AbortSignal): Promise<Place[]> {
    const key = required(keys.tmap, 'TMAP');
    const p = new URLSearchParams({ version: '1', searchKeyword: query, resCoordType: 'WGS84GEO', count: '8' });
    const d = await json(TMAP + '/pois?' + p, { headers: { appKey: key }, signal }, 'TMAP 장소 검색');
    return (d.searchPoiInfo?.pois?.poi || []).map((x: any) => ({ id: String(x.id), name: x.name, address: [x.upperAddrName, x.middleAddrName, x.lowerAddrName, x.detailAddrName].filter(Boolean).join(' '), coord: [Number(x.frontLon || x.noorLon), Number(x.frontLat || x.noorLat)] })).filter((x: Place) => x.coord.every(Number.isFinite) && x.coord[0] > 120 && x.coord[1] > 30);
}
export async function geocode(query: string, keys: Keys, signal?: AbortSignal): Promise<Place[]> {
    const key = required(keys.tmap, 'TMAP');
    const p = new URLSearchParams({ version: '1', fullAddr: query, coordType: 'WGS84GEO', addressFlag: 'F00', format: 'json' });
    const d = await json(TMAP + '/geo/fullAddrGeo?' + p, { headers: { appKey: key }, signal }, 'TMAP 주소 검색');
    const raw = d.coordinateInfo?.coordinate || [];
    return (Array.isArray(raw) ? raw : [raw]).map((x: any, i: number) => ({ id: 'addr' + i, name: query, address: [x.city_do, x.gu_gun, x.eup_myun, x.legalDong, x.bunji].filter(Boolean).join(' ') || query, coord: [Number(x.newLon || x.lon), Number(x.newLat || x.lat)] as Coord })).filter((x: Place) => x.coord.every(Number.isFinite) && x.coord[0] > 120 && x.coord[1] > 30);
}
export async function routes(start: Place, end: Place, keys: Keys, signal?: AbortSignal) {
    const key = required(keys.tmap, 'TMAP');
    if (meters(start.coord, end.coord) > 15000)
        throw new ServiceError('MVP는 직선거리 15km 이내에서 이용해 주세요.');
    const options = [['30', '계단 제외'], ['4', '대로 우선'], ['10', '최단 경로']];
    const result: Route[] = [];
    const errors: string[] = [];
    for (const [option, name] of options) {
        if (signal?.aborted)
            break;
        try {
            const d = await json(TMAP + '/routes/pedestrian?version=1', { method: 'POST', signal, headers: { appKey: key, 'Content-Type': 'application/json' }, body: JSON.stringify({ startX: start.coord[0], startY: start.coord[1], endX: end.coord[0], endY: end.coord[1], startName: encodeURIComponent(start.name), endName: encodeURIComponent(end.name), reqCoordType: 'WGS84GEO', resCoordType: 'WGS84GEO', searchOption: option }) }, 'TMAP ' + name);
            const features = d.features;
            if (!Array.isArray(features))
                throw new ServiceError('경로 응답에 지리정보가 없습니다.', 502);
            const coords: Coord[] = features.filter((f: any) => f.geometry?.type === 'LineString').flatMap((f: any) => f.geometry.coordinates).filter((c: Coord, i: number, a: Coord[]) => i === 0 || meters(c, a[i - 1]) > 0.1);
            if (coords.length < 2)
                throw new ServiceError('표시할 수 있는 경로가 없습니다.', 502);
            const signature = JSON.stringify(coords.map(c => c.map(n => n.toFixed(5))));
            const same = result.find(r => JSON.stringify(r.coords.map(c => c.map(n => n.toFixed(5)))) === signature);
            if (same) {
                same.options.push(name);
                continue;
            }
            const steps = features.filter((f: any) => f.geometry?.type === 'Point' && f.properties?.description).map((f: any) => ({ text: String(f.properties.description), coord: f.geometry.coordinates as Coord }));
            const distance = Number(features[0]?.properties?.totalDistance) || coords.slice(1).reduce((v, c, i) => v + meters(coords[i], c), 0);
            if (distance > 20000)
                throw new ServiceError('보행 경로가 MVP 분석 한도인 20km를 초과했습니다.');
            result.push({ id: 'route' + option, name, options: [name], coords, distance, seconds: Number(features[0]?.properties?.totalTime) || 0, steps, samples: samplesFor(coords, steps.filter((s: any) => /횡단|계단|육교|지하|진입/.test(s.text)).map((s: any) => s.coord)), fetchedAt: new Date().toISOString() });
        }
        catch (e) {
            errors.push(e instanceof Error ? e.message : '경로 조회 실패');
        }
    }
    if (!result.length)
        throw new ServiceError('길찾기 서비스를 잠시 이용할 수 없습니다.', 503);
    return { routes: result, warnings: errors };
}
