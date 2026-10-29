import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessRouteAdmission,evaluateRoute,type Evidence,type Finding,type Route,type RouteDecision} from '../lib/domain.ts';
import type {CapturePreview} from '../lib/capture-contract.ts';
import {analysisActivity,nameRouteCandidates,customerRouteIssues,routeAnalysisStatus,routeAdmissionStatus,routeGuideBlocked,routeIssueAction,routeIssueTitle,routeSelectionReason,sameJourneySnapshot,type AnalysisPhase} from '../app/route-presentation.ts';
import {journeySnapshotResponse} from '../lib/requests.ts';

const route:Route={
    id:'main',name:'선택한 길',options:[],coords:[[127,37],[127,37.002]],distance:222,seconds:180,steps:[],fetchedAt:'2026-10-29T00:00:00.000Z',
    samples:[
        {id:'entry',coord:[127,37],heading:0,along:0,critical:true,target:'crossing-entry'},
        {id:'ordinary',coord:[127,37.001],heading:0,along:111,critical:false,target:'sidewalk'},
        {id:'arrival',coord:[127,37.002],heading:0,along:222,critical:true,target:'arrival'},
    ],
};
function observedEvidence(candidate:Route):Record<string,Evidence>{
    return Object.fromEntries(candidate.samples.map(sample=>{
        const finding:Finding={status:'clear',reason:'필요한 연결부 관찰',pathVisible:true,routeMatch:'same-path',visibility:'visible',evidence:[],limitations:[],observation:{connection:'flush',surface:'continuous',uncertainty:'none',target:sample.target??'unspecified',reason:'같은 통로의 연결이 보임'}};
        return [candidate.id+':'+sample.id,{sampleId:sample.id,stage:'processed',status:'clear',reason:finding.reason,finding,source:{url:'https://map.naver.com/',capturedAt:null,coord:sample.coord,distance:0},checkedAt:'2026-10-29T00:00:00.000Z'} satisfies Evidence];
    }));
}
function decision(candidate:Route,evidence:Record<string,Evidence>,phase:AnalysisPhase='running'):RouteDecision{
    return evaluateRoute(candidate,evidence,[],undefined,{state:phase==='running'?'searching':phase==='canceled'||phase==='failed'?'interrupted':'finished',attempts:0,alternatives:0,reason:'탐색 상태'});
}
function assessment(candidate:Route,decision:RouteDecision,blockedPassageIds:string[]=[],maxSlope?:number){
    return {decision,blockedPassageIds,admission:assessRouteAdmission({route:candidate,decision,blockedPassageIds,maxSlope})};
}
function capture(evidenceId:string,viewId='initial'):CapturePreview{
    return {id:'3eb4e718-dd0a-47a5-a832-cda234f602f2',evidenceId,viewId,url:'/api/journey-image?id=3eb4e718-dd0a-47a5-a832-cda234f602f2',source:{url:'https://map.naver.com/',capturedAt:null,coord:[127,37],distance:0},createdAt:'2026-10-29T00:00:00.000Z'};
}
function withGrade(candidate:Route,maxAbsPercent:number):Route{
    return {...candidate,grade:{status:'available',dataset:'srtm30m',resolutionMeters:30,baselineMeters:60,retrievedAt:'2026-10-29T00:00:00.000Z',maxAbsPercent,ascentMeters:20,descentMeters:10,coverageFraction:1,segments:[{fromAlong:0,toAlong:222,coords:candidate.coords,gradePercent:maxAbsPercent}]}};
}

test('only an actual recommended assessment earns the recommendation status',()=>{
    const evidence=observedEvidence(route),recommended=decision(route,evidence,'ready');
    assert.equal(recommended.kind,'recommended');
    assert.equal(routeAnalysisStatus({route,decision:recommended,evidence,phase:'running'}).kind,'recommended');
    assert.notEqual(routeAnalysisStatus({route,decision:undefined,evidence,phase:'ready'}).kind,'recommended');
    const held=evaluateRoute(route,evidence,[],8);
    assert.equal(held.kind,'hold');
    assert.equal(routeAnalysisStatus({route,decision:held,evidence,phase:'ready'}).kind,'incomplete');
    delete evidence[route.id+':ordinary'];
    const conditional=decision(route,evidence,'ready');
    assert.equal(conditional.kind,'conditional');
    assert.equal(routeAnalysisStatus({route,decision:conditional,evidence,phase:'ready'}).kind,'conditional');
});

