import {captureAdjacentViews,evidenceSource,panoramaIdentity} from './adjacent-views.ts';
import {routeImageContext} from './route-context.ts';
import {z} from 'zod';
import {projectOnRoute,meters,recommendedRoute,inspectionOrder,type Evidence,type JourneyResult,type Place,type Coord,type Route} from './domain.ts';
import {routes,reroute} from './providers.ts';
import {blockedPassageFor,routeTouchesPassage,routeIsDistinct,detourViaPlans,validateCandidate} from './detours.ts';
import {analyzeKhuImage,analyzeKhuViews,validateJointFinding,KhuError} from './khu.ts';
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
type ReviewOperation={kind:'review';route:Route;sample:Route['samples'][number];captureLimit:number};
type ReplanOperation={kind:'replan';via:Coord[]};
export type JourneyOperation=CaptureOperation|ReviewOperation|ReplanOperation;
export type JourneyDependencies={streetImage:typeof streetImage;analyzeKhuImage:typeof analyzeKhuImage;reroute:typeof reroute;analyzeKhuViews:typeof analyzeKhuViews};
const dependencies:JourneyDependencies={streetImage,analyzeKhuImage,reroute,analyzeKhuViews};

export function providerStairSamples(route:Route,profile:string):Route['samples'] {
    if(!['수동 휠체어','전동 휠체어','유아차','보행 보조기'].includes(profile))return [];
    return route.steps.filter(step=>step.text.replace(/\s+/g,'')==='계단이용').flatMap((step,index)=>{
        const projection=projectOnRoute(route.coords,step.coord);
        return projection&&projection.distance<=20?[{id:'provider-stairs-'+index,coord:projection.coord,along:projection.along,heading:projection.heading,critical:true}]:[];
    });
}
export async function createJourneyState(input:JourneyInput,config:ServerConfig,signal:AbortSignal):Promise<JourneyState>{
    const candidates=(await routes(input.start,input.end,config.routing,signal)).routes;
    const exclusions:JourneyState['exclusions']=[];
    for(const route of candidates){
        const stairs=providerStairSamples(route,input.profile);
        if(stairs.length)route.knownBarriers=['길찾기 안내에 계단 포함'];
        for(const sample of stairs)exclusions.push(blockedPassageFor(route,sample));
    }
    const firstPassage=exclusions[0],firstRoute=candidates.find(route=>route.id===firstPassage?.routeId);
    const pendingReplans=firstPassage&&firstRoute&&config.routing.kind==='kakao'?detourViaPlans(firstRoute,firstPassage):[];
    return {...input,version:1,candidates,evidence:{},exclusions,pendingReplans,lookups:0,analyses:0,replans:0,phase:config.mapillary||config.rendererUrl?'running':'limited'};
}
export function projectJourneyResult(state:JourneyState):JourneyResult{
    const assessments=Object.fromEntries(state.candidates.map(route=>[route.id,{blockedPassageIds:state.exclusions.filter(p=>routeTouchesPassage(route,p)).map(p=>p.id)}]));
    const recommendedId=recommendedRoute(state.candidates,state.evidence,assessments);
    return {routes:state.candidates,evidence:state.evidence,assessments,recommendedId,status:recommendedId?'ready':'limited'};
}

export function reserveJourneyOperation(state:JourneyState):JourneyOperation|null{
    if(state.phase!=='running') return null;
    if(projectJourneyResult(state).recommendedId){state.phase='ready';return null;}
    const pending=inspectionOrder(state.candidates).find(({route,sample})=>state.evidence[route.id+':'+sample.id]?.review?.state==='pending');
    if(pending&&state.lookups<60&&state.analyses<48){
        const captureLimit=Math.min(3,60-state.lookups);
        const item=state.evidence[pending.route.id+':'+pending.sample.id];
        if(item.review)item.review.state='reserved';
        state.lookups+=captureLimit;state.analyses++;
        return {kind:'review',...pending,captureLimit};
    }
    if(state.pendingReplans.length&&state.replans<4&&state.candidates.length<6){
        const via=state.pendingReplans.shift();
        if(via){state.replans++;return {kind:'replan',via};}
    }
    state.pendingReplans=[];
    if(state.lookups>=60||state.analyses>=48){state.phase='limited';return null;}
    const candidates=state.candidates.filter(route=>!state.exclusions.some(p=>routeTouchesPassage(route,p))&&!route.samples.some(sample=>{
        const evidence=state.evidence[route.id+':'+sample.id];
        return evidence?.status==='blocked'&&evidence.finding?.routeMatch==='same-path';
    })).map(route=>({route,attempted:route.samples.filter(sample=>state.evidence[route.id+':'+sample.id]).length,canComplete:!route.samples.some(sample=>{
        const evidence=state.evidence[route.id+':'+sample.id];
        return evidence&&evidence.stage!=='reserved'&&evidence.status!=='clear';
    })})).sort((a,b)=>Number(b.canComplete)-Number(a.canComplete)||(a.canComplete?0:a.attempted-b.attempted));
    for(const {route} of candidates){
        const sample=inspectionOrder([route]).map(item=>item.sample).find(sample=>!state.evidence[route.id+':'+sample.id]);
        if(!sample) continue;
        state.lookups++;
        state.analyses++;
        state.evidence[route.id+':'+sample.id]={sampleId:sample.id,stage:'reserved',status:'unknown',reason:'이 구간의 통행 상태를 아직 판정하지 못했습니다.',checkedAt:new Date().toISOString()};
        return {kind:'capture',route,sample};
    }
    state.phase=projectJourneyResult(state).recommendedId?'ready':'limited';
    return null;
}

