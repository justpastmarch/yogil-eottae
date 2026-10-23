import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {geocode,search,routes,reroute} from '../lib/providers.ts';
import {blockedPassageFor,detourViaPlans,routeTouchesPassage,validateCandidate} from '../lib/detours.ts';
import {projectOnRoute} from '../lib/domain.ts';
import {routingConfig} from '../lib/server-config.ts';

const config=routingConfig();
const [starts,ends]=await Promise.all([geocode('수원시 영통구 영통동 992-1',config),search('경희대학교 국제캠퍼스 학생회관',config)]);
const start=starts[0],end=ends.find(place=>place.name==='경희대학교 국제캠퍼스 학생회관');
assert.ok(start&&end,'The actual scenario locations must be resolved by the external API');
const actual=(await routes(start,end,config)).routes;
assert.ok(actual.length>=2,'The external API must produce at least two geometrically distinct routes');
const baseline=actual.reduce((a,b)=>a.distance<b.distance?a:b);
const selected=baseline.samples.find(sample=>sample.along>100&&sample.along<baseline.distance-100&&actual.some(route=>route.id!==baseline.id&&(projectOnRoute(route.coords,sample.coord)?.distance??0)>15));
assert.ok(selected,'Real paths must diverge enough for an independent exclusion experiment');
const exclusion=blockedPassageFor(baseline,selected);
assert.ok(routeTouchesPassage(baseline,exclusion),'Baseline must traverse the deliberately injected TEST-ONLY exclusion');

function independentSeparation(point,coords){
    const scale=111320*Math.cos(point[1]*Math.PI/180);
    let nearest=Infinity;
    for(let i=1;i<coords.length;i++){
        const a=[(coords[i-1][0]-point[0])*scale,(coords[i-1][1]-point[1])*111320];
        const b=[(coords[i][0]-point[0])*scale,(coords[i][1]-point[1])*111320];
        const dx=b[0]-a[0],dy=b[1]-a[1],denom=dx*dx+dy*dy;
        const t=denom?Math.max(0,Math.min(1,-(a[0]*dx+a[1]*dy)/denom)):0;
        nearest=Math.min(nearest,Math.hypot(a[0]+t*dx,a[1]+t*dy));
    }
    return nearest;
}
const controlPoints=exclusion.coords.flatMap((point,index,coords)=>{
    const next=coords[index+1];
    if(!next)return[point];
    const length=Math.hypot((next[0]-point[0])*111320*Math.cos(point[1]*Math.PI/180),(next[1]-point[1])*111320);
    const count=Math.max(1,Math.ceil(length));
    return Array.from({length:count},(_,i)=>[point[0]+(next[0]-point[0])*i/count,point[1]+(next[1]-point[1])*i/count]);
});
const attempts=[];
let verified;
for(const via of detourViaPlans(baseline,exclusion)){
    try{
        const candidate=await reroute(start,end,config,via);
        const acceptance=validateCandidate(candidate,baseline,[exclusion]);
        const separation=Math.min(...controlPoints.map(point=>independentSeparation(point,candidate.coords)));
        attempts.push({distance:candidate.distance,acceptance,independentSeparationMeters:Math.round(separation*10)/10});
        if(acceptance.ok&&separation>8){verified=candidate;break;}
    }catch(error){attempts.push({error:error instanceof Error?error.name:'UnknownError'});}
}
const report={checkedAt:new Date().toISOString(),scenario:{start,end},source:'Live Kakao walking API',candidates:actual.map(route=>({id:route.id,name:route.name,distance:route.distance,seconds:route.seconds,coordinateCount:route.coords.length})),experiment:'TEST-ONLY deliberately injected exclusion; NOT a field or AI obstacle observation',baseline:baseline.id,exclusion,attempts,verifiedDetour:verified?{distance:verified.distance,seconds:verified.seconds,coords:verified.coords}:null};
if(process.env.DETOUR_REPORT_PATH)writeFileSync(process.env.DETOUR_REPORT_PATH,JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,scenario:undefined,exclusion:undefined,verifiedDetour:verified?{distance:verified.distance,seconds:verified.seconds}:null},null,2));
assert.ok(verified,'At least one actual waypoint reroute must independently avoid the test passage by more than 8m');