test('canceling further work preserves a valid recommendation and ordinary guidance',()=>{
    const evidence=observedEvidence(route),result=decision(route,evidence,'canceled');
    assert.equal(routeAnalysisStatus({route,decision:result,evidence,phase:'canceled'}).kind,'recommended');
    assert.equal(routeGuideBlocked(assessment(route,result)),false);
    const activity=analysisActivity({routes:[route],evidence,captures:[capture('main:entry')],phase:'canceled',selectedId:route.id});
    assert.equal(activity.busy,false);
    assert.match(activity.detail,/사진 1장/);
    assert.match(activity.detail,/판독 3곳/);
});

test('an overall ready job does not complete entirely unseen candidates',()=>{
    for(const candidate of [route,{...route,id:'ordinary-only',samples:route.samples.filter(sample=>!sample.critical)}]){
        const result=routeAnalysisStatus({route:candidate,decision:decision(candidate,{},'ready'),evidence:{},phase:'ready'});
        assert.ok(result.kind==='required'||result.kind==='incomplete');
        assert.notEqual(result.kind,'recommended');
    }
    const activity=analysisActivity({routes:[route],evidence:{},captures:[],phase:'ready',selectedId:route.id});
    assert.equal(activity.busy,false);
    assert.match(activity.detail,/2곳/);
    assert.doesNotMatch(activity.title,/완료/);
});

test('independent internal connections are not ordinary waiting samples',()=>{
    const ordinary:Route={...route,samples:route.samples.filter(sample=>!sample.critical)};
    assert.equal(routeAnalysisStatus({route:ordinary,decision:decision(ordinary,{}),evidence:{},phase:'running'}).kind,'pending');
    for(const kind of ['station','underpass','elevator'] satisfies NonNullable<Route['unverifiedConnections']>[number]['kind'][]){
        const candidate:Route={...ordinary,unverifiedConnections:[{id:'internal',kind,coord:[127,37],along:100,reason:'지상 영상으로 내부 연결 확인 불가'}]};
        const assessed=decision(candidate,{});
        assert.equal(routeAnalysisStatus({route:candidate,decision:assessed,evidence:{},phase:'running'}).kind,'required');
        assert.deepEqual(customerRouteIssues(candidate,assessed.issues,{}).map(issue=>issue.sampleId),['internal']);
    }
});

test('a reserved point marks only its own candidate as actively analyzing',()=>{
    const other:Route={...route,id:'main:other',name:'실제 분석 대상'};
    const evidence:Record<string,Evidence>={'main:other:entry':{sampleId:'entry',stage:'reserved',status:'unknown',reason:'사진 확보 중',checkedAt:''}};
    assert.equal(routeAnalysisStatus({route,decision:decision(route,evidence),evidence,phase:'running'}).kind,'pending');
    assert.equal(routeAnalysisStatus({route:other,decision:decision(other,evidence),evidence,phase:'running'}).kind,'analyzing');
    const activity=analysisActivity({routes:[route,other],evidence,captures:[],phase:'running',selectedId:route.id});
    assert.equal(activity.busy,true);
    assert.ok(activity.detail.includes(other.name));
    assert.ok(activity.detail.includes(route.name));
    assert.match(activity.detail,/0m/);
});

test('saved captures before the first AI result are not mistaken for completed observations',()=>{
    const evidence:Record<string,Evidence>={'main:entry':{sampleId:'entry',stage:'reserved',status:'unknown',reason:'진행 중',checkedAt:''}};
    const input:Omit<Parameters<typeof analysisActivity>[0],'captures'>={routes:[route],evidence,phase:'running',selectedId:route.id};
    const acquiring=analysisActivity({...input,captures:[]});
    const captured=analysisActivity({...input,captures:[capture('main:entry')]});
    assert.match(acquiring.title,/사진.*확보/);
    assert.match(captured.title,/판독.*(기다|대기)/);
    assert.notEqual(acquiring.title,captured.title);
    assert.ok(captured.detail.includes(route.name));
    assert.match(captured.detail,/0m/);
    assert.equal(routeAnalysisStatus({route,decision:decision(route,evidence),evidence,phase:'running'}).kind,'analyzing');
});