export async function advanceJourneyState(state:JourneyState,operation:JourneyOperation,config:ServerConfig,signal:AbortSignal,deps:JourneyDependencies=dependencies):Promise<void>{
    if(operation.kind==='review'){
        const {route,sample,captureLimit}=operation,key=route.id+':'+sample.id,item=state.evidence[key],review=item?.review;
        if(!review)return;
        review.state='complete';
        try {
            const captured=await captureAdjacentViews({route,sample,limit:captureLimit,config,signal,capture:deps.streetImage});
            state.lookups-=captureLimit-captured.attempts;
            review.sources=captured.views.map(view=>({id:view.id,source:evidenceSource(view.image,sample)}));
            if(!captured.views.length){state.analyses--;review.note='전후 거리영상을 확보하지 못해 기존 판정을 유지했습니다.';return;}
            const result=await deps.analyzeKhuViews({apiKey:config.ai,model:config.model,views:captured.views.map(view=>({id:view.id,image:view.image.image})),profile:state.profile,context:'원래 판정: '+JSON.stringify(review.initialFinding)+'\n원래 목표 좌표: '+JSON.stringify(sample.coord)+'\n'+captured.context,signal:AbortSignal.any([signal,AbortSignal.timeout(35000)])});
            const initialIdentity=panoramaIdentity(review.initialSource);
            const independentSupportIds=captured.views.filter(view=>panoramaIdentity(view.image.source)!==initialIdentity&&meters(review.initialSource.coord,view.image.source.coord)>=1).map(view=>view.id);
            const joint=validateJointFinding(result.review,captured.views.map(view=>view.id),independentSupportIds);
            review.result=joint.finding;review.supportIds=joint.supportIds;
            review.note=independentSupportIds.length>0?'서로 다른 촬영 위치의 전후 영상을 대조했습니다.':'서로 다른 촬영 위치가 충분하지 않아 원래 가려진 연결부를 확정하지 않았습니다.';
            if(!(item.status==='blocked'&&item.finding?.routeMatch==='same-path')){
                item.finding=joint.finding;item.status=joint.finding.status;item.reason=joint.finding.reason;item.checkedAt=result.checkedAt;
            }
            if(item.status==='blocked'&&item.finding?.routeMatch==='same-path'){
                const passage=blockedPassageFor(route,sample);
                if(!state.exclusions.some(existing=>existing.id===passage.id))state.exclusions.push(passage);
                if(config.routing.kind==='kakao')state.pendingReplans=detourViaPlans(route,passage);
            }
        } catch(error){review.note='전후 영상 대조를 완료하지 못해 기존 판정을 유지했습니다.';signal.throwIfAborted();if(error instanceof KhuError&&[401,402,403,404,429].includes(error.status))throw error;}
        return;
    }
    if(operation.kind==='replan'){
        if(config.routing.kind!=='kakao') return;
        const baseline=state.candidates.reduce<Route|undefined>((best,route)=>!best||route.distance<best.distance?route:best,undefined);
        if(!baseline) return;
        try{
            const alternative=await deps.reroute(state.start,state.end,config.routing,operation.via,signal);
            if(providerStairSamples(alternative,state.profile).length)return;
            if(validateCandidate(alternative,baseline,state.exclusions).ok&&routeIsDistinct(alternative,state.candidates)){
                alternative.detourReason='통행 장애 구간을 피해 다시 찾은 경로';
                state.candidates.unshift(alternative);
            }
        }catch(error){
            signal.throwIfAborted();
        }
        return;
    }
    const {route,sample}=operation;
    const key=route.id+':'+sample.id;
    let finding:Evidence;
    try{
        const image=await deps.streetImage(sample,config,signal);
        if(!image){
            state.evidence[key]={sampleId:sample.id,stage:'processed',status:'unknown',reason:'이 구간의 이동 환경 정보가 충분하지 않습니다.',checkedAt:new Date().toISOString()};
            return;
        }
        const result=await deps.analyzeKhuImage({apiKey:config.ai,model:config.model,image:image.image,profile:state.profile,context:routeImageContext({route,sample,source:image.source}),signal});
        finding={sampleId:sample.id,stage:'processed',status:result.finding.status,reason:result.finding.reason,finding:result.finding,source:evidenceSource(image,sample),checkedAt:result.checkedAt};
        const reason=result.finding.reviewReason==='occlusion'||result.finding.visibility==='occluded'?'occlusion':'corridor-uncertain';
        if(result.finding.status==='unknown'||result.finding.status==='caution'||result.finding.reviewReason==='corridor-uncertain'||result.finding.reviewReason==='occlusion'||result.finding.visibility==='occluded')finding.review={state:'pending',reason,initialFinding:result.finding,initialSource:evidenceSource(image,sample),sources:[],supportIds:[],note:'전후 거리영상에서 같은 연결부를 다시 살펴볼 예정입니다.'};
        state.evidence[key]=finding;
    }catch(error){
        state.evidence[key]={sampleId:sample.id,stage:'processed',status:'unknown',reason:'이 구간의 이동 환경 정보를 가져오지 못했습니다.',checkedAt:new Date().toISOString()};
        signal.throwIfAborted();
        if(error instanceof ImageryServiceError&&error.status===429){state.phase='limited';return;}
        if(error instanceof ImageryServiceError&&[401,403,404].includes(error.status)||error instanceof KhuError&&[401,402,403,404,429].includes(error.status)) throw error;
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
