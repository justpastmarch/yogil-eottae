import {z} from 'zod';
import {meters,recommendedRoute,inspectionOrder,type Evidence,type JourneyResult,type Place,type Coord,type Route} from './domain.ts';
import {routes,reroute} from './providers.ts';
import {blockedPassageFor,routeTouchesPassage,routeIsDistinct,detourViaPlans,validateCandidate} from './detours.ts';
import {analyzeKhuImage,KhuError} from './khu.ts';
import {streetImage,ImageryServiceError} from './street-imagery.ts';
import {serverConfig,type ServerConfig} from './server-config.ts';
import {journeyResponse} from './requests.ts';

export const journeyPhase=z.enum(['running','ready','limited','failed','canceled']);
const coord=z.tuple([z.number(),z.number()]);
const place=z.object({id:z.string(),name:z.string(),address:z.string(),coord});
export const journeyStateSchema=z.object({
    version:z.literal(1),start:place,end:place,profile:z.string(),
    candidates:journeyResponse.shape.routes,evidence:journeyResponse.shape.evidence,
    exclusions:z.array(z.object({id:z.string(),routeId:z.string(),sampleId:z.string(),fromAlong:z.number(),toAlong:z.number(),coords:z.array(coord)})),
    pendingReplans:z.array(z.array(coord)),lookups:z.number().int().nonnegative(),analyses:z.number().int().nonnegative(),replans:z.number().int().nonnegative(),phase:journeyPhase,
});
export type JourneyState=z.infer<typeof journeyStateSchema>;
export type JourneyInput={start:Place;end:Place;profile:string};
type CaptureOperation={kind:'capture';route:Route;sample:Route['samples'][number]};
type ReplanOperation={kind:'replan';via:Coord[]};
export type JourneyOperation=CaptureOperation|ReplanOperation;
export type JourneyDependencies={streetImage:typeof streetImage;analyzeKhuImage:typeof analyzeKhuImage;reroute:typeof reroute};
const dependencies:JourneyDependencies={streetImage,analyzeKhuImage,reroute};

export async function createJourneyState(input:JourneyInput,config:ServerConfig,signal:AbortSignal):Promise<JourneyState>{
    const candidates=(await routes(input.start,input.end,config.routing,signal)).routes;
    return {...input,version:1,candidates,evidence:{},exclusions:[],pendingReplans:[],lookups:0,analyses:0,replans:0,phase:config.mapillary||config.rendererUrl?'running':'limited'};
}
export function projectJourneyResult(state:JourneyState):JourneyResult{
    const assessments=Object.fromEntries(state.candidates.map(route=>[route.id,{blockedPassageIds:state.exclusions.filter(p=>routeTouchesPassage(route,p)).map(p=>p.id)}]));
    const recommendedId=recommendedRoute(state.candidates,state.evidence,assessments);
    return {routes:state.candidates,evidence:state.evidence,assessments,recommendedId,status:recommendedId?'ready':'limited'};
}

export function reserveJourneyOperation(state:JourneyState):JourneyOperation|null{
    if(state.phase!=='running') return null;
    if(projectJourneyResult(state).recommendedId){state.phase='ready';return null;}
    if(state.pendingReplans.length&&state.replans<4&&state.candidates.length<6){
        const via=state.pendingReplans.shift();
        if(via){state.replans++;return {kind:'replan',via};}
    }
    state.pendingReplans=[];
    if(state.lookups>=60||state.analyses>=48){state.phase='limited';return null;}
    for(const route of state.candidates){
        if(state.exclusions.some(p=>routeTouchesPassage(route,p))) continue;
        const sample=inspectionOrder([route]).map(item=>item.sample).find(sample=>!state.evidence[route.id+':'+sample.id]);
        if(!sample) continue;
        state.lookups++;
        state.analyses++;
        state.evidence[route.id+':'+sample.id]={sampleId:sample.id,status:'unknown',reason:'이 구간의 이동 환경을 분석하고 있습니다.',checkedAt:new Date().toISOString()};
        return {kind:'capture',route,sample};
    }
    state.phase=projectJourneyResult(state).recommendedId?'ready':'limited';
    return null;
}