test('a reserved review is identified separately from an initial capture and preserves its initial observation',()=>{
    const evidence=observedEvidence(route),item=evidence['main:entry'];
    assert.ok(item.finding&&item.source);
    item.finding={...item.finding,status:'unknown',observation:{connection:'unobservable',surface:'continuous',uncertainty:'framing',target:'crossing-entry',reason:'연결부 화면 밖'}};
    item.status='unknown';
    item.review={state:'reserved',reason:'framing',initialFinding:item.finding,initialSource:item.source,sources:[],supportIds:[],note:'다른 시선 확인 중'};
    const input:Omit<Parameters<typeof analysisActivity>[0],'captures'>={routes:[route],evidence,phase:'running',selectedId:route.id};
    const acquiring=analysisActivity({...input,captures:[capture('main:entry')]});
    assert.match(acquiring.title,/재확인/);
    assert.equal(item.review.initialFinding,item.finding);
    assert.ok(acquiring.detail.includes(route.name));
    const captured=analysisActivity({...input,captures:[capture('main:entry'),capture('main:entry','review-1')]});
    assert.match(captured.title,/재확인.*판독/);
    assert.equal(routeAnalysisStatus({route,decision:decision(route,evidence),evidence,phase:'running'}).kind,'analyzing');
});

test('archived captures without a reserved operation do not invent an active AI stage',()=>{
    const activity=analysisActivity({routes:[route],evidence:observedEvidence(route),captures:[capture('main:entry')],phase:'running',selectedId:route.id});
    assert.equal(activity.busy,true);
    assert.doesNotMatch(activity.title,/판독|재확인/);
});

test('capture, analysis and service errors remain nonphysical failures',()=>{
    for(const failure of ['capture','analysis','service'] satisfies NonNullable<Evidence['failure']>[]){
        const evidence:Record<string,Evidence>={'main:entry':{sampleId:'entry',stage:'processed',status:'unknown',failure,reason:'서비스 처리 실패',checkedAt:''}};
        const assessed=decision(route,evidence,'failed');
        assert.equal(assessed.kind,'hold');
        const status=routeAnalysisStatus({route,decision:assessed,evidence,phase:'failed'});
        assert.equal(status.kind,'error');
        assert.match(status.detail,/장애.*아니/);
        assert.equal(routeGuideBlocked(assessment(route,assessed)),false);
    }
});

test('a failed review is an error rather than a physical blockage',()=>{
    const evidence=observedEvidence(route),item=evidence['main:entry'];
    assert.ok(item.finding&&item.source);
    item.review={state:'complete',failure:'analysis',reason:'framing',initialFinding:item.finding,initialSource:item.source,sources:[],supportIds:[],note:'재판독 실패'};
    const assessed=decision(route,evidence,'limited');
    assert.equal(routeAnalysisStatus({route,decision:assessed,evidence,phase:'limited'}).kind,'error');
    assert.equal(routeGuideBlocked(assessment(route,assessed)),false);
});

test('failure on another candidate cannot turn the selected candidate into an error',()=>{
    const evidence=observedEvidence(route);
    evidence['other:entry']={sampleId:'entry',stage:'processed',status:'unknown',failure:'service',reason:'다른 후보 오류',checkedAt:''};
    assert.equal(routeAnalysisStatus({route,decision:decision(route,evidence,'ready'),evidence,phase:'ready'}).kind,'recommended');
});

test('required missing imagery is retained without listing every unseen ordinary sample',()=>{
    const evidence:Record<string,Evidence>={'main:entry':{sampleId:'entry',stage:'processed',status:'unknown',failure:'missing',reason:'이 위치 영상 없음',checkedAt:''}};
    const assessed=decision(route,evidence,'limited');
    assert.equal(routeAnalysisStatus({route,decision:assessed,evidence,phase:'limited'}).kind,'required');
    assert.deepEqual(customerRouteIssues(route,assessed.issues,evidence).map(issue=>issue.sampleId),['entry']);
    assert.deepEqual(customerRouteIssues(route,decision(route,{}).issues,{}),[]);
});

test('unresolved mapped crossings and internal connections all stay actionable without generic pending rows',()=>{
    const candidate:Route={...route,
        unresolvedCrossings:[{id:'crossing-gap',coord:[127,37],along:10,count:2,source:'osm'}],
        unverifiedConnections:[{id:'underpass',kind:'underpass',coord:[127,37],along:50,reason:'지하 연결 미확인'},{id:'elevator',kind:'elevator',coord:[127,37],along:100,reason:'승강기 연결 미확인'}],
    };
    const assessed=decision(candidate,{}),issues=customerRouteIssues(candidate,assessed.issues,{});
    assert.deepEqual(issues.map(issue=>issue.sampleId),['crossing-gap','underpass','elevator']);
    assert.equal(routeAnalysisStatus({route:candidate,decision:assessed,evidence:{},phase:'running'}).kind,'required');
});

