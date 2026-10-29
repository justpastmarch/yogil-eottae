import {z} from 'zod';
import {meters,type Coord,type Route} from './domain.ts';
import {fetchTerrain} from './elevation.ts';

const sourceSchema=z.object({dataset:z.literal('srtm30m'),resolutionMeters:z.literal(30),retrievedAt:z.string().datetime(),baselineMeters:z.literal(60)});
const segmentSchema=z.object({fromAlong:z.number().finite().nonnegative(),toAlong:z.number().finite().nonnegative(),coords:z.array(z.tuple([z.number().finite(),z.number().finite()])).min(2),gradePercent:z.number().finite()}).refine(segment=>segment.toAlong-segment.fromAlong>=60-1e-6,'A terrain grade requires at least a 60 m path baseline');
const measuredSchema=sourceSchema.extend({maxAbsPercent:z.number().finite().nonnegative(),ascentMeters:z.number().finite().nonnegative(),descentMeters:z.number().finite().nonnegative(),coverageFraction:z.number().min(0).max(1),segments:z.array(segmentSchema).min(1)});
export const routeGradeSchema=z.discriminatedUnion('status',[
    measuredSchema.extend({status:z.literal('available'),coverageFraction:z.literal(1)}),
    measuredSchema.extend({status:z.literal('partial'),coverageFraction:z.number().positive().lt(1)}),
    sourceSchema.extend({status:z.literal('unavailable'),retrievedAt:z.string().datetime().nullable(),reason:z.enum(['transport','no-data','invalid-response','insufficient-span']),coverageFraction:z.literal(0),segments:z.tuple([])}),
]);
export type RouteGrade=z.infer<typeof routeGradeSchema>;
type Segment=z.infer<typeof segmentSchema>;
type Position={coord:Coord;along:number};
type RouteSamples={route:Route;vertices:Position[];points:Position[];length:number;reversed:boolean};
type Height={elevationMeters:number|null;retrievedAt:string;expiresAt:number};
const heightCache=new Map<string,Height>();
const CACHE_TTL_MS=60*60*1000;
const CACHE_MAX_POINTS=10000;
const coordinateKey=([lng,lat]:Coord)=>`${lng.toFixed(7)},${lat.toFixed(7)}`;

function sampleRoute(route:Route):RouteSamples{
    let reversed=false;
    for(let index=0;index<route.coords.length;index++){
        const a=route.coords[index],b=route.coords[route.coords.length-index-1];
        if(a[0]!==b[0]||a[1]!==b[1]){reversed=a[0]>b[0]||a[0]===b[0]&&a[1]>b[1];break;}
    }
    const coords=reversed?[...route.coords].reverse():route.coords;
    let length=0;
    const vertices:Position[]=coords.map((coord,index)=>{
        if(index)length+=meters(coords[index-1],coord);
        return {coord,along:length};
    });
    if(length<60-1e-6)return {route,vertices,points:[],length,reversed};
    // Equal spacing is at most one raster cell; reverse routes share the same samples.
    const intervals=Math.ceil(length/30-1e-9);
    const points:Position[]=[];
    let vertex=1;
    for(let index=0;index<=intervals;index++){
        const along=index*length/intervals;
        while(vertex<vertices.length-1&&vertices[vertex].along<along)vertex++;
        const from=vertices[vertex-1],to=vertices[vertex];
        const span=to.along-from.along;
        const fraction=span?(along-from.along)/span:0;
        const coord:Coord=index===intervals?to.coord:[from.coord[0]+(to.coord[0]-from.coord[0])*fraction,from.coord[1]+(to.coord[1]-from.coord[1])*fraction];
        points.push({coord,along});
    }
    return {route,vertices,points,length,reversed};
}

