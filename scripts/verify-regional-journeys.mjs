import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const scenarios={
  seoul:{region:'서울',start:'서울시청',end:'서울역'},
  suwon:{region:'수원',start:'영통3동 행정복지센터',end:'경희대학교 국제캠퍼스 학생회관'},
  busan:{region:'부산',start:'부산역',end:'부산역광장'},
  jeju:{region:'제주',start:'제주시청',end:'제주종합경기장'},
};
const name=process.argv[2];
if(!Object.hasOwn(scenarios,name)){console.error('Usage: node scripts/verify-regional-journeys.mjs seoul|suwon|busan|jeju');process.exit(2);}
const imageryProvider=process.env.REGIONAL_IMAGERY_PROVIDER??'configured';
if(!['configured','kartaview','google'].includes(imageryProvider)){console.error('REGIONAL_IMAGERY_PROVIDER must be configured, kartaview or google');process.exit(2);}
const scenario=scenarios[name],base=process.env.REGIONAL_BASE_URL??'http://localhost:3000';
const directory=process.env.REGIONAL_REPORT_DIR??'.sites-runtime/regional-journeys';
await mkdir(directory,{recursive:true});
async function action(body){
  const response=await fetch(new URL('/api/action',base),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(180_000)});
  const result=await response.json();
  if(!response.ok)throw new Error(`HTTP ${response.status}: ${result.error??'request failed'}`);
  return result;
}
const path=join(directory,name+'-'+imageryProvider+'.json');
let snapshot,jobId,start,end,steps=0;
try{
  const [a,b]=await Promise.all([action({action:'search',query:scenario.start}),action({action:'search',query:scenario.end})]);
  start=a.places?.[0];end=b.places?.[0];
  if(!start||!end)throw new Error('A requested place was not returned by the map provider');
  snapshot=await action({action:'journey',start,end,profile:'수동 휠체어',goal:'arrival',imageryProvider});
  jobId=snapshot.jobId;
  if(!jobId||!snapshot.journey?.routes?.length)throw new Error('The provider did not return a journey');
  while(snapshot.phase==='running'){
    if(++steps>120)throw new Error('The journey did not settle within its documented operation budget');
    snapshot=await action({action:'advance',jobId});
    await writeFile(path,JSON.stringify({scenario,start,end,steps,snapshot},null,2));
    console.log(JSON.stringify({region:scenario.region,step:steps,phase:snapshot.phase,checked:snapshot.progress.checked,total:snapshot.progress.total,analyses:snapshot.progress.analyses,notice:snapshot.progress.notice}));
  }
  await writeFile(path,JSON.stringify({scenario,start,end,steps,snapshot},null,2));
  const outcomes=snapshot.journey.routes.map(route=>({name:route.name,graph:route.graphCoverage,issues:snapshot.journey.assessments[route.id]?.decision.issues.filter(issue=>issue.status!=='clear').map(({along,status,source,reason})=>({along,status,source,reason})),decision:snapshot.journey.assessments[route.id]?.decision.kind}));
  console.log(JSON.stringify({region:scenario.region,phase:snapshot.phase,checked:snapshot.progress.checked,analyses:snapshot.progress.analyses,recommendedId:snapshot.journey.recommendedId,notice:snapshot.progress.notice,outcomes}));
  const unfinished=Object.values(snapshot.journey.evidence).some(item=>item.stage==='reserved'||item.review?.state==='pending'||item.review?.state==='reserved');
  if(imageryProvider==='google'&&(!snapshot.captures?.length||snapshot.captures.some(capture=>new URL(capture.source.url).hostname!=='www.google.com')))throw new Error('No exclusively Google Street View evidence was captured; Google route analysis is unverified');
  if(snapshot.phase!=='ready'||snapshot.journey.status!=='ready'||!snapshot.journey.recommendedId||unfinished)process.exitCode=1;
}catch(error){
  console.error(JSON.stringify({region:scenario.region,error:error instanceof Error?error.message:String(error),jobId,steps}));
  if(jobId)try{snapshot=await action({action:'status',jobId});}catch{}
  await writeFile(path,JSON.stringify({scenario,start,end,steps,snapshot,error:error instanceof Error?error.message:String(error)},null,2));
  process.exitCode=1;
}