test('a raw clear finding for the wrong target stays an unresolved crossing for consumers',()=>{
    const evidence=observedEvidence(route),item=evidence['main:entry'];
    assert.ok(item.finding?.observation);
    item.finding.observation.target='sidewalk';
    const assessed=decision(route,evidence,'ready'),issue=assessed.issues.find(point=>point.sampleId==='entry');
    assert.ok(issue);
    assert.equal(issue.status,'unknown');
    assert.equal(routeAnalysisStatus({route,decision:assessed,evidence,phase:'ready'}).kind,'required');
    assert.deepEqual(customerRouteIssues(route,assessed.issues,evidence).map(point=>point.id),[issue.id]);
    assert.match(routeIssueTitle(route,issue),/횡단/);
    assert.equal(routeIssueAction(route,issue),issue.action);
});

test('unknown titles refer to the actual crossing, internal or ordinary target',()=>{
    const candidate:Route={...route,unresolvedCrossings:[{id:'crossing-gap',coord:[127,37],along:10,count:2}],unverifiedConnections:[{id:'station',kind:'station',coord:[127,37],along:20,reason:'역 연결 미확인'},{id:'underpass',kind:'underpass',coord:[127,37],along:30,reason:'지하 연결 미확인'}]};
    for(const issue of decision(candidate,{}).issues){
        const title=routeIssueTitle(candidate,issue);
        if(issue.sampleId==='entry'||issue.sampleId==='crossing-gap')assert.match(title,/횡단/);
        else if(issue.sampleId==='station')assert.match(title,/역 출입구/);
        else if(issue.sampleId==='underpass')assert.match(title,/지하통로/);
        else assert.doesNotMatch(title,/역 출입구|지하통로|엘리베이터/);
    }
});

test('ordinary guidance keeps its existing blocked, partial and unknown boundaries',()=>{
    const unknown=decision(route,{},'limited');
    assert.equal(routeGuideBlocked(undefined),true);
    assert.equal(routeGuideBlocked(assessment(route,unknown)),false);
    assert.equal(routeGuideBlocked(assessment(route,unknown,['shared-obstacle'])),true);
    const partial:Route={...route,graphSegment:{provider:'openstreetmap',snapshotAt:'2026-10-29T00:00:00.000Z',startGapMeters:10,endGapMeters:20,sharedRoadMeters:100}};
    assert.equal(routeGuideBlocked(assessment(partial,decision(partial,{}))),true);
    assert.equal(routeAnalysisStatus({route:partial,decision:decision(partial,{}),evidence:{},phase:'ready'}).kind,'partial');
    const blocked:Route={...route,barriers:[{sampleId:'stairs',coord:[127,37],along:50,reason:'계단 안내',source:'provider'}]};
    const assessed=decision(blocked,{});
    assert.equal(routeGuideBlocked(assessment(blocked,assessed)),true);
    assert.equal(routeAnalysisStatus({route:blocked,decision:assessed,evidence:{},phase:'running'}).kind,'blocked');
    assert.deepEqual(customerRouteIssues(blocked,assessed.issues,{}).map(issue=>issue.sampleId),['stairs']);
});

test('similar rounded grades cannot become a superiority claim from tiny differences',()=>{
    const first=withGrade(route,13.451),second=withGrade({...route,id:'second',name:'다른 길',seconds:120},13.499);
    assert.equal(first.grade?.status,'available');
    for(const candidate of [first,second]){
        const reason=routeSelectionReason(candidate,[first,second],'gentle',false);
        assert.match(reason,/비슷|동일|같/);
        assert.doesNotMatch(reason,/가장|더 완만|더 낮|더 작/);
    }
    const explicit=routeSelectionReason(first,[first,second],'gentle',true);
    assert.match(explicit,/직접 선택/);
    assert.doesNotMatch(explicit,/가장|더 완만/);
});

test('missing terrain coverage and rounded times do not invent a winning candidate',()=>{
    const complete=withGrade(route,5),missing:Route={...route,id:'missing',seconds:179};
    const reason=routeSelectionReason(complete,[complete,missing],'gentle',false);
    assert.doesNotMatch(reason,/가장|더 완만/);
    assert.match(routeSelectionReason(missing,[complete,missing],'gentle',false),/자료.*없/);
    assert.match(routeSelectionReason(route,[route,missing],'fast',false),/비슷|동일|같/);
    const partial:Route={...complete,grade:complete.grade?.status==='available'?{...complete.grade,status:'partial',coverageFraction:0.5}:undefined};
    assert.match(routeSelectionReason(partial,[partial,missing],'gentle',false),/일부/);
    assert.doesNotMatch(routeSelectionReason(partial,[partial,missing],'gentle',false),/가장|더 완만/);
});