function gradeRoute(sampled:RouteSamples,heights:Map<string,Height>,fallbackRetrievedAt:string|null,failure?:'transport'|'no-data'|'invalid-response'):RouteGrade{
    const {points,vertices,length}=sampled;
    const dates=points.flatMap(point=>{
        const height=heights.get(coordinateKey(point.coord));
        return height?[height.retrievedAt]:[];
    });
    // Mixed-age cached profiles disclose the oldest retrieval, not a fabricated fresh date.
    const retrievedAt=dates.reduce<string|null>((oldest,date)=>oldest===null||date<oldest?date:oldest,points.length?fallbackRetrievedAt:null);
    const source={dataset:'srtm30m',resolutionMeters:30,retrievedAt,baselineMeters:60} satisfies Pick<RouteGrade,'dataset'|'resolutionMeters'|'retrievedAt'|'baselineMeters'>;
    const unavailable=(reason:'transport'|'no-data'|'invalid-response'|'insufficient-span'):RouteGrade=>({...source,status:'unavailable',reason,coverageFraction:0,segments:[]});
    if(length<60-1e-6)return unavailable('insufficient-span');
    const segments:Segment[]=[];
    let ascentMeters=0,descentMeters=0;
    let runStart=0;
    while(runStart<points.length){
        while(runStart<points.length&&heights.get(coordinateKey(points[runStart].coord))?.elevationMeters==null)runStart++;
        let runEnd=runStart;
        while(runEnd+1<points.length&&heights.get(coordinateKey(points[runEnd+1].coord))?.elevationMeters!=null)runEnd++;
        let start=runStart;
        while(start<runEnd){
            let end=start+1;
            while(end<=runEnd&&points[end].along-points[start].along<60-1e-6)end++;
            if(end>runEnd)break;
            // Fold a sub-baseline tail into the final valid segment; never bridge a null.
            if(points[runEnd].along-points[end].along<60-1e-6)end=runEnd;
            const from=points[start],to=points[end];
            const fromHeight=heights.get(coordinateKey(from.coord))?.elevationMeters;
            const toHeight=heights.get(coordinateKey(to.coord))?.elevationMeters;
            if(fromHeight!=null&&toHeight!=null){
                const rise=toHeight-fromHeight;
                const coords:Coord[]=[from.coord,...vertices.filter(vertex=>vertex.along>from.along&&vertex.along<to.along).map(vertex=>vertex.coord),to.coord];
                segments.push({fromAlong:from.along,toAlong:to.along,coords,gradePercent:100*rise/(to.along-from.along)});
                for(let index=start+1;index<=end;index++){
                    const previous=heights.get(coordinateKey(points[index-1].coord))?.elevationMeters;
                    const current=heights.get(coordinateKey(points[index].coord))?.elevationMeters;
                    if(previous!=null&&current!=null){
                        ascentMeters+=Math.max(0,current-previous);
                        descentMeters+=Math.max(0,previous-current);
                    }
                }
            }
            start=end;
        }
        runStart=runEnd+1;
    }
    if(!segments.length||retrievedAt===null){
        const hasHeight=points.some(point=>heights.get(coordinateKey(point.coord))?.elevationMeters!=null);
        return unavailable(failure??(hasHeight?'insufficient-span':'no-data'));
    }
    const covered=segments.reduce((sum,segment)=>sum+segment.toAlong-segment.fromAlong,0);
    const coverageFraction=Math.min(1,covered/length);
    const travelSegments=sampled.reversed?segments.map(segment=>({fromAlong:length-segment.toAlong,toAlong:length-segment.fromAlong,coords:[...segment.coords].reverse(),gradePercent:-segment.gradePercent})).reverse():segments;
    const summary={...source,retrievedAt,maxAbsPercent:segments.reduce((maximum,segment)=>Math.max(maximum,Math.abs(segment.gradePercent)),0),ascentMeters:sampled.reversed?descentMeters:ascentMeters,descentMeters:sampled.reversed?ascentMeters:descentMeters,segments:travelSegments};
    if(Math.abs(length-covered)<1e-6)return {...summary,status:'available',coverageFraction:1};
    return {...summary,status:'partial',coverageFraction};
}

/** SRTM terrain estimates along every candidate's geometry, not measured sidewalk slope or passability. */
export async function loadRouteGrades(routes:Route[],signal:AbortSignal):Promise<Record<string,RouteGrade>>{
    signal.throwIfAborted();
    const sampled=routes.map(sampleRoute);
    const now=Date.now();
    const heights=new Map<string,Height>();
    const missing=new Map<string,Coord>();
    for(const route of sampled)for(const point of route.points){
        const key=coordinateKey(point.coord),cached=heightCache.get(key);
        if(cached&&cached.expiresAt>now)heights.set(key,cached);
        else missing.set(key,point.coord);
    }
    let retrievedAt:string|null=null;
    let failure:'transport'|'no-data'|'invalid-response'|undefined;
    if(missing.size){
        // fetchTerrain limits requests to 100 locations and spaces successive batches.
        const terrain=await fetchTerrain([...missing.values()],signal);
        retrievedAt=new Date().toISOString();
        if(terrain.status==='available'||terrain.reason==='no-data'){
            const points=terrain.status==='available'?terrain.points:[...missing.values()].map(coord=>({coord,elevationMeters:null}));
            for(const point of points){
                const key=coordinateKey(point.coord);
                const height={elevationMeters:point.elevationMeters,retrievedAt,expiresAt:Date.now()+CACHE_TTL_MS};
                heights.set(key,height);
                heightCache.delete(key);
                heightCache.set(key,height);
                if(heightCache.size>CACHE_MAX_POINTS){
                    const oldest=heightCache.keys().next();
                    if(!oldest.done)heightCache.delete(oldest.value);
                }
            }
            if(terrain.status==='unavailable')failure=terrain.reason;
        }else failure=terrain.reason;
    }
    signal.throwIfAborted();
    return Object.fromEntries(sampled.map(route=>[route.route.id,gradeRoute(route,heights,retrievedAt,failure)]));
}

export function orderByRoutePreference(routes:Route[],preference:'gentle'|'fast'):Route[]{
    return [...routes].sort((a,b)=>{
        if(preference==='fast')return a.seconds-b.seconds;
        const aGrade=a.grade,bGrade=b.grade;
        // Incomplete terrain coverage cannot earn a falsely gentle ranking.
        if(aGrade?.status==='available'&&bGrade?.status==='available')return aGrade.maxAbsPercent-bGrade.maxAbsPercent||aGrade.ascentMeters-bGrade.ascentMeters||a.seconds-b.seconds;
        if(aGrade?.status==='available')return -1;
        if(bGrade?.status==='available')return 1;
        return a.seconds-b.seconds;
    });
}
