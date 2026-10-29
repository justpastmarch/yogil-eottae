import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {z} from 'zod';
import {placeSchema,meters} from '../lib/domain.ts';
import {journeyResponse} from '../lib/requests.ts';
import {reroute} from '../lib/providers.ts';
import {routingConfig} from '../lib/server-config.ts';
import {providerStairSamples} from '../lib/journey.ts';
import {detourViaPlans,validateCandidate,routeIsDistinct,routeTouchesPassage} from '../lib/detours.ts';

const input=process.argv[2]??'.sites-runtime/route-ux-fix/actual-state.json';
const output='.sites-runtime/route-ux-fix';
const coord=z.tuple([z.number(),z.number()]);
// Only route geometry/guidance is needed; historic POI-gap annotations are not replay inputs.
const snapshot=z.object({start:placeSchema,end:placeSchema,profile:z.string(),candidates:z.array(journeyResponse.shape.routes.element.omit({unverifiedConnections:true})).min(1),exclusions:z.array(z.object({id:z.string(),routeId:z.string(),sampleId:z.string(),fromAlong:z.number(),toAlong:z.number(),coords:z.array(coord),reason:z.enum(['obstacle','unverified']).optional(),detail:z.string().optional()}))}).parse(JSON.parse(await readFile(input,'utf8')));
const first=snapshot.exclusions[0],origin=snapshot.candidates.find(route=>route.id===first?.routeId),baseline=snapshot.candidates.reduce((a,b)=>a.distance<=b.distance?a:b);
if(!first||!origin)throw Error('A captured first exclusion and its provider route are required');
const config=routingConfig();if(config.kind!=='kakao')throw Error('This replay requires the configured Kakao walking provider');
const report={scope:'Diagnostic re-query of the original scenario and first queued waypoint plans. Original per-request responses were not persisted; this is current-provider replay, not fabricated historical responses. No imagery, inference, or job mutation.',start:snapshot.start,end:snapshot.end,firstQueuedReason:first.reason,firstQueuedDetail:first.detail,existingCrossingAlternatives:snapshot.candidates.filter(route=>route.crossingChoice).map(({id,distance,crossingChoice})=>({id,distance,crossingChoice})),attempts:[]};
for(const [index,via] of detourViaPlans(origin,first).slice(0,4).entries()){
 try{
  const candidate=await reroute(snapshot.start,snapshot.end,config,via,AbortSignal.timeout(20000));
  const stairs=providerStairSamples(candidate,snapshot.profile),validation=validateCandidate(candidate,baseline,snapshot.exclusions);
  const touching=snapshot.exclusions.filter(passage=>routeTouchesPassage(candidate,passage));
  const originalFirstExclusion=validateCandidate(candidate,baseline,[first]);
  const geometryFailure=!originalFirstExclusion.ok&&originalFirstExclusion.reason!=='excluded-passage'?originalFirstExclusion:null;
  const historicalFirstGate=geometryFailure??(routeTouchesPassage(candidate,first)?{ok:false,reason:'excluded-passage'}:originalFirstExclusion);
  const duplicate=snapshot.candidates.find(existing=>!routeIsDistinct(candidate,[existing]));
  const reason=stairs.length?'provider-stairs':!historicalFirstGate.ok?historicalFirstGate.reason:duplicate?'existing-candidate':'accepted';
  report.attempts.push({index:index+1,via,distance:candidate.distance,stairs:stairs.length,historicalFirstGate,originalPolicyOutcome:reason,currentValidation:validation,duplicatesRoute:duplicate?.id??null,touches:touching.map(({sampleId,reason,detail})=>({sampleId,reason,detail})),endpointOffsets:{start:meters(candidate.coords[0],baseline.coords[0]),end:meters(candidate.coords.at(-1),baseline.coords.at(-1))},candidate});
 }catch(error){report.attempts.push({index:index+1,via,outcome:'request-error',message:error.message});}
}
await mkdir(output,{recursive:true});await writeFile(output+'/detour-replay.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({existingWesternAlternatives:report.existingCrossingAlternatives,attempts:report.attempts.map(({index,distance,originalPolicyOutcome,currentValidation,duplicatesRoute,touches,outcome,message})=>({index,distance,originalPolicyOutcome,currentValidation,duplicatesRoute,touches,outcome,message})),report:output+'/detour-replay.json'}));