test('concurrent capture and AI-wait stages identify every actual active candidate',()=>{
    const other:Route={...route,id:'other',name:'동시에 확인하는 길'};
    const evidence:Record<string,Evidence>={
        'main:entry':{sampleId:'entry',stage:'reserved',status:'unknown',reason:'진행 중',checkedAt:''},
        'other:entry':{sampleId:'entry',stage:'reserved',status:'unknown',reason:'진행 중',checkedAt:''},
    };
    const activity=analysisActivity({routes:[route,other],evidence,captures:[capture('main:entry')],phase:'running',selectedId:route.id});
    assert.match(activity.title,/확보.*판독/);
    assert.ok(activity.detail.includes(route.name));
    assert.ok(activity.detail.includes(other.name));
    assert.equal(activity.busy,true);
});

test('a route without inspection points never implies its connections were confirmed',()=>{
    const candidate:Route={...route,samples:[]};
    const activity=analysisActivity({routes:[candidate],evidence:{},captures:[],phase:'ready',selectedId:candidate.id});
    assert.match(activity.detail,/관찰 지점 자료 없음/);
    assert.doesNotMatch(activity.detail,/미확인 항목 없음/);
    assert.equal(routeAnalysisStatus({route:candidate,decision:decision(candidate,{},'ready'),evidence:{},phase:'ready'}).kind,'incomplete');
});

test('unavailable pedestrian-map data is explicit even before imagery finishes',()=>{
    const candidate:Route={...route,graphCoverage:{status:'unavailable',reason:'network'}};
    const assessed=decision(candidate,{});
    const result=routeAnalysisStatus({route:candidate,decision:assessed,evidence:{},phase:'running'});
    assert.equal(result.kind,'incomplete');
    assert.match(result.label,/지도/);
    assert.equal(result.detail,assessed.reason);
    const activity=analysisActivity({routes:[candidate],evidence:{},captures:[],phase:'limited',selectedId:candidate.id});
    assert.match(activity.detail,/지도/);
    assert.doesNotMatch(activity.detail,/확인 완료|미확인 항목 없음/);
});

test('unsupported numeric slope limits retain their actual evaluator explanation while waiting',()=>{
    for(const evidence of [{},observedEvidence(route)]){
        const assessed=evaluateRoute(route,evidence,[],8,{state:'searching',attempts:0,alternatives:0,reason:'탐색 중'});
        const result=routeAnalysisStatus({route,decision:assessed,evidence,phase:'running'});
        assert.notEqual(result.kind,'recommended');
        assert.equal(result.detail,assessed.reason);
        assert.match(result.detail,/8%/);
        assert.equal(routeGuideBlocked(assessment(route,assessed,[],8)),true);
    }
});

