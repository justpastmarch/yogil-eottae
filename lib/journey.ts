import { meters, recommendedRoute, type Evidence, type JourneyResult, type Place } from './domain';
import { routes } from './providers';
import { analyzeKhuImage } from './khu';
import { streetImage } from './street-imagery';
import { serverConfig } from './server-config';
export async function findJourney(start: Place, end: Place, profile: string, signal: AbortSignal): Promise<JourneyResult> {
    const config = serverConfig();
    const candidates = (await routes(start, end, config, signal)).routes;
    const evidence: Record<string, Evidence> = {};
    const ordered = candidates.map(route => ({ route, samples: [...route.samples].sort((a, b) => Number(b.critical) - Number(a.critical) || a.along - b.along) }));
    let lookups = 0, analyses = 0;
    for (let index = 0; !signal.aborted && ordered.some(item => index < item.samples.length) && lookups < 120 && analyses < 24; index++) {
        for (const { route, samples } of ordered) {
            const sample = samples[index];
            if (!sample)
                continue;
            if (signal.aborted || lookups >= 120 || analyses >= 24)
                break;
            lookups++;
            try {
                const image = await streetImage(sample, config, signal);
                if (!image) {
                    evidence[route.id + ':' + sample.id] = { sampleId: sample.id, status: 'unknown', reason: '이 구간의 이동 환경 정보가 충분하지 않습니다.', checkedAt: new Date().toISOString() };
                    continue;
                }
                analyses++;
                const result = await analyzeKhuImage({ apiKey: config.ai, model: config.model, image: image.image, profile, context: `진행 방향 ${Math.round(sample.heading)}도. 촬영 방향 ${Math.round(image.source.heading)}도. 촬영 위치 차이 ${Math.round(meters(sample.coord, image.source.coord))}m. 같은 보행 공간이 식별되지 않으면 unknown.`, signal });
                evidence[route.id + ':' + sample.id] = { sampleId: sample.id, status: result.finding.status, reason: result.finding.reason, finding: result.finding, source: { url: image.source.url, capturedAt: image.source.capturedAt, coord: image.source.coord, distance: Math.round(meters(sample.coord, image.source.coord)) }, checkedAt: result.checkedAt };
            }
            catch {
                evidence[route.id + ':' + sample.id] = { sampleId: sample.id, status: 'unknown', reason: '이 구간의 이동 환경 정보를 가져오지 못했습니다.', checkedAt: new Date().toISOString() };
            }
        }
    }
    const recommendedId = recommendedRoute(candidates, evidence);
    return { routes: candidates, evidence, recommendedId, status: recommendedId ? 'ready' : 'limited' };
}
