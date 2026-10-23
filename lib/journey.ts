import { meters, recommendedRoute, inspectionOrder, type Evidence, type JourneyResult, type Place } from './domain';
import { routes } from './providers';
import { analyzeKhuImage, KhuError } from './khu';
import { streetImage, ImageryServiceError } from './street-imagery';
import { serverConfig } from './server-config';
export async function findJourney(start: Place, end: Place, profile: string, signal: AbortSignal): Promise<JourneyResult> {
    const config = serverConfig();
    const candidates = (await routes(start, end, config.routing, signal)).routes;
    if (!config.mapillary && !config.rendererUrl) return {routes:candidates,evidence:{},recommendedId:null,status:'limited'};
    signal.throwIfAborted();
    const evidence: Record<string, Evidence> = {};
    const blockedRoutes = new Set<string>();
    const ordered = inspectionOrder(candidates);
    let lookups = 0, analyses = 0;
    for (const {route, sample} of ordered) {
            signal.throwIfAborted();
            if (lookups >= 120 || analyses >= 120) break;
            if (blockedRoutes.has(route.id)) continue;
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
                if (result.finding.status === 'blocked') blockedRoutes.add(route.id);
            }
            catch (error) {
                signal.throwIfAborted();
                if (error instanceof ImageryServiceError || error instanceof KhuError && [401,402,403,404,429].includes(error.status)) throw error;
                evidence[route.id + ':' + sample.id] = { sampleId: sample.id, status: 'unknown', reason: '이 구간의 이동 환경 정보를 가져오지 못했습니다.', checkedAt: new Date().toISOString() };
            }
    }
    signal.throwIfAborted();
    const recommendedId = recommendedRoute(candidates, evidence);
    return { routes: candidates, evidence, recommendedId, status: recommendedId ? 'ready' : 'limited' };
}