function pendingSnapshot(){
    return journeySnapshotResponse.parse({jobId:'515286b8-a19d-4507-846a-26a0407f47b4',phase:'running',journey:{goal:'arrival',routes:[route],evidence:{},assessments:{[route.id]:assessment(route,decision(route,{}))},recommendedId:null,status:'limited'},captures:[],progress:{checked:0,total:route.samples.length,analyses:0}});
}
test('an arriving photo updates the view before any AI or progress counter changes',()=>{
    const previous=pendingSnapshot(),unchanged=journeySnapshotResponse.parse(structuredClone(previous));
    assert.equal(sameJourneySnapshot(previous,unchanged),true);
    const withPhoto=journeySnapshotResponse.parse({...unchanged,captures:[capture('main:entry')]});
    assert.deepEqual(withPhoto.progress,previous.progress);
    assert.equal(sameJourneySnapshot(previous,withPhoto),false);
});
test('service failure, cancellation and replacement jobs remain visible with unchanged counters',()=>{
    const previous=pendingSnapshot();
    const failure=journeySnapshotResponse.parse({...previous,journey:{...previous.journey,evidence:{'main:entry':{sampleId:'entry',stage:'processed',status:'unknown',failure:'service',reason:'판독 서비스 실패',checkedAt:'2026-10-29T00:00:00.000Z'}}}});
    assert.equal(sameJourneySnapshot(previous,failure),false);
    assert.equal(sameJourneySnapshot(previous,journeySnapshotResponse.parse({...previous,phase:'canceled'})),false);
    assert.equal(sameJourneySnapshot(previous,journeySnapshotResponse.parse({...previous,jobId:'243e3127-8939-4f55-adfb-a97da2159553'})),false);
});

 test('only a clear observation at the exact mapped entry suppresses its duplicate warning',()=>{
    const candidate:Route={...route,unresolvedCrossings:[{id:'mapped-entry',coord:[127,37],along:0,count:1}]};
    const evidence=observedEvidence(candidate);
    const visible=(candidate:Route,items:Record<string,Evidence>)=>customerRouteIssues(candidate,decision(candidate,items).issues,items).some(issue=>issue.sampleId==='mapped-entry');
    assert.equal(visible(candidate,evidence),false);
    assert.equal(decision(candidate,evidence).issues.find(issue=>issue.sampleId==='mapped-entry')?.status,'unknown');
    assert.equal(visible(candidate,{}),true);
    assert.equal(visible({...candidate,unresolvedCrossings:[{id:'mapped-entry',coord:[127,37],along:0,count:1,source:'osm'}]},evidence),true);
    assert.equal(visible({...candidate,unresolvedCrossings:[{...candidate.unresolvedCrossings![0],along:1}]},evidence),true);
    assert.equal(visible({...candidate,unresolvedCrossings:[{...candidate.unresolvedCrossings![0],count:2}]},evidence),true);
    const wrong=structuredClone(evidence);wrong['main:entry'].finding!.observation!.target='sidewalk';
    assert.equal(visible(candidate,wrong),true);
 });

test('candidate names use distance and eligible terrain ranking, not provider mode names',()=>{
    const short=withGrade({...route,id:'short',name:'넓은 길',distance:100},20);
    const gentle=withGrade({...route,id:'gentle',name:'편안한 길',distance:200},5);
    const other=withGrade({...route,id:'other',distance:300},10);
    const candidates=[short,gentle,other];
    const assessments=Object.fromEntries(candidates.map(item=>[item.id,assessment(item,decision(item,{}))]));
    assert.deepEqual(nameRouteCandidates(candidates,assessments).map(item=>item.name),['최단 경로','최적 경로(완만한 길)','다른 경로 1']);
    assert.equal(short.name,'넓은 길');
    assert.equal(nameRouteCandidates([gentle],assessments)[0].name,'최적 경로(완만한 길·최단)');
    assert.deepEqual(nameRouteCandidates([{...short,grade:undefined},{...gentle,grade:undefined}],assessments).map(item=>item.name),['최단 경로','다른 경로 1']);
});

test('a persisted credit failure explains the billing action instead of only reporting unobserved points',()=>{
    const input={routes:[route],evidence:{},captures:[],phase:'limited',selectedId:route.id,message:'경로 사진 분석 중단: 분석 서비스 크레딧이 부족합니다. (HTTP 402)'} satisfies Parameters<typeof analysisActivity>[0];
    const activity=analysisActivity(input);
    assert.equal(activity.title,'사진 분석 크레딧이 부족해요');
    assert.match(activity.detail,/크레딧·결제 상태를 확인한 뒤 다시 경로를 찾아/);
    assert.doesNotMatch(activity.title+activity.detail,/HTTP|402|통행 장애|계단/);
    assert.equal(activity.busy,false);
    assert.equal(routeGuideBlocked(assessment(route,decision(route,{},'limited'))),false);
});
test('raw provider diagnostics are never echoed into the activity billing explanation',()=>{
    for(const message of ['upstream HTTP 402 secret-test-key=private-value','provider disconnected secret-test-key=private-value']){
        const input={routes:[route],evidence:{},captures:[],phase:'failed',selectedId:route.id,message} satisfies Parameters<typeof analysisActivity>[0];
        const activity=analysisActivity(input);
        assert.doesNotMatch(activity.title+activity.detail,/HTTP|402|secret-test-key|private-value|upstream|provider disconnected/);
        if(message.includes('402'))assert.match(activity.title,/크레딧/);
        else assert.doesNotMatch(activity.title,/크레딧/);
    }
});
test('a canceled or running job does not display an old billing notice as its current activity',()=>{
    for(const phase of ['canceled','running'] as const){
        const input={routes:[route],evidence:{},captures:[],phase,selectedId:route.id,message:'분석 서비스 크레딧이 부족합니다. (HTTP 402)'} satisfies Parameters<typeof analysisActivity>[0];
        assert.doesNotMatch(analysisActivity(input).title,/크레딧/);
    }
});
