import {meters,recommendedRoute,inspectionOrder,type Evidence,type JourneyResult,type Place,type Route,type BlockedPassage,type RouteAssessments} from './domain.ts';
import {routes,reroute} from './providers.ts';
import {blockedPassageFor,routeTouchesPassage,routeIsDistinct,detourViaPlans,validateCandidate} from './detours.ts';
import {analyzeKhuImage,KhuError} from './khu.ts';
import {streetImage,ImageryServiceError} from './street-imagery.ts';
import {serverConfig} from './server-config.ts';
const SOFT_DEADLINE_MS=70_000;
const MAX_CAPTURES=60;
const MAX_ANALYSES=48;
const MAX_REROUTES=4;
const MAX_ROUTES=6;
export async function findJourney(start:Place,end:Place,profile:string,signal:AbortSignal):Promise<JourneyResult>{
    const config=serverConfig();
    const soft=AbortSignal.timeout(SOFT_DEADLINE_MS);
    const work=AbortSignal.any([signal,soft]);
    const candidates=(await routes(start,end,config.routing,work)).routes;
    const evidence:Record<string,Evidence>={};
    const exclusions:BlockedPassage[]=[];
    let lookups=0,analyses=0,replans=0;
    const assessments=():RouteAssessments=>Object.fromEntries(candidates.map(route=>[route.id,{blockedPassageIds:exclusions.filter(p=>routeTouchesPassage(route,p)).map(p=>p.id)}]));
    const finish=():JourneyResult=>{
        signal.throwIfAborted();
        const assessed=assessments();
        const recommendedId=recommendedRoute(candidates,evidence,assessed);
        return {routes:candidates,evidence,assessments:assessed,recommendedId,status:recommendedId?'ready':'limited'};
    };
    if(!config.mapillary&&!config.rendererUrl) return finish();
    const baseline=candidates.reduce<Route|undefined>((best,route)=>!best||route.distance<best.distance?route:best,undefined);
    if(!baseline) return finish();
    for(let index=0;index<candidates.length;index++){
        const route=candidates[index];
        if(exclusions.some(p=>routeTouchesPassage(route,p))) continue;
        for(const {sample} of inspectionOrder([route])){
            signal.throwIfAborted();
            if(soft.aborted||lookups>=MAX_CAPTURES||analyses>=MAX_ANALYSES) return finish();
            lookups++;
            let finding:Evidence;
            try{
                const image=await streetImage(sample,config,work);
                if(!image){
                    evidence[route.id+':'+sample.id]={sampleId:sample.id,status:'unknown',reason:'이 구간의 이동 환경 정보가 충분하지 않습니다.',checkedAt:new Date().toISOString()};
                    continue;
                }
                analyses++;
                const step=route.steps.reduce<typeof route.steps[number]|undefined>((nearest,s)=>!nearest||meters(s.coord,sample.coord)<meters(nearest.coord,sample.coord)?s:nearest,undefined);
                const result=await analyzeKhuImage({apiKey:config.ai,model:config.model,image:image.image,profile,context:`진행 방향 ${Math.round(sample.heading)}도. 촬영 방향 ${Math.round(image.source.heading)}도. 촬영 위치 차이 ${Math.round(meters(sample.coord,image.source.coord))}m. 경로 좌표 ${JSON.stringify(sample.coord)}. 주변 안내: ${step?.text??'보행 이동'}. 지정한 진행 방향의 동일 보행 통로임이 사진에서 명확할 때만 same-path로 판정하라. 옆 건물 입구 계단과 현재 이동 통로를 혼동하지 마라.`,signal:work});
                finding={sampleId:sample.id,status:result.finding.status,reason:result.finding.reason,finding:result.finding,source:{url:image.source.url,capturedAt:image.source.capturedAt,...(image.source.capturedMonth?{capturedMonth:image.source.capturedMonth}:{}),coord:image.source.coord,distance:Math.round(meters(sample.coord,image.source.coord))},checkedAt:result.checkedAt};
                evidence[route.id+':'+sample.id]=finding;
            }catch(error){
                signal.throwIfAborted();
                if(soft.aborted) return finish();
                if(error instanceof ImageryServiceError&&error.status===429) return finish();
                if(error instanceof ImageryServiceError&&[401,403,404].includes(error.status)||error instanceof KhuError&&[401,402,403,404,429].includes(error.status)) throw error;
                evidence[route.id+':'+sample.id]={sampleId:sample.id,status:'unknown',reason:'이 구간의 이동 환경 정보를 가져오지 못했습니다.',checkedAt:new Date().toISOString()};
                continue;
            }
            if(finding.status!=='blocked'||finding.finding?.routeMatch!=='same-path') continue;
            const passage=blockedPassageFor(route,sample);
            exclusions.push(passage);
            if(config.routing.kind==='kakao'){
                for(const via of detourViaPlans(route,passage)){
                    if(replans>=MAX_REROUTES||candidates.length>=MAX_ROUTES||soft.aborted) break;
                    signal.throwIfAborted();
                    replans++;
                    try{
                        const alternative=await reroute(start,end,config.routing,via,work);
                        if(!validateCandidate(alternative,baseline,exclusions).ok||!routeIsDistinct(alternative,candidates)) continue;
                        alternative.detourReason='영상에서 관찰된 통행 장애 구간을 피해 다시 찾은 경로';
                        candidates.push(alternative);
                    }catch(error){
                        signal.throwIfAborted();
                        if(soft.aborted) return finish();
                        if(error instanceof Error&&'status' in error&&error.status===503) return finish();
                    }
                }
            }
            break;
        }
    }
    return finish();
}
