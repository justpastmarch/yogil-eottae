import {z} from 'zod';
import type {Coord} from './domain.ts';

const terrainSource = z.object({dataset:z.literal('srtm30m'),resolutionMeters:z.literal(30)});
export const terrainProfileSchema = z.discriminatedUnion('status', [
    terrainSource.extend({status:z.literal('available'),points:z.array(z.object({coord:z.tuple([z.number(),z.number()]),elevationMeters:z.number().nullable()}))}),
    terrainSource.extend({status:z.literal('unavailable'),reason:z.enum(['transport','no-data','invalid-response'])}),
]);
export type TerrainProfile = z.infer<typeof terrainProfileSchema>;
const responseSchema = z.object({status:z.literal('OK'),results:z.array(z.object({dataset:z.literal('srtm30m'),elevation:z.number().finite().nullable(),location:z.object({lat:z.number().finite(),lng:z.number().finite()})}))});

export async function fetchTerrain(coords:Coord[],signal:AbortSignal):Promise<TerrainProfile> {
    const source = {dataset:'srtm30m',resolutionMeters:30} as const;
    if(!coords.length)return {...source,status:'unavailable',reason:'no-data'};
    const points:Extract<TerrainProfile,{status:'available'}>['points']=[];
    try {
        for(let offset=0;offset<coords.length;offset+=100){
            signal.throwIfAborted();
            const batch=coords.slice(offset,offset+100);
            const locations=batch.map(([lng,lat])=>`${lat},${lng}`).join('|');
            const response=await fetch('https://api.opentopodata.org/v1/srtm30m?'+new URLSearchParams({locations}),{redirect:'manual',cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
            if(!response.ok){console.warn(JSON.stringify({event:'terrain_transport_failed',status:response.status}));return {...source,status:'unavailable',reason:'transport'};}
            const parsed=responseSchema.safeParse(await response.json());
            if(!parsed.success||parsed.data.results.length!==batch.length)return {...source,status:'unavailable',reason:'invalid-response'};
            for(let index=0;index<batch.length;index++){
                const result=parsed.data.results[index],coord=batch[index];
                if(Math.abs(result.location.lng-coord[0])>0.00001||Math.abs(result.location.lat-coord[1])>0.00001)return {...source,status:'unavailable',reason:'invalid-response'};
                points.push({coord,elevationMeters:result.elevation});
            }
            if(offset+100<coords.length){
                const pause=Promise.withResolvers<void>();
                setTimeout(pause.resolve,1000);
                await pause.promise;
            }
        }
        return points.some(point=>point.elevationMeters!==null)?{...source,status:'available',points}:{...source,status:'unavailable',reason:'no-data'};
    } catch(error) {
        console.warn(JSON.stringify({event:'terrain_transport_failed',reason:error instanceof Error?error.name:'unknown'}));
        signal.throwIfAborted();
        return {...source,status:'unavailable',reason:'transport'};
    }
}
