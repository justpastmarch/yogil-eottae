import assert from 'node:assert/strict';

const base=process.env.REGIONAL_BASE_URL??'http://localhost:3000';
const scenarios=[
  {region:'서울',start:'서울시청',end:'서울역'},
  {region:'경기 수원',start:'영통3동 행정복지센터',end:'경희대학교 국제캠퍼스 학생회관'},
  {region:'부산',start:'부산역',end:'부산역광장'},
  {region:'제주',start:'제주시청',end:'제주종합경기장'},
];
async function action(body){
  const response=await fetch(new URL('/api/action',base),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(90_000)});
  const data=await response.json();
  if(!response.ok)throw new Error(`HTTP ${response.status}: ${data.error??'request failed'}`);
  return data;
}
const results=[];
for(const scenario of scenarios){
  let jobId;
  try{
    const [from,to]=await Promise.all([action({action:'search',query:scenario.start}),action({action:'search',query:scenario.end})]);
    const start=from.places?.[0],end=to.places?.[0];
    assert.ok(start&&end,'The provider did not resolve both places');
    const response=await action({action:'journey',start,end,profile:'수동 휠체어',goal:'arrival'});
    jobId=response.jobId;
    assert.ok(jobId&&response.journey?.routes?.length,'The provider did not return a route');
    const routes=response.journey.routes.filter(route=>!route.graphSegment).map(route=>({
      name:route.name,distance:route.distance,coverage:route.graphCoverage,
      crossingGuidance:route.steps.filter(step=>step.text.includes('횡단')).length,
      mappedCrossings:route.crossingSources?.length??0,
      unresolvedCrossings:route.unresolvedCrossings?.length??0,
      decision:response.journey.assessments?.[route.id]?.decision?.kind,
    }));
    assert.ok(routes.length&&routes.every(route=>route.coverage),'Every walking candidate must disclose graph coverage');
    results.push({region:scenario.region,start:start.name,end:end.name,routes});
  }catch(error){results.push({region:scenario.region,error:error instanceof Error?error.message:String(error)});}
  finally{if(jobId)try{await action({action:'cancel',jobId});}catch(error){console.error('Unable to cancel verification job',scenario.region,error);process.exitCode=1;}}
}
console.log(JSON.stringify({note:'Live provider data; map topology and early route decisions do not establish current accessibility.',results},null,2));
if(results.some(result=>result.error||!result.routes.some(route=>route.coverage?.status==='available')))process.exitCode=1;
