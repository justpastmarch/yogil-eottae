import {readFile,writeFile} from 'node:fs/promises';
import {loadPedestrianGraph} from '../lib/osm-data.ts';
import {discoverCrossingAlternatives,validateCrossingProposal} from '../lib/crossing-alternatives.ts';
import {search,reroute} from '../lib/providers.ts';
import {routingConfig} from '../lib/server-config.ts';
import {validateCandidate,routeIsDistinct} from '../lib/detours.ts';
const signal=AbortSignal.timeout(120000),config=routingConfig();
const [start]=await search('영통3동 행정복지센터',config,signal),[end]=await search('경희대학교 국제캠퍼스 학생회관',config,signal);
const saved=JSON.parse(await readFile('.sites-runtime/mobility-features/actual-crossing-routes.json','utf8'));
const baseline=saved.routes;
const graph=await loadPedestrianGraph(baseline[0],signal,'http://127.0.0.1:8789/api/interpreter');
if(graph.kind!=='available')throw Error('Actual graph unavailable');
const results=[];
for(const proposal of discoverCrossingAlternatives(start,end,baseline,graph.graph)){
 try{
  const candidate=await reroute(start,end,config,proposal.via,signal);
  const record={proposal,candidate,shape:validateCandidate(candidate,baseline[0],[]),distinct:routeIsDistinct(candidate,baseline),traversal:validateCrossingProposal(candidate,proposal,graph.graph),stairs:candidate.steps.filter(step=>step.text.replace(/\s+/g,'')==='계단이용')};
  results.push(record);
  console.log(JSON.stringify({ways:proposal.crossingWayIds,via:proposal.via,distance:candidate.distance,shape:record.shape,distinct:record.distinct,traversal:record.traversal,stairs:record.stairs.length}));
 }catch(error){results.push({proposal,error:error instanceof Error?error.message:String(error)});}
}
await writeFile('.sites-runtime/mobility-features/crossing-provider-diagnostic.json',JSON.stringify(results,null,2));
if(!results.some(result=>result.shape?.ok&&result.distinct&&result.traversal&&!result.stairs.length))process.exitCode=1;
