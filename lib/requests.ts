import {z} from 'zod';
import {findingSchema,observationSchema,evidenceSourceSchema,routeDecisionSchema,journeyGoal,placeSchema} from './domain.ts';
import {terrainProfileSchema} from './elevation.ts';
import {capturePreviewSchema} from './capture-contract.ts';
const coord=z.tuple([z.number().min(124).max(132),z.number().min(33).max(40)]);
export const requestSchema=z.discriminatedUnion('action',[
    z.object({action:z.literal('search'),query:z.string().min(2).max(150),address:z.boolean().optional()}).strict(),
    z.object({action:z.literal('journey'),start:placeSchema,end:placeSchema,profile:z.enum(['수동 휠체어','전동 휠체어','유아차','보행 보조기']),goal:journeyGoal,maxSlope:z.number().min(1).max(50).optional(),imageryProvider:z.enum(['configured','kartaview']).optional()}).strict(),
    z.object({action:z.literal('advance'),jobId:z.string().uuid()}).strict(),
    z.object({action:z.literal('cancel'),jobId:z.string().uuid()}).strict(),
    z.object({action:z.literal('status'),jobId:z.string().uuid()}).strict(),
]);
const sample=z.object({id:z.string(),coord,heading:z.number(),along:z.number(),critical:z.boolean(),target:observationSchema.shape.target.optional()});
const barrier=z.object({sampleId:z.string(),coord,along:z.number(),reason:z.string(),source:z.enum(['provider','imagery']).optional()});
const route=z.object({id:z.string(),name:z.string(),options:z.array(z.string()),coords:z.array(coord),distance:z.number(),seconds:z.number(),steps:z.array(z.object({text:z.string(),coord})),samples:z.array(sample),fetchedAt:z.string(),detourReason:z.string().optional(),barriers:z.array(barrier).optional(),unresolvedCrossings:z.array(z.object({id:z.string(),coord,along:z.number(),count:z.number().int().positive(),source:z.literal('osm').optional()})).optional(),unverifiedConnections:z.array(z.object({id:z.string(),kind:z.enum(['station','underpass','elevator','origin','destination']),coord,along:z.number().nonnegative(),reason:z.string()})).optional(),crossingSources:z.array(z.object({provider:z.literal('openstreetmap'),snapshotAt:z.string().datetime(),wayIds:z.array(z.number().int().positive()).min(1),along:z.number().nonnegative()})).optional(),graphCoverage:z.object({status:z.enum(['available','unavailable']),reason:z.enum(['not-configured','network','incomplete','too-large','no-data']).optional(),snapshotAt:z.string().datetime().optional()}).optional(),graphSegment:z.object({provider:z.literal('openstreetmap'),snapshotAt:z.string().datetime(),startGapMeters:z.number().nonnegative(),endGapMeters:z.number().nonnegative(),sharedRoadMeters:z.number().nonnegative()}).optional(),terrain:terrainProfileSchema.optional()});
const evidence=z.object({
 stage:z.enum(['reserved','processed']).optional(),sampleId:z.string(),status:findingSchema.shape.status,reason:z.string(),finding:findingSchema.optional(),source:evidenceSourceSchema.optional(),failure:z.enum(['capture','analysis','service','missing']).optional(),
 review:z.object({state:z.enum(['pending','reserved','complete']),failure:z.enum(['capture','analysis','service']).optional(),reason:z.enum(['framing','occlusion','corridor-uncertain']),initialFinding:findingSchema,initialSource:evidenceSourceSchema,sources:z.array(z.object({id:z.string(),source:evidenceSourceSchema})),result:findingSchema.optional(),supportIds:z.array(z.string()),note:z.string()}).optional(),
 checkedAt:z.string(),
});
export const journeyResponse=z.object({goal:journeyGoal,routes:z.array(route),evidence:z.record(evidence),assessments:z.record(z.object({blockedPassageIds:z.array(z.string()),decision:routeDecisionSchema})),recommendedId:z.string().nullable(),status:z.enum(['ready','limited']),maxSlope:z.number().nullable().optional()});
export const searchResponse=z.object({places:z.array(placeSchema)});
export const journeySnapshotResponse=z.object({jobId:z.string().uuid(),phase:z.enum(['running','ready','limited','failed','canceled']),journey:journeyResponse,captures:z.array(capturePreviewSchema),progress:z.object({checked:z.number().int().min(0),total:z.number().int().min(0),analyses:z.number().int().min(0),notice:z.string().optional()})});
export type JourneySnapshotResponse=z.infer<typeof journeySnapshotResponse>;
