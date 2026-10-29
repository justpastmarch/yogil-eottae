import {mappedUnderpassEntry,underpassApproachSamples,underpassCameraMatches} from './underpass-acquisition.ts';
import {captureAdjacentViews,evidenceSource,hasIndependentPanorama,pointsAwayFromTarget} from './adjacent-views.ts';
import {pointAt,routeImageContext} from './route-context.ts';
import {z} from 'zod';
import {projectOnRoute,validateFinding,evaluateRoute,assessRouteAdmission,recommendedRoute,inspectionOrder,journeyGoal,type RouteExploration,type JourneyGoal,type Evidence,type JourneyResult,type Place,type Coord,type Route} from './domain.ts';
import {routes,reroute} from './providers.ts';
import {blockedPassageFor,routeTouchesPassage,routeIsDistinct,detourViaPlans,validateCandidate} from './detours.ts';
import {analyzeKhuImage,analyzeKhuViews,validateJointFinding,KhuError,khuFailureReason} from './khu.ts';
import {streetImage,ImageryServiceError} from './street-imagery.ts';
import type {ServerConfig} from './server-config.ts';
import {journeyResponse} from './requests.ts';
import {loadRouteGrades} from './route-grade.ts';
import {discoverCrossingAlternatives,selectedCrossingMatches} from './crossing-alternatives.ts';
import {discoverRouteCrossings,matchGroupedCrossings,type CrossingMatch} from './osm-crossings.ts';
import {loadPedestrianGraph,type GraphLoadResult} from './osm-data.ts';
import type {CaptureObserver} from './capture-contract.ts';
import {graphBarriersForRoute} from './graph-barriers.ts';

export const journeyPhase=z.enum(['running','ready','limited','failed','canceled']);
export const JOURNEY_VERSION=9;
const coord=z.tuple([z.number(),z.number()]);
const place=z.object({id:z.string(),name:z.string(),address:z.string(),coord});
export const journeyStateSchema=z.object({
    version:z.literal(JOURNEY_VERSION),provider:z.enum(['kakao','tmap']),imageryProvider:z.enum(['configured','kartaview','google']).optional(),goal:journeyGoal,notice:z.string().optional(),start:place,end:place,profile:z.string(),maxSlope:z.number().nullable().optional(),
    candidates:journeyResponse.shape.routes,evidence:journeyResponse.shape.evidence,
    exclusions:z.array(z.object({id:z.string(),routeId:z.string(),sampleId:z.string(),fromAlong:z.number(),toAlong:z.number(),coords:z.array(coord),reason:z.enum(['obstacle','unverified']).optional(),detail:z.string().optional()})),
    pendingReplans:z.array(z.array(coord)),lookups:z.number().int().nonnegative(),analyses:z.number().int().nonnegative(),replans:z.number().int().nonnegative(),phase:journeyPhase,
});
export type JourneyState=z.infer<typeof journeyStateSchema>;
export type JourneyInput={start:Place;end:Place;profile:string;goal:JourneyGoal;maxSlope?:number|null;imageryProvider?:'configured'|'kartaview'|'google'};
type CaptureOperation={kind:'capture';route:Route;sample:Route['samples'][number]};
type ReviewOperation={kind:'review';route:Route;sample:Route['samples'][number];captureLimit:number};
type ReplanOperation={kind:'replan';via:Coord[]};
export type JourneyOperation=CaptureOperation|ReviewOperation|ReplanOperation;
export type JourneyDependencies={streetImage:typeof streetImage;analyzeKhuImage:typeof analyzeKhuImage;reroute:typeof reroute;analyzeKhuViews:typeof analyzeKhuViews;loadPedestrianGraph?:typeof loadPedestrianGraph};
const dependencies:JourneyDependencies={streetImage,analyzeKhuImage,reroute,analyzeKhuViews,loadPedestrianGraph};

