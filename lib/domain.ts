import { z } from 'zod';
import type {RouteGrade} from './route-grade.ts';

export type Coord=[longitude:number,latitude:number];
export const placeSchema=z.object({
    id:z.string().max(100),
    name:z.string().max(200),
    address:z.string().max(300),
    coord:z.tuple([z.number().min(124).max(132),z.number().min(33).max(40)]),
    phone:z.string().regex(/^\+?[0-9][0-9 ()-]{5,29}$/).optional(),
    placeUrl:z.string().regex(/^https:\/\/place\.map\.kakao\.com\/[0-9]+$/).optional(),
}).strict();
export type Place=z.infer<typeof placeSchema>;
export const featureObservationSchema = z.object({
    state: z.enum(['present', 'not-observed', 'unobservable']),
    reason: z.string().min(1).max(1000),
});
export type FeatureObservation = z.infer<typeof featureObservationSchema>;
export const observationSchema = z.object({
    connection:z.enum(['flush','ramp','raised','stairs','unobservable','not-applicable']),
    surface:z.enum(['continuous','uneven','unpaved','unobservable']),
    uncertainty:z.enum(['none','framing','occlusion','corridor']),
    target:z.enum(['sidewalk','crossing-entry','crossing-exit','arrival','entrance','unspecified']),
    reason:z.string().min(1).max(1000),
});
export const findingSchema = z.object({
    status: z.enum(['clear', 'caution', 'blocked', 'unknown']),
    reason: z.string(),
    evidence: z.array(z.string()),
    limitations: z.array(z.string()),
    pathVisible: z.boolean(),
    visibility: z.enum(['visible', 'occluded', 'unobservable']).optional(),
    reviewReason: z.enum(['framing', 'occlusion', 'corridor-uncertain', 'none']).optional(),
    routeMatch: z.enum(['same-path', 'uncertain', 'different-path']).default('uncertain'),
    features: z.object({ stairs: featureObservationSchema, incline: featureObservationSchema }).optional(),
    observation: observationSchema.optional(),
});
export type Finding = z.infer<typeof findingSchema>;
export type Sample = {
    id: string;
    coord: Coord;
    heading: number;
    along: number;
    critical: boolean;
    target?:z.infer<typeof observationSchema>['target'];
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
    barriers?: RouteBarrier[];
    unresolvedCrossings?:{id:string;coord:Coord;along:number;count:number;source?:'osm'}[];
    unverifiedConnections?:{id:string;kind:'station'|'underpass'|'elevator'|'origin'|'destination';coord:Coord;along:number;reason:string}[];
    crossingSources?:{provider:'openstreetmap';snapshotAt:string;wayIds:number[];along:number}[];
    graphCoverage?:{status:'available'|'unavailable';reason?:'not-configured'|'network'|'incomplete'|'too-large'|'no-data';snapshotAt?:string};
    graphSegment?:{provider:'openstreetmap';snapshotAt:string;startGapMeters:number;endGapMeters:number;sharedRoadMeters:number};
    grade?: RouteGrade;
    crossingChoice?: {id:string;label:string;wayIds:number[]};
};
export type RouteBarrier={sampleId:string;coord:Coord;along:number;reason:string;source?:'provider'|'imagery'|'osm'};
export type BlockedPassage = {
    id: string;
    routeId: string;
    sampleId: string;
    fromAlong: number;
    toAlong: number;
    coords: Coord[];
    reason?: 'obstacle' | 'unverified';
    detail?: string;
};
export const routeIssueSchema = z.object({
    id:z.string(),sampleId:z.string(),coord:z.tuple([z.number(),z.number()]),along:z.number(),
    status:z.enum(['clear','caution','blocked','unknown']),reason:z.string(),action:z.string(),
    source:z.enum(['imagery','provider','geometry','osm','coverage','service']),
});
export type RouteIssue = z.infer<typeof routeIssueSchema>;
export const routeExplorationSchema=z.object({state:z.enum(['searching','finished','interrupted']),attempts:z.number().int().nonnegative(),alternatives:z.number().int().nonnegative(),reason:z.string()});
export type RouteExploration=z.infer<typeof routeExplorationSchema>;
export const routeDecisionSchema = z.object({
    kind:z.enum(['recommended','conditional','detour','hold']),
    reason:z.string(),action:z.string(),issues:z.array(routeIssueSchema),exploration:routeExplorationSchema,
});
export type RouteDecision = z.infer<typeof routeDecisionSchema>;
export function hasOnlyProviderBarriers(decision:RouteDecision):boolean{
    if(decision.kind!=='detour')return false;
    let found=false;
    for(const issue of decision.issues){
        if(issue.status!=='blocked')continue;
        if(issue.source!=='provider')return false;
        found=true;
    }
    return found;
}
export type RouteAssessments=Record<string,{blockedPassageIds:string[];decision:RouteDecision}>;
export const evidenceSourceSchema = z.object({
    url: z.string().url(), capturedAt: z.number().nullable(), capturedMonth: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/).optional(),
    coord: z.tuple([z.number(), z.number()]), distance: z.number(), heading: z.number().optional(), panoId:z.string().optional(),
    tilt:z.number().optional(),zoom:z.number().optional(),
});
export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;
export type Evidence = {
    stage?: 'reserved' | 'processed';
    sampleId: string;
    status: Finding['status'];
    reason: string;
    finding?: Finding;
    source?: EvidenceSource;
    failure?: 'capture' | 'analysis' | 'service' | 'missing';
    review?: {
        state: 'pending' | 'reserved' | 'complete';
        failure?:'capture'|'analysis'|'service';
        reason: 'framing' | 'occlusion' | 'corridor-uncertain';
        initialFinding: Finding;
        initialSource: EvidenceSource;
        sources: { id: string; source: EvidenceSource }[];
        result?: Finding;
        supportIds: string[];
        note: string;
    };
    checkedAt: string;
};
export const journeyGoal=z.enum(['arrival','entrance']);
export type JourneyGoal=z.infer<typeof journeyGoal>;
export type JourneyResult = {
    goal:JourneyGoal;
    routes: Route[];
    evidence: Record<string, Evidence>;
    assessments: RouteAssessments;
    recommendedId: string | null;
    status: 'ready' | 'limited';
    maxSlope?: number | null;
};
/** Present only structured observations as findings; model prose remains an unverified explanation. */
export function describeFinding(finding:Finding):string{
    const observation=finding.observation;
    if(!observation)return '이동 통로의 구조화된 관찰 결과가 없습니다.';
    if(observation.uncertainty==='framing')return '필요한 연결부가 촬영 화면에 들어오지 않았습니다.';
    if(observation.uncertainty==='occlusion')return '필요한 연결부가 촬영 당시 가려져 있었습니다.';
    if(finding.routeMatch!=='same-path'||observation.uncertainty==='corridor')return '사진의 통로가 이동 경로와 일치하는지 확인하지 못했습니다.';
    if(finding.status==='blocked'){
        if(finding.features?.stairs.state==='present'||observation.connection==='stairs')return '진행 구간에서 계단이 관찰됐습니다.';
        if(observation.connection==='raised')return '진행 구간에서 낮춰지지 않은 턱이 관찰됐습니다.';
    }
    if(observation.surface==='uneven')return '사진에서 파손되거나 고르지 않은 노면이 관찰됐습니다.';
    if(observation.surface==='unpaved')return '사진에서 비포장 노면이 관찰됐습니다.';
    if(finding.status==='unknown'||finding.visibility!=='visible'||observation.connection==='unobservable'||observation.surface==='unobservable')return '필요한 이동 통로 또는 연결부를 사진에서 확인하지 못했습니다.';
    if(observation.connection==='ramp')return '사진에서 연결 경사로와 이어지는 노면이 관찰됐습니다.';
    if(observation.connection==='flush')return '사진에서 단차 없이 이어지는 연결 노면이 관찰됐습니다.';
    return '사진에서 이어지는 이동 통로가 관찰됐습니다.';
}
export function evaluateRoute(route:Route,evidence:Record<string,Evidence>,blockedPassageIds:string[]=[],maxSlope?:number|null,exploration:RouteExploration={state:'finished',attempts:0,alternatives:0,reason:'대체 경로 탐색은 진행 중이 아닙니다.'}):RouteDecision{
    if(route.graphSegment)return {kind:'hold',reason:'이 지도 구간은 출발지와 목적지에 연결된 경로가 아닙니다. 양 끝 연결과 접근성은 확인되지 않았습니다.',action:'직선 거리로 표시한 양 끝 간격은 이동 경로가 아닙니다. 연결 가능 여부와 현장 상태를 확인하세요.',issues:[],exploration};
    const issues:RouteIssue[]=route.samples.map(sample=>{
        const id=route.id+':'+sample.id,item=evidence[id],finding=item?.finding,observation=finding?.observation;
        const point={id,sampleId:sample.id,coord:sample.coord,along:sample.along};
        if(item?.failure)return {...point,status:'unknown',source:item.failure==='missing'?'coverage':'service',reason:item.reason,action:item.failure==='missing'?'다른 촬영 위치나 대체 경로를 확인해야 합니다.':'서비스 연결을 복구한 뒤 다시 분석해야 합니다.'};
        if(!item||item.stage==='reserved')return {...point,status:'unknown',source:'coverage',reason:exploration.state==='searching'?(item?.stage==='reserved'?'이 지점을 분석하고 있습니다.':'아직 이 지점을 관찰하지 않았습니다.'):(item?.stage==='reserved'?'판독을 마치기 전에 처리가 종료됐습니다.':'이 탐색에서 관찰하지 않은 지점입니다.'),action:exploration.state==='searching'?'분석 결과를 기다려 주세요.':'이 지점을 통과 가능한 것으로 안내하지 않습니다. 보관된 사진과 다른 후보를 확인하세요.'};
        if(!finding||!item.source||!observation)return {...point,status:'unknown',source:'coverage',reason:'통로를 판단할 구조화된 영상 근거가 없습니다.',action:'이 지점의 거리영상을 다시 확인해야 합니다.'};
        const verified=validateFinding(finding);
        if(item.review?.failure&&verified.status!=='blocked')return {...point,status:'unknown',source:'service',reason:item.review.note,action:'재확인 서비스 처리에 실패했습니다. 원래 관찰은 보존했지만 접근성 안내는 보류합니다.'};
        const targetMatches=!sample.target||sample.target==='unspecified'||observation.target===sample.target;
        const requiredConnection=sample.target==='entrance'||sample.target==='crossing-entry'||sample.target==='crossing-exit';
        if(!targetMatches)return {...point,status:'unknown',source:'imagery',reason:'사진의 관찰 대상이 필요한 연결부와 일치하지 않습니다.',action:'같은 연결부의 다른 촬영 위치를 확인하세요.'};
        const connectionVisible=observation.connection!=='unobservable'&&(!requiredConnection||['flush','ramp'].includes(observation.connection));
        if(verified.status==='blocked')return {...point,status:'blocked',source:'imagery',reason:describeFinding(verified),action:exploration.state==='searching'?'이 구간을 피하는 대체 경로를 찾습니다.':'이 구간을 피한 경로가 확인되어야 접근성 안내를 제공할 수 있습니다.'};
        if(verified.status==='unknown'||!connectionVisible||verified.visibility!=='visible'||observation.uncertainty!=='none'||observation.surface==='unobservable')
            return {...point,status:'unknown',source:'imagery',reason:observation.uncertainty==='none'&&!connectionVisible?'필요한 이동 연결부를 사진에서 확인하지 못했습니다.':describeFinding(verified),action:exploration.state!=='searching'?'연결부를 확인하지 못해 이 지점을 통과 가능한 것으로 안내하지 않습니다.':item.review?.state==='complete'?'이 연결부를 피하는 대체 경로를 확인합니다.':'카메라 시선이나 촬영 위치를 바꿔 다시 확인합니다.'};
        if(verified.status==='caution'&&observation.surface==='continuous')return {...point,status:'unknown',source:'imagery',reason:'주의 판독이지만 지속적인 노면 부담의 구조화된 근거가 없습니다. 과거 차량을 현재의 통행 장애로 안내하지 않습니다.',action:exploration.state!=='searching'?'지속적인 노면 부담을 확인하지 못해 이 지점을 접근성 안내에 사용하지 않습니다.':item.review?.state==='complete'?'재확인 후에도 지속적인 부담과 가림을 구별하지 못하면 이 연결을 피하는 대안을 찾습니다.':'다른 시선에서 연결부와 지속적인 노면 부담을 다시 확인합니다.'};
        if(verified.status==='caution'||observation.surface==='uneven'||observation.surface==='unpaved')
            return {...point,status:'caution',source:'imagery',reason:describeFinding(verified),action:observation.surface==='unpaved'?'비포장 노면 부담이 있어 포장된 대안을 우선 선택하세요.':'노면과 이동 부담을 확인한 뒤 조건부 후보로 비교하세요.'};
        return {...point,status:'clear',source:'imagery',reason:describeFinding(verified),action:'촬영 당시 관찰한 이동 통로를 확인했습니다.'};
    });
    for(const barrier of route.barriers??[]){
        const index=issues.findIndex(issue=>issue.sampleId===barrier.sampleId);
        if(index>=0&&issues[index].status==='blocked'&&issues[index].source==='imagery')continue;
        const item=evidence[route.id+':'+barrier.sampleId];
        const verification=item?.failure?'영상 확보·판독을 완료하지 못했습니다.':item?.finding?'현재 영상에서는 이 계단을 확인하지 못했습니다.':item?(exploration.state==='searching'?'영상 확인을 진행 중이며, 계단을 확인한 결과는 아직 없습니다.':'영상 판독을 마치지 못한 상태로 처리가 종료됐습니다.'):'이 지점의 영상 판독은 아직 시작하지 않았습니다.';
        const point:RouteIssue={id:route.id+':'+barrier.sampleId,sampleId:barrier.sampleId,coord:barrier.coord,along:barrier.along,status:'blocked',source:barrier.source??'provider',reason:barrier.source==='imagery'||barrier.source==='osm'?barrier.reason:barrier.reason+' '+verification,action:barrier.source==='imagery'?'같은 통로에서 영상으로 관찰한 장애 때문에 이 경로를 추천에서 제외했습니다.':barrier.source==='osm'?'보행망 지도의 계단·접근 제한 때문에 이 통로를 피하는 후보를 비교합니다. 영상으로 확인한 장애와는 구분합니다.':'길찾기의 계단 안내 때문에 안전상 추천에서 제외합니다. 사진에서 장애를 확인했다는 뜻은 아니며, 실제 영상 판독은 별도로 표시합니다.'};
        if(index<0)issues.push(point);else issues[index]=point;
    }
    for(const crossing of route.unresolvedCrossings??[])issues.push({id:route.id+':'+crossing.id,sampleId:crossing.id,coord:crossing.coord,along:crossing.along,status:'unknown',source:crossing.source??'provider',reason:crossing.source==='osm'?'OpenStreetMap에서 횡단 선형을 발견했지만 이 경로의 횡단 연결부를 확정하지 못했습니다.':`${crossing.count}개 횡단보도의 필요한 연결부 위치를 지도 안내만으로 모두 확정할 수 없습니다.`,action:'일부 평탄한 노면만으로 이 횡단 전체를 통과 처리하지 않습니다. 연결부를 확인하거나 이 교차로를 피하는 대안을 비교해야 합니다.'});
    for(const connection of route.unverifiedConnections??[])issues.push({id:route.id+':'+connection.id,sampleId:connection.id,coord:connection.coord,along:connection.along,status:'unknown',source:connection.kind==='origin'||connection.kind==='destination'?'geometry':'provider',reason:connection.reason,action:connection.kind==='origin'?'선택한 출발지에서 경로 시작점까지의 연결을 확인하거나 다른 후보를 비교하세요.':connection.kind==='destination'?'장소의 실제 출입구와 경로 끝의 연결을 확인하거나 다른 후보를 비교하세요.':'확인된 다른 경로나 시설 안내를 확인하세요. 이 지도 안내는 영상 판독 결과가 아닙니다.'});
    issues.sort((a,b)=>a.along-b.along);
    const firstBlocked=issues.find(issue=>issue.status==='blocked');
    if(blockedPassageIds.length||firstBlocked){
        const reason=firstBlocked?`${Math.round(firstBlocked.along)}m 지점 · ${firstBlocked.source==='provider'?'지도 경로 안내 (영상 판독 결과 아님)':firstBlocked.source==='osm'?'보행망 지도 정보 (영상 판독 결과 아님)':'거리영상 관찰'}: ${firstBlocked.reason}`:'다른 후보에서 확인한 장애 통로와 겹쳐 이 경로의 접근성 안내를 막았습니다.';
        return {kind:'detour',reason,action:exploration.state==='searching'?'이 통로를 피하는 다른 경로를 조회하고 있습니다.':exploration.reason,issues,exploration};
    }
    if(maxSlope!=null)return {kind:'hold',reason:`요청한 최대 경사율 ${maxSlope}%를 확인할 정밀 보행면 측정 자료가 없습니다.`,action:'수치 경사 제한을 충족한 경로로 추천할 수 없습니다.',issues,exploration};
    if(route.graphCoverage?.status==='unavailable')return {kind:'hold',reason:'이 경로의 지도 보행망을 확보하지 못해 횡단 연결 관계를 대조하지 못했습니다. 통행 장애가 확인된 것은 아닙니다.',action:'지도 보행망 연결을 복구해 다시 찾거나 다른 후보의 근거를 비교하세요.',issues,exploration};
    const unknowns=issues.filter(issue=>issue.status==='unknown');
    const required=unknowns.find(issue=>{
        const sample=route.samples.find(point=>point.id===issue.sampleId);
        return !sample||sample.critical||sample.target==='crossing-entry'||sample.target==='crossing-exit'||sample.target==='entrance'||sample.target==='arrival';
    });
    const observed=issues.some(issue=>issue.source==='imagery'&&(issue.status==='clear'||issue.status==='caution'));
    if(!route.samples.length||required||!observed){
        const unknown=required??unknowns.find(issue=>issue.source!=='coverage'||!!evidence[issue.id]?.failure);
        return {kind:'hold',reason:unknown?`${Math.round(unknown.along)}m 지점: ${unknown.reason}`:'아직 필요한 영상 관찰이 완료되지 않았습니다.',action:exploration.state==='searching'?'필요한 연결부를 확인하고, 끝내 확인되지 않는 연결은 피하는 후보를 비교합니다.':exploration.reason,issues,exploration};
    }
    if(unknowns.length){
        const first=unknowns[0];
        return {kind:'conditional',reason:`${Math.round(first.along)}m 지점${unknowns.length>1?` 외 ${unknowns.length-1}곳`:''}은 관찰하지 못했습니다. ${first.reason}`,action:'확인하지 못한 위치와 다른 후보를 비교한 뒤 조건부 안내를 선택하세요. 통행 가능을 보장하지 않습니다.',issues,exploration};
    }
    const caution=issues.find(issue=>issue.status==='caution');
    if(caution)return {kind:'conditional',reason:`${Math.round(caution.along)}m 지점: ${caution.reason}`,action:'표시된 지속적인 노면 부담과 대안을 비교하세요. 단독 통과를 보장하는 추천은 아닙니다.',issues,exploration};
    return {kind:'recommended',reason:'지정 표본과 필요한 연결부에서 통행 장애가 관찰되지 않았습니다.',action:'영상 기준 추천 경로로 안내합니다. 현재 현장과 표본 사이 구간의 안전 보장은 아닙니다.',issues,exploration};
}
export function recommendedRoute(routes:Route[],evidence:Record<string,Evidence>,assessments?:Record<string,{blockedPassageIds:string[]}>,maxSlope?:number|null):string|null{
    return rankRoutes(routes,evidence).find(route=>{
        if(assessments&&!assessments[route.id])return false;
        return evaluateRoute(route,evidence,assessments?.[route.id]?.blockedPassageIds??[],maxSlope).kind==='recommended';
    })?.id??null;
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
export function summary(route: Route, evidence: Record<string, Evidence>) {
    const items=route.samples.map(sample=>evidence[route.id+':'+sample.id]).map(item=>item?.stage==='reserved'?undefined:item);
    const statuses=items.map(item=>item?.status);
    const count=(status:string)=>statuses.filter(value=>value===status).length;
    return {total:items.length,checked:items.filter(Boolean).length,clear:count('clear'),blocked:count('blocked'),caution:count('caution'),unknown:statuses.filter(status=>!status||status==='unknown').length};
}
export function rankRoutes(routes: Route[], evidence: Record<string, Evidence>) {
    return [...routes].sort((a,b)=>{
        const x=summary(a,evidence),y=summary(b,evidence);
        return x.blocked-y.blocked||(x.unknown/Math.max(1,x.total)-y.unknown/Math.max(1,y.total))||x.caution-y.caution||a.distance-b.distance;
    });
}
export function validateFinding(value: unknown): Finding {
    const parsed = findingSchema.safeParse(value);
    if (!parsed.success) throw new Error('AI 응답 형식을 확인할 수 없습니다.');
    const f = parsed.data;
    const observation=f.observation;
    const observable=f.pathVisible&&f.routeMatch==='same-path'&&f.reviewReason!=='corridor-uncertain'&&observation?.uncertainty!=='corridor';
    const unresolved=f.visibility==='unobservable'||f.reviewReason==='framing'||observation?.uncertainty==='framing';
    const blocked=f.features?.stairs.state==='present'||observation?.connection==='stairs'||observation?.connection==='raised';
    const limited=f.visibility==='occluded'||f.reviewReason==='occlusion'||observation?.uncertainty==='occlusion'||observation?.surface==='uneven'||observation?.surface==='unpaved';
    const status:Finding['status']=!observable||unresolved?'unknown':blocked?'blocked':observation&&f.status==='blocked'?'unknown':f.status==='clear'&&limited?'caution':f.status;
    const reason=blocked&&observable&&!unresolved?(f.features?.stairs.state==='present'?f.features.stairs.reason:observation?.reason??f.reason):f.reason;
    const unobservable:FeatureObservation={state:'unobservable',reason:'지정한 이동 통로와 대응하지 않는 사진의 특징은 적용하지 않습니다.'};
    return {...f,...(f.reviewReason==='corridor-uncertain'?{routeMatch:'uncertain'}:{}),...(!observable&&f.features?{features:{stairs:unobservable,incline:unobservable}}:{}),status,reason:reason.slice(0,1000),evidence:f.evidence.slice(0,8),limitations:f.limitations.slice(0,8)};
}