export async function advanceJourneyState(state:JourneyState,operation:JourneyOperation,config:ServerConfig,signal:AbortSignal,deps:JourneyDependencies=dependencies):Promise<void>{
    if(operation.kind==='replan'){
        if(config.routing.kind!=='kakao') return;
        const baseline=state.candidates.reduce<Route|undefined>((best,route)=>!best||route.distance<best.distance?route:best,undefined);
        if(!baseline) return;
        try{
            const alternative=await deps.reroute(state.start,state.end,config.routing,operation.via,signal);
            if(validateCandidate(alternative,baseline,state.exclusions).ok&&routeIsDistinct(alternative,state.candidates)){
                alternative.detourReason='영상에서 관찰된 통행 장애 구간을 피해 다시 찾은 경로';
                state.candidates.unshift(alternative);
            }
        }catch(error){
            signal.throwIfAborted();
            if(error instanceof Error&&'status' in error&&error.status===503) state.phase='limited';
        }
        return;
    }
    const {route,sample}=operation;
    const key=route.id+':'+sample.id;
    let finding:Evidence;
    try{
        const image=await deps.streetImage(sample,config,signal);
        if(!image){
            state.evidence[key]={sampleId:sample.id,status:'unknown',reason:'이 구간의 이동 환경 정보가 충분하지 않습니다.',checkedAt:new Date().toISOString()};
            return;
        }
        const step=route.steps.reduce<typeof route.steps[number]|undefined>((nearest,s)=>!nearest||meters(s.coord,sample.coord)<meters(nearest.coord,sample.coord)?s:nearest,undefined);
        const result=await deps.analyzeKhuImage({apiKey:config.ai,model:config.model,image:image.image,profile:state.profile,context:`진행 방향 ${Math.round(sample.heading)}도. 촬영 방향 ${Math.round(image.source.heading)}도. 촬영 위치 차이 ${Math.round(meters(sample.coord,image.source.coord))}m. 경로 좌표 ${JSON.stringify(sample.coord)}. 주변 안내: ${step?.text??'보행 이동'}. 지정한 진행 방향의 동일 보행 통로임이 사진에서 명확할 때만 same-path로 판정하라. 옆 건물 입구 계단과 현재 이동 통로를 혼동하지 마라.`,signal});
        finding={sampleId:sample.id,status:result.finding.status,reason:result.finding.reason,finding:result.finding,source:{url:image.source.url,capturedAt:image.source.capturedAt,...(image.source.capturedMonth?{capturedMonth:image.source.capturedMonth}:{}),coord:image.source.coord,distance:Math.round(meters(sample.coord,image.source.coord))},checkedAt:result.checkedAt};
        state.evidence[key]=finding;
    }catch(error){
        signal.throwIfAborted();
        if(error instanceof ImageryServiceError&&error.status===429){state.phase='limited';return;}
        if(error instanceof ImageryServiceError&&[401,403,404].includes(error.status)||error instanceof KhuError&&[401,402,403,404,429].includes(error.status)) throw error;
        state.evidence[key]={sampleId:sample.id,status:'unknown',reason:'이 구간의 이동 환경 정보를 가져오지 못했습니다.',checkedAt:new Date().toISOString()};
        return;
    }
    if(finding.status==='blocked'&&finding.finding?.routeMatch==='same-path'){
        const passage=blockedPassageFor(route,sample);
        state.exclusions.push(passage);
        if(config.routing.kind==='kakao') state.pendingReplans=detourViaPlans(route,passage);
    }
    if(projectJourneyResult(state).recommendedId) state.phase='ready';
}

export async function findJourney(start:Place,end:Place,profile:string,signal:AbortSignal):Promise<JourneyResult>{
    const config=serverConfig();
    const state=await createJourneyState({start,end,profile},config,signal);
    while(state.phase==='running'){
        const operation=reserveJourneyOperation(state);
        if(!operation) break;
        await advanceJourneyState(state,operation,config,signal);
    }
    return projectJourneyResult(state);
}