export function providerStairSamples(route:Route,profile:string):Route['samples'] {
    if(!['수동 휠체어','전동 휠체어','유아차','보행 보조기'].includes(profile))return [];
    return route.steps.filter(step=>step.text.replace(/\s+/g,'')==='계단이용').flatMap((step,index)=>{
        const projection=projectOnRoute(route.coords,step.coord);
        return projection&&projection.distance<=20?[{id:'provider-stairs-'+index,coord:projection.coord,along:projection.along,heading:projection.heading,critical:true}]:[];
    });
}
function prepareRoute(route:Route,profile:string,goal:JourneyGoal,graphResult:GraphLoadResult,selectedMatches:CrossingMatch[]|null=null):Route{
    const graph=graphResult.kind==='available'?graphResult.graph:undefined;
    route.graphCoverage=graph?{status:'available',snapshotAt:graph.snapshotAt}:{status:'unavailable',reason:graphResult.kind==='unavailable'?graphResult.reason:'no-data'};
    const samples:Route['samples']=route.samples.map(sample=>({...sample,target:'sidewalk'}));
    const addTarget=(along:number,target:'crossing-entry'|'crossing-exit',coordinate?:Coord,heading?:number)=>{
        const position=coordinate??pointAt(route.coords,along);
        if(!position)return;
        const projection=projectOnRoute(route.coords,position);
        if(!projection)return;
        const existing=samples.find(sample=>(sample.target==='sidewalk'||sample.target===target)&&Math.abs(sample.along-along)<1);
        if(existing){Object.assign(existing,{coord:position,along,heading:heading??projection.heading,critical:true,target});return;}
        route.samples.push({id:target+'-'+route.samples.length,coord:position,along,heading:heading??projection.heading,critical:true,target});
    };
    route.samples=samples;
    route.unresolvedCrossings=[];
    route.crossingSources=[];
    route.unverifiedConnections=[];
    for(const [index,step] of route.steps.entries()){
        const text=step.text.replace(/\s+/g,'');
        const kind=/지하보도|지하통로/.test(text)?'underpass':/엘리베이터|엘레베이터|승강기|휠체어리프트/.test(text)?'elevator':/역사내/.test(text)?'station':undefined;
        if(!kind)continue;
        const projection=projectOnRoute(route.coords,step.coord);
        if(!projection)continue;
        const reason=kind==='underpass'?'길찾기에 지하보도 이용 안내가 있습니다. 지상 보도 영상만으로 지하 연결과 계단·승강기 이용을 확인할 수 없습니다.':kind==='elevator'?'길찾기에 엘리베이터 이용 안내가 있습니다. 출입구 연결과 현재 운행 상태는 확인되지 않았습니다.':'길찾기에 역사 내 이동 안내가 있습니다. 승강장부터 출구까지의 휠체어 동선은 확인되지 않았습니다.';
        route.unverifiedConnections.push({id:'connection-step-'+index,kind,coord:step.coord,along:projection.along,reason});
        const connection=route.unverifiedConnections.at(-1);
        const entry=graph&&connection?mappedUnderpassEntry(route,connection,graph):null;
        if(entry)route.samples.push(entry);
    }
    for(let index=0;index<route.steps.length;index++){
        const step=route.steps[index];if(!/횡단/.test(step.text))continue;
        const entry=projectOnRoute(route.coords,step.coord),next=route.steps[index+1];
        if(!entry)continue;
        const count=Number(step.text.match(/(\d+)\s*개(?:의)?\s*횡단보도/)?.[1]??1);
        const exit=next?projectOnRoute(route.coords,next.coord):null;
        const located=entry.distance<=20&&exit&&exit.distance<=20&&exit.along>entry.along+2&&exit.along-entry.along<=100;
        const matched=located&&exit&&graph?matchGroupedCrossings(route,entry.along,exit.along,count,graph):null;
        if(matched){
            for(const target of matched.targets)addTarget(target.along,target.target,target.coord,target.heading);
            route.crossingSources.push({provider:'openstreetmap',snapshotAt:matched.snapshotAt,wayIds:matched.wayIds,along:entry.along});
        }else{
            if(entry.distance<=20)addTarget(entry.along,'crossing-entry');
            route.unresolvedCrossings.push({id:'unresolved-crossing-'+index,coord:entry.coord,along:entry.along,count});
        }
    }
    if(graph){
        const discovered=discoverRouteCrossings(route,graph);
        const knownWays=new Set(route.crossingSources.flatMap(source=>source.wayIds));
        for(const match of discovered.matches){
            const entry=match.targets[0];
            if(!entry||match.wayIds.some(id=>knownWays.has(id)))continue;
            const nearby:NonNullable<Route['unresolvedCrossings']>=route.unresolvedCrossings.filter(crossing=>Math.abs(crossing.along-entry.along)<8);
            if(nearby.some(crossing=>crossing.source==='osm'||crossing.count!==1)||nearby.length>1)continue;
            if(nearby.length===1){
                const fallback=samples.find(sample=>sample.target==='crossing-entry'&&Math.abs(sample.along-nearby[0].along)<1);
                if(fallback)Object.assign(fallback,{coord:entry.coord,along:entry.along,heading:entry.heading});
                route.unresolvedCrossings=route.unresolvedCrossings.filter(crossing=>crossing!==nearby[0]);
            }
            for(const target of match.targets)addTarget(target.along,target.target,target.coord,target.heading);
            route.crossingSources.push({provider:'openstreetmap',snapshotAt:match.snapshotAt,wayIds:match.wayIds,along:entry.along});
            for(const id of match.wayIds)knownWays.add(id);
        }
        for(const crossing of discovered.unresolved){
            if(knownWays.has(crossing.wayId)||route.unresolvedCrossings.some(existing=>Math.abs(existing.along-crossing.along)<8))continue;
            route.unresolvedCrossings.push({id:'unresolved-osm-crossing-'+crossing.wayId,coord:crossing.coord,along:crossing.along,count:1,source:'osm'});
        }
    }
    for(const match of selectedMatches??[]){
        const entry=match.targets[0];
        if(!entry)continue;
        const resolvedProvider:NonNullable<Route['unresolvedCrossings']>=route.unresolvedCrossings.filter(crossing=>crossing.source!=='osm'&&crossing.count===1&&Math.abs(crossing.along-entry.along)<=8);
        for(const target of match.targets){
            const fallback=target.target==='crossing-entry'&&resolvedProvider.length===1?route.samples.find(sample=>sample.target==='crossing-entry'&&Math.abs(sample.along-resolvedProvider[0].along)<1):undefined;
            if(fallback)Object.assign(fallback,{coord:target.coord,along:target.along,heading:target.heading});
            else addTarget(target.along,target.target,target.coord,target.heading);
        }
        route.unresolvedCrossings=route.unresolvedCrossings.filter(crossing=>!(crossing.source==='osm'&&match.wayIds.some(id=>crossing.id==='unresolved-osm-crossing-'+id))&&!(resolvedProvider.length===1&&crossing===resolvedProvider[0]));
        if(!route.crossingSources.some(source=>source.wayIds.some(id=>match.wayIds.includes(id))))route.crossingSources.push({provider:'openstreetmap',snapshotAt:match.snapshotAt,wayIds:match.wayIds,along:entry.along});
    }
    const last=route.samples.reduce<Route['samples'][number]|undefined>((best,sample)=>!best||sample.along>best.along?sample:best,undefined);
    if(last){
        if(last.target==='sidewalk'){last.critical=true;last.target=goal;}
        else route.samples.push({...last,id:goal+'-'+route.samples.length,critical:true,target:goal});
    }
    route.barriers=providerStairSamples(route,profile).map(sample=>({sampleId:sample.id,coord:sample.coord,along:sample.along,reason:'도보 길찾기가 이 지점에서 “계단이용”으로 안내합니다.'}));
    if(graph)route.barriers.push(...graphBarriersForRoute(route,graph));
    for(const barrier of route.barriers){
        if(!route.samples.some(sample=>sample.id===barrier.sampleId))route.samples.push({id:barrier.sampleId,coord:barrier.coord,along:barrier.along,heading:projectOnRoute(route.coords,barrier.coord)?.heading??0,critical:true,target:'sidewalk'});
    }
    route.samples.sort((a,b)=>a.along-b.along);
    return route;
}
const imageryOutageNotice='거리영상 서비스 연결이 끊겨 추가 분석을 중단했습니다. 확보한 결과는 유지했습니다.';
const missingGoogleKeyNotice='Google 거리영상을 사용하려면 서버에 GOOGLE_STREET_VIEW_API_KEY를 설정해 주세요.';
const googleErrorNotice='Google 거리영상 API 요청에 실패해 분석을 중단했습니다. 서버 키와 API 설정을 확인해 주세요.';
export async function createJourneyState(input:JourneyInput,config:ServerConfig,signal:AbortSignal,loadGraph:typeof loadPedestrianGraph=loadPedestrianGraph):Promise<JourneyState>{
    const providerRoutes=(await routes(input.start,input.end,config.routing,signal)).routes;
    const graphs=await Promise.all(providerRoutes.map(route=>loadGraph(route,signal,config.osmEndpoint)));
    signal.throwIfAborted();
    const candidates=providerRoutes.map((route,index)=>prepareRoute(route,input.profile,input.goal,graphs[index]));
    const graph=graphs.find(result=>result.kind==='available');
    if(graph?.kind==='available'&&config.routing.kind==='kakao'){
        const proposals=discoverCrossingAlternatives(input.start,input.end,candidates,graph.graph);
        for(const proposal of proposals){
            if(candidates.length-providerRoutes.length>=2)break;
            try{
                const candidate=await reroute(input.start,input.end,config.routing,proposal.via,signal);
                if(providerStairSamples(candidate,input.profile).length||!validateCandidate(candidate,providerRoutes[0],[]).ok||!routeIsDistinct(candidate,candidates))continue;
                const matched=selectedCrossingMatches(candidate,proposal,graph.graph);
                if(!matched)continue;
                const result=await loadGraph(candidate,signal,config.osmEndpoint);
                const alternative=prepareRoute(candidate,input.profile,input.goal,result,matched);
                if(alternative.barriers?.length)continue;
                const namedCrossings=candidate.steps.flatMap(step=>{
                    const name=step.text.match(/^(.+?)에서\s*(?:\d+\s*개(?:의)?\s*)?횡단보도/)?.[1].trim();
                    const projection=name?projectOnRoute(candidate.coords,step.coord):null;
                    if(!name||!projection||projection.distance>20)return [];
                    const distance=Math.min(...matched.flatMap(match=>match.targets.filter(target=>target.target==='crossing-entry').map(target=>Math.abs(target.along-projection.along))));
                    return distance<=8?[{name,distance}]:[];
                }).sort((a,b)=>a.distance-b.distance);
                const label=namedCrossings.length?namedCrossings[0].name+' 경유':'다른 횡단보도 '+(candidates.length-providerRoutes.length+1);
                alternative.name=label;
                alternative.crossingChoice={id:proposal.id,label,wayIds:proposal.crossingWayIds};
                candidates.push(alternative);
            }catch{signal.throwIfAborted();}
        }
    }
    const grades=await loadRouteGrades(candidates,signal);
    for(const route of candidates)route.grade=grades[route.id];
    const imageryProvider=input.imageryProvider??config.imageryProvider??'configured';
    const available=imageryProvider==='google'?!!config.googleStreetViewKey:imageryProvider==='kartaview'||!!(config.mapillary||config.rendererUrl);
    const state:JourneyState={...input,imageryProvider,version:JOURNEY_VERSION,provider:config.routing.kind,candidates,evidence:{},exclusions:[],pendingReplans:[],lookups:0,analyses:0,replans:0,phase:available?'running':'limited',...(imageryProvider==='google'&&!config.googleStreetViewKey?{notice:missingGoogleKeyNotice}:{})};
    for(const route of candidates)for(const barrier of route.barriers??[]){
        const sample={id:barrier.sampleId,coord:barrier.coord,along:barrier.along,heading:projectOnRoute(route.coords,barrier.coord)?.heading??0,critical:true};
        addExclusion(state,route,sample,'obstacle',barrier.reason);
    }
    return state;
}
export function projectJourneyResult(state:JourneyState):JourneyResult{
    const alternatives=state.candidates.filter(route=>route.detourReason).length;
    const interrupted=state.phase==='canceled'||state.phase==='failed'||state.phase==='limited'&&(state.notice===missingGoogleKeyNotice||Object.values(state.evidence).some(item=>item.failure&&item.failure!=='missing'||item.review?.failure));
    const exploration:RouteExploration={
        state:state.phase==='running'?'searching':interrupted?'interrupted':'finished',
        attempts:state.replans,alternatives,
        reason:state.phase==='running'?'필요한 지점의 거리영상을 확인하고 있습니다.':state.phase==='canceled'?'거리영상 확인을 중지했습니다. 확보한 사진과 관찰 결과는 볼 수 있습니다.':interrupted?'거리영상 확인을 마치지 못했습니다. 확보한 사진과 관찰 결과를 확인하세요.':state.phase==='ready'?'필요한 지점의 거리영상 확인을 마쳤습니다.':'확인하지 못한 지점은 통행 가능 여부를 판단하지 않았습니다.',
    };
    const assessments=Object.fromEntries(state.candidates.map(route=>{
        const overlaps=state.exclusions.filter(p=>p.reason!=='unverified'&&routeTouchesPassage(route,p));
        const blockedPassageIds=overlaps.map(p=>p.id);
        const displayedOrigins=new Set((route.barriers??[]).map(point=>JSON.stringify(point.coord)));
        const inherited=overlaps.flatMap(passage=>{
            if(passage.routeId===route.id)return [];
            const originalRoute=state.candidates.find(candidate=>candidate.id===passage.routeId);
            const originalPoint=originalRoute?.samples.find(point=>point.id===passage.sampleId)?.coord??originalRoute?.barriers?.find(point=>point.sampleId===passage.sampleId)?.coord;
            const originKey=JSON.stringify(originalPoint??passage.coords);
            if(displayedOrigins.has(originKey))return [];
            displayedOrigins.add(originKey);
            const anchor=originalPoint??passage.coords[Math.floor(passage.coords.length/2)],projection=anchor?projectOnRoute(route.coords,anchor):null;
            if(!projection)return [];
            const originalBarrier=originalRoute?.barriers?.find(point=>point.sampleId===passage.sampleId);
            return [{sampleId:'shared-'+passage.id,coord:projection.coord,along:projection.along,reason:'공유하는 통로 · '+(passage.detail??'다른 후보에서 확인한 차단 요소가 있습니다.'),source:originalBarrier?(originalBarrier.source??'provider'):'imagery'} satisfies NonNullable<Route['barriers']>[number]];
        });
        const assessed=inherited.length?{...route,barriers:[...(route.barriers??[]),...inherited]}:route;
        const decision=evaluateRoute(assessed,state.evidence,blockedPassageIds,state.maxSlope,exploration);
        return [route.id,{blockedPassageIds,decision,admission:assessRouteAdmission({route:assessed,decision,blockedPassageIds,maxSlope:state.maxSlope})}];
    }));
    const recommendedId=recommendedRoute(state.candidates,state.evidence,assessments,state.maxSlope);
    return {goal:state.goal,routes:state.candidates,evidence:state.evidence,assessments,recommendedId,status:recommendedId?'ready':'limited',maxSlope:state.maxSlope};
}
function addExclusion(state:JourneyState,route:Route,sample:Route['samples'][number],reason:'obstacle'|'unverified',detail:string){
    const passage={...blockedPassageFor(route,sample),reason,detail};
    const existing=state.exclusions.find(item=>item.id===passage.id);
    if(existing){
        if(reason!=='obstacle'||existing.reason!=='unverified')return;
        Object.assign(existing,passage);
    }else state.exclusions.push(passage);
    if(reason==='obstacle'&&state.provider==='kakao'){
        const seen=new Set(state.pendingReplans.map(via=>JSON.stringify(via)));
        for(const via of detourViaPlans(route,passage))if(!seen.has(JSON.stringify(via)))state.pendingReplans.push(via);
    }
}
export function reserveJourneyOperation(state:JourneyState):JourneyOperation|null{
    if(state.phase!=='running')return null;
    if(projectJourneyResult(state).recommendedId){state.phase='ready';return null;}
    const pending=inspectionOrder(state.candidates).find(({route,sample})=>state.evidence[route.id+':'+sample.id]?.review?.state==='pending');
    if(pending){
        const captureLimit=3,item=state.evidence[pending.route.id+':'+pending.sample.id];
        if(item.review)item.review.state='reserved';
        state.lookups+=captureLimit;state.analyses++;
        return {kind:'review',...pending,captureLimit};
    }
    for(const route of state.candidates){
        const barrier=route.barriers?.find(point=>!state.evidence[route.id+':'+point.sampleId]);
        if(!barrier)continue;
        const sample=route.samples.find(point=>point.id===barrier.sampleId)??{id:barrier.sampleId,coord:barrier.coord,along:barrier.along,heading:projectOnRoute(route.coords,barrier.coord)?.heading??0,critical:true};
        state.lookups++;state.analyses++;
        state.evidence[route.id+':'+sample.id]={sampleId:sample.id,stage:'reserved',status:'unknown',reason:'지도에서 안내한 계단 지점의 실제 영상을 확보하고 있습니다.',checkedAt:new Date().toISOString()};
        return {kind:'capture',route,sample};
    }
    for(const route of state.candidates){
        for(const connection of route.unverifiedConnections??[]){
            if(connection.kind==='station'&&(connection.along<35||connection.along>route.distance-35))continue;
            addExclusion(state,route,{id:connection.id,coord:connection.coord,along:connection.along,heading:projectOnRoute(route.coords,connection.coord)?.heading??0,critical:true},'unverified',connection.reason);
        }
        const critical=route.samples.filter(sample=>sample.critical);
        if(!critical.length||!critical.every(sample=>{const item=state.evidence[route.id+':'+sample.id];return item?.stage==='processed'&&(!item.review||item.review.state==='complete');}))continue;
        for(const crossing of route.unresolvedCrossings??[])addExclusion(state,route,{id:crossing.id,coord:crossing.coord,along:crossing.along,heading:projectOnRoute(route.coords,crossing.coord)?.heading??0,critical:true},'unverified','지도 안내만으로 모든 횡단 연결부 위치를 확인하지 못했습니다.');
    }
    if(state.pendingReplans.length&&state.replans<4&&state.candidates.filter(route=>!route.graphSegment).length<6){
        const via=state.pendingReplans.shift();if(via){state.replans++;return {kind:'replan',via};}
    }
    const candidates=state.candidates.filter(route=>!state.exclusions.some(p=>p.reason!=='unverified'&&routeTouchesPassage(route,p))).map(route=>{
        const issues=evaluateRoute(route,state.evidence).issues;
        return {route,attempted:route.samples.filter(sample=>state.evidence[route.id+':'+sample.id]).length,canComplete:!route.samples.some(sample=>{
            const item=state.evidence[route.id+':'+sample.id];
            return item&&item.stage!=='reserved'&&issues.find(issue=>issue.sampleId===sample.id)?.status!=='clear';
        })};
    }).sort((a,b)=>Number(b.canComplete)-Number(a.canComplete)||(a.canComplete?0:a.attempted-b.attempted));
    for(const {route} of candidates){
        const sample=inspectionOrder([route]).map(item=>item.sample).find(sample=>!state.evidence[route.id+':'+sample.id]);
        if(!sample)continue;
        state.lookups++;state.analyses++;
        state.evidence[route.id+':'+sample.id]={sampleId:sample.id,stage:'reserved',status:'unknown',reason:'이 구간을 분석하고 있습니다.',checkedAt:new Date().toISOString()};
        return {kind:'capture',route,sample};
    }
    if(Object.values(state.evidence).some(item=>item.stage==='reserved'||item.review?.state==='reserved'))return null;
    state.phase='limited';
    state.notice='거리영상 확인을 마쳤습니다. 확인하지 못한 연결부는 시설 안내나 현장에서 확인하세요.';
    return null;
}
export async function advanceJourneyState(state:JourneyState,operation:JourneyOperation,config:ServerConfig,signal:AbortSignal,deps:JourneyDependencies=dependencies,onCapture?:CaptureObserver):Promise<void>{
    if(state.imageryProvider)config={...config,imageryProvider:state.imageryProvider};
    if(config.imageryProvider==='google'&&!config.googleStreetViewKey){state.phase='limited';state.notice=missingGoogleKeyNotice;return;}
    if(operation.kind==='replan'){
        if(config.routing.kind!=='kakao')return;
        const baseline=state.candidates.filter(route=>!route.graphSegment).reduce<Route|undefined>((best,route)=>!best||route.distance<best.distance?route:best,undefined);
        if(!baseline)return;
        try {
            const candidate=await deps.reroute(state.start,state.end,config.routing,operation.via,signal);
            if(providerStairSamples(candidate,state.profile).length||!validateCandidate(candidate,baseline,state.exclusions).ok||!routeIsDistinct(candidate,state.candidates.filter(route=>!route.graphSegment)))return;
            const graph=await (deps.loadPedestrianGraph??loadPedestrianGraph)(candidate,signal,config.osmEndpoint);
            signal.throwIfAborted();
            const alternative=prepareRoute(candidate,state.profile,state.goal,graph);
            if(alternative.barriers?.length)return;
            alternative.grade=(await loadRouteGrades([alternative],signal))[alternative.id];
            alternative.name='우회 후보';alternative.detourReason='장애 또는 미확인 연결부를 피하도록 조회한 후보입니다. 영상 확인은 아직 필요합니다.';
            state.candidates.unshift(alternative);
        } catch {signal.throwIfAborted();}
        return;
    }
    const {route,sample}=operation,key=route.id+':'+sample.id;
    if(operation.kind==='review'){
        const item=state.evidence[key],review=item?.review;if(!review)return;
        review.state='complete';
        let reviewStage:'capture'|'analysis'='capture';
        try {
            const captured=await captureAdjacentViews({route,sample,initialSource:review.initialSource,limit:operation.captureLimit,config,signal,reason:review.reason,capture:deps.streetImage,onView:onCapture?view=>onCapture({evidenceId:key,viewId:'review-'+view.id,image:view.image,target:sample}):undefined});
            state.lookups-=operation.captureLimit-captured.attempts;
            review.sources=captured.views.map(view=>({id:view.id,source:evidenceSource(view.image,sample)}));
            if(!captured.views.length){state.analyses--;review.note='다른 시선의 영상을 확보하지 못했습니다.';}
            else {
                reviewStage='analysis';
                const result=await deps.analyzeKhuViews({apiKey:config.ai,model:config.model,views:captured.views.map(view=>({id:view.id,image:view.image.image})),profile:state.profile,context:'재검토 원인: '+review.reason+'\n원래 관찰: '+JSON.stringify(review.initialFinding)+'\n'+captured.context,signal:AbortSignal.any([signal,AbortSignal.timeout(35000)])});
                const independent=captured.views.filter(view=>hasIndependentPanorama(review.initialSource,view.image.source)).map(view=>view.id);
                const joint=validateJointFinding(result.review,captured.views.map(view=>view.id),independent,review.reason);
                const crossing=sample.target==='crossing-entry'||sample.target==='crossing-exit'||sample.target==='underpass-entry';
                const misplacedSupport=crossing&&joint.supportIds.some(id=>{const view=captured.views.find(item=>item.id===id);return view&&pointsAwayFromTarget(view.image.source,sample);});
                if(misplacedSupport&&joint.finding.status!=='unknown'){
                    joint.finding={...joint.finding,status:'unknown',visibility:'unobservable',routeMatch:'uncertain',pathVisible:false,reviewReason:'framing',reason:'근거 사진의 촬영 방향이 목표 횡단 연결부를 향하지 않아 해당 지점의 판정에 사용할 수 없습니다.',observation:{...joint.finding.observation,connection:'unobservable',surface:'unobservable',uncertainty:'framing'}};
                }
                review.result=joint.finding;review.supportIds=misplacedSupport?[]:joint.supportIds;
                review.note=misplacedSupport?'판독이 근거로 선택한 사진은 목표 지점 반대 방향을 보여줘 결과에서 제외했습니다.':review.reason==='framing'?'카메라 시선을 돌려 원래 목표 연결부를 대조했습니다.':independent.length?'서로 다른 촬영 위치에서 원래 연결부를 대조했습니다.':'같은 촬영 위치에서 다른 시선만 확인했습니다. 별도 위치 근거는 없습니다.';
                if(!item.finding||validateFinding(item.finding).status!=='blocked'){
                    item.finding=joint.finding;item.status=joint.finding.status;item.reason=joint.finding.reason;item.checkedAt=result.checkedAt;
                    const supporting=review.sources.find(view=>review.supportIds.includes(view.id));
                    if(supporting)item.source=supporting.source;
                }
                if(review.reason==='framing'&&joint.finding.status==='unknown'&&(joint.finding.visibility==='occluded'||joint.finding.observation.uncertainty==='occlusion')){
                    review.reason='occlusion';review.state='pending';
                    review.note='시선을 돌려도 연결부가 가려져 다른 촬영 위치에서 다시 확인합니다.';
                }
            }
        } catch(error){
            review.failure=error instanceof Error&&error.name==='TimeoutError'?reviewStage:error instanceof ImageryServiceError?'capture':error instanceof KhuError||error instanceof z.ZodError||error instanceof SyntaxError?'analysis':'service';
            signal.throwIfAborted();
            if(error instanceof ImageryServiceError){review.note='추가 사진 촬영에 실패했습니다. 최초 관찰은 보존했습니다.';state.phase='limited';state.notice=config.imageryProvider==='google'?googleErrorNotice:imageryOutageNotice;return;}
            const detail=khuFailureReason(error,'review');
            review.note='경로 재분석 실패: '+detail+' 최초 관찰은 보존했습니다.';
            state.phase='limited';state.notice='경로 재분석 중단: '+detail;return;
        }
        const issue=evaluateRoute(route,state.evidence).issues.find(point=>point.sampleId===sample.id);
        if(issue?.status==='blocked')addExclusion(state,route,sample,'obstacle',issue.reason);
        else if(review.state==='complete'&&sample.critical&&issue?.status==='unknown')addExclusion(state,route,sample,'unverified',issue.reason);
        return;
    }
    let image;
    try {
        const target=sample.critical?sample.coord:pointAt(route.coords,sample.along+10);
        const camera=sample.acquisition?underpassApproachSamples(route,sample,[12])[0]?.sample:sample;
        image=camera?await deps.streetImage(camera,config,signal,target?{target}:{}):null;
        if(image&&!underpassCameraMatches(route,sample,image.source.coord))image=null;
    } catch(error){
        signal.throwIfAborted();state.evidence[key]={sampleId:sample.id,stage:'processed',status:'unknown',failure:'service',reason:'거리영상 서비스 연결에 실패했습니다. 현장 통행 장애 판정이 아닙니다.',checkedAt:new Date().toISOString()};
        state.phase='limited';state.notice=config.imageryProvider==='google'?googleErrorNotice:imageryOutageNotice;return;
    }
    if(!image){
        state.evidence[key]={sampleId:sample.id,stage:'processed',status:'unknown',failure:'missing',reason:'이 위치에서 판독에 사용할 거리영상을 확보하지 못했습니다.',checkedAt:new Date().toISOString()};
        if(sample.critical)addExclusion(state,route,sample,'unverified','필수 연결부의 거리영상을 확보하지 못했습니다.');
        return;
    }
    if(onCapture){
        try{await onCapture({evidenceId:key,viewId:'initial',image,target:sample});}
        catch{signal.throwIfAborted();state.evidence[key]={sampleId:sample.id,stage:'processed',status:'unknown',failure:'capture',reason:'판독용 스크린샷 저장에 실패해 분석을 시작하지 못했습니다.',checkedAt:new Date().toISOString()};state.phase='limited';state.notice='판독용 스크린샷을 저장하지 못했습니다. 이 지점의 현장 상태 판정이 아닙니다.';return;}
    }
    try {
        const context=routeImageContext({route,sample,source:image.source})+(sample.target==='entrance'?'\n사용자가 명시한 건물 진입 목표: '+state.end.name+'. 장소 좌표는 출입문 위치가 검증된 좌표가 아니다. 이 건물의 실제 출입문 연결을 관찰하되 앞 도로 도착을 건물 진입과 혼동하지 않는다.':'');
        const result=await deps.analyzeKhuImage({apiKey:config.ai,model:config.model,image:image.image,profile:state.profile,context,signal});
        const crossing=sample.target==='crossing-entry'||sample.target==='crossing-exit'||sample.target==='underpass-entry';
        const missesTarget=crossing&&pointsAwayFromTarget(image.source,sample);
        const opposed=sample.target==='crossing-entry'&&Math.abs(((sample.heading-image.source.heading+540)%360)-180)>100||sample.target==='underpass-entry'&&pointsAwayFromTarget(image.source,sample);
        const finding=(missesTarget||opposed&&result.finding.status!=='blocked')?{
            ...result.finding,status:'unknown' as const,pathVisible:false,routeMatch:'uncertain' as const,visibility:'unobservable' as const,reviewReason:'framing' as const,
            reason:missesTarget?'카메라가 목표 횡단 연결부를 등지고 있어 해당 지점을 확인할 수 없습니다.':'카메라가 횡단 진행 방향의 반대쪽을 보고 있어 진입부와 진행 연결을 함께 확인할 수 없습니다.',
            observation:result.finding.observation?{...result.finding.observation,connection:'unobservable' as const,surface:'unobservable' as const,uncertainty:'framing' as const}:undefined,
        }:result.finding;
        const item:Evidence={sampleId:sample.id,stage:'processed',status:finding.status,reason:finding.reason,finding,source:evidenceSource(image,sample),checkedAt:result.checkedAt};
        state.evidence[key]=item;
        const issue=evaluateRoute(route,state.evidence).issues.find(point=>point.sampleId===sample.id);
        if(issue?.status==='unknown'){
            const reason=finding.reviewReason==='occlusion'||finding.visibility==='occluded'||finding.observation?.uncertainty==='occlusion'?'occlusion':finding.reviewReason==='framing'||finding.observation?.uncertainty==='framing'?'framing':'corridor-uncertain';
            item.review={state:'pending',reason,initialFinding:finding,initialSource:item.source??evidenceSource(image,sample),sources:[],supportIds:[],note:reason==='framing'?'카메라를 돌려 필요한 연결부를 다시 확인합니다.':'촬영 위치를 바꿔 필요한 연결부를 다시 확인합니다.'};
        }
        if(issue?.status==='blocked')addExclusion(state,route,sample,'obstacle',issue.reason);
    } catch(error){
        signal.throwIfAborted();
        const detail=khuFailureReason(error,'initial');
        state.evidence[key]={sampleId:sample.id,stage:'processed',status:'unknown',failure:'analysis',source:evidenceSource(image,sample),reason:'경로 사진 분석 실패: '+detail+' 현장 통행 장애 판정이 아닙니다.',checkedAt:new Date().toISOString()};
        state.phase='limited';state.notice='경로 사진 분석 중단: '+detail;
    }
}
